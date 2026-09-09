const $ = selector => document.querySelector(selector);
const loginView = $('#login-view');
const dashboardView = $('#dashboard-view');
const terminal = $('#terminal-output');
const seenLogs = new Set();
let events;
let followTerminal = true;
let refreshTimer;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || `HTTP ${response.status}`), { status: response.status });
  return data;
}

function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', error);
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 3500);
}

function formatNumber(value) { return new Intl.NumberFormat('en-US').format(Number(value || 0)); }
function formatBytes(bytes) {
  if (!bytes) return '0 MB';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power > 2 ? 2 : 1)} ${units[power]}`;
}
function relativeTime(value) {
  if (!value) return '—';
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 60) return formatter.format(seconds, 'second');
  if (abs < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  return formatter.format(Math.round(seconds / 86400), 'day');
}

function decodeBase64Url(value) {
  const base64 = String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(base64), character => character.charCodeAt(0));
}
function encodeBase64Url(value) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function passkeyReady() { return window.isSecureContext && 'PublicKeyCredential' in window && navigator.credentials; }
function requirePasskeyHost() {
  if (location.hostname === '127.0.0.1') {
    throw new Error('Open http://localhost:4313 to create or use passkeys.');
  }
  if (!passkeyReady()) throw new Error('This browser does not support passkeys in the current context.');
}
function decodeCredentialList(items = []) { return items.map(item => ({ ...item, id: decodeBase64Url(item.id) })); }

async function registerPasskey() {
  try {
    requirePasskeyHost();
    const options = await api('/api/passkey/register/options', { method: 'POST' });
    const publicKey = options.publicKey;
    publicKey.challenge = decodeBase64Url(publicKey.challenge);
    publicKey.user.id = decodeBase64Url(publicKey.user.id);
    publicKey.excludeCredentials = decodeCredentialList(publicKey.excludeCredentials);
    const credential = await navigator.credentials.create({ publicKey });
    const response = credential.response;
    if (!response.getPublicKey || !response.getAuthenticatorData) throw new Error('Chrome cannot export this passkey public key.');
    const name = `Windows passkey · ${new Date().toLocaleDateString('en-GB')}`;
    const result = await api('/api/passkey/register/verify', {
      method: 'POST',
      body: JSON.stringify({
        ceremonyId: options.ceremonyId,
        name,
        credential: {
          rawId: encodeBase64Url(credential.rawId),
          response: {
            clientDataJSON: encodeBase64Url(response.clientDataJSON),
            authenticatorData: encodeBase64Url(response.getAuthenticatorData()),
            publicKey: encodeBase64Url(response.getPublicKey()),
            publicKeyAlgorithm: response.getPublicKeyAlgorithm(),
            transports: response.getTransports?.() || [],
          },
        },
      }),
    });
    $('#passkey-register').textContent = `${result.passkeyCount} passkey${result.passkeyCount === 1 ? '' : 's'}`;
    showToast('Passkey created. You can use it on the next sign-in.');
  } catch (error) {
    if (error.name !== 'NotAllowedError') showToast(error.message, true);
  }
}

async function loginWithPasskey() {
  $('#login-error').textContent = '';
  try {
    requirePasskeyHost();
    const options = await api('/api/passkey/login/options', { method: 'POST' });
    const publicKey = options.publicKey;
    publicKey.challenge = decodeBase64Url(publicKey.challenge);
    publicKey.allowCredentials = decodeCredentialList(publicKey.allowCredentials);
    const credential = await navigator.credentials.get({ publicKey });
    const response = credential.response;
    await api('/api/passkey/login/verify', {
      method: 'POST',
      body: JSON.stringify({
        ceremonyId: options.ceremonyId,
        credential: {
          rawId: encodeBase64Url(credential.rawId),
          response: {
            clientDataJSON: encodeBase64Url(response.clientDataJSON),
            authenticatorData: encodeBase64Url(response.authenticatorData),
            signature: encodeBase64Url(response.signature),
            userHandle: response.userHandle ? encodeBase64Url(response.userHandle) : null,
          },
        },
      }),
    });
    await showDashboard('admin');
  } catch (error) {
    if (error.name !== 'NotAllowedError') $('#login-error').textContent = error.message;
  }
}

function setProgress(id, value, total) {
  const bar = $(id);
  bar.max = Math.max(total, 1);
  bar.value = value || 0;
}

function renderSources(sources) {
  $('#source-count').textContent = `${formatNumber(sources.length)} sources`;
  const body = $('#source-rows');
  body.replaceChildren();
  if (!sources.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5; cell.className = 'empty'; cell.textContent = 'No source data yet.';
    row.append(cell); body.append(row); return;
  }
  for (const source of sources.slice(0, 100)) {
    const row = document.createElement('tr');
    for (const value of [source.name, source.queue, source.cursor || '—']) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    const statusCell = document.createElement('td');
    const badge = document.createElement('span'); badge.className = `source-status ${source.status}`; badge.textContent = source.status;
    statusCell.append(badge); row.append(statusCell);
    const updated = document.createElement('td'); updated.textContent = relativeTime(source.updatedAt); row.append(updated);
    body.append(row);
  }
}

function renderStatus(data) {
  const running = data.crawler.state === 'running';
  $('#crawler-indicator').classList.toggle('running', running);
  $('#live-dot').classList.toggle('on', running);
  $('#crawler-label').textContent = running ? 'Super Sweep in progress' : 'Crawler stopped';
  $('#crawler-detail').textContent = running
    ? `Controller PID ${data.crawler.managedPid || 'external'} · started ${relativeTime(data.crawler.startedAt)}`
    : data.crawler.lastExit ? `Last stopped ${relativeTime(data.crawler.lastExit.at)}` : 'Ready to start a clean Super Sweep.';
  $('#start-button').disabled = running;
  $('#stop-button').disabled = !data.crawler.stoppable;
  $('#metric-processes').textContent = formatNumber(data.crawler.processes.length);
  $('#metric-process-detail').textContent = data.crawler.processes.length
    ? data.crawler.processes.map(item => `${item.script} · ${item.pid}`).join(' / ') : 'no active workers';
  $('#metric-videos').textContent = formatNumber(data.archive.videos);
  $('#metric-channels').textContent = formatNumber(data.archive.channels);
  $('#metric-size').textContent = formatBytes(data.archive.bytes);
  $('#metric-folder-detail').textContent = `${formatNumber(data.archive.videoFolders)} video IDs`;
  const queue = { ...data.archive.queue, failed: (data.archive.queue.failed || 0) + (data.archive.queue.retry || 0) };
  delete queue.retry;
  const total = Object.values(queue).reduce((sum, value) => sum + value, 0);
  $('#queue-total').textContent = `${formatNumber(total)} IDs`;
  for (const key of ['done', 'pending', 'failed', 'excluded']) {
    $(`#queue-${key}`).textContent = formatNumber(queue[key]);
    setProgress(`#bar-${key}`, queue[key], total);
  }
  renderSources(data.archive.sources);
  const check = data.check;
  const badge = $('#check-badge');
  badge.className = 'badge ' + (check.running ? 'running' : check.last?.ok ? 'good' : check.last ? 'bad' : 'neutral');
  badge.textContent = check.running ? 'Running' : check.last?.ok ? 'Passed' : check.last ? 'Failed' : 'Not run';
  $('#health-score').textContent = check.running ? '•••' : check.last?.ok ? 'OK' : check.last ? 'ERR' : '—';
  $('#health-title').textContent = check.running ? 'Checking the system' : check.last?.ok ? 'All checks passed' : check.last ? 'A check failed' : 'Ready to verify';
  $('#health-detail').textContent = check.last ? `Finished ${relativeTime(check.last.finishedAt)} · syntax ${check.last.syntax} · tests ${check.last.tests}` : 'Run syntax checks and the complete test suite.';
  $('#check-button').disabled = check.running;
  $('#server-clock').textContent = new Date(data.serverTime).toLocaleTimeString('en-GB');
}

function appendLog(entry) {
  if (!entry?.id || seenLogs.has(entry.id)) return;
  seenLogs.add(entry.id);
  terminal.querySelector('.terminal-placeholder')?.remove();
  const row = document.createElement('div'); row.className = `terminal-line ${entry.level || ''}`;
  const time = document.createElement('time'); time.textContent = new Date(entry.at).toLocaleTimeString('en-GB', { hour12: false });
  const source = document.createElement('b'); source.textContent = entry.source;
  const text = document.createElement('span'); text.textContent = entry.text;
  row.append(time, source, text); terminal.append(row);
  while (terminal.children.length > 800) terminal.firstElementChild.remove();
  if (followTerminal) terminal.scrollTop = terminal.scrollHeight;
}

async function refresh() {
  try { renderStatus(await api('/api/status')); }
  catch (error) { if (error.status === 401) showLogin(); else showToast(error.message, true); }
}

function connectEvents() {
  events?.close();
  events = new EventSource('/api/events');
  events.addEventListener('log', event => appendLog(JSON.parse(event.data)));
  events.onerror = () => { if (events.readyState === EventSource.CLOSED) setTimeout(connectEvents, 3000); };
}

async function updatePasskeyCount() {
  try {
    const data = await api('/api/passkeys');
    $('#passkey-register').textContent = data.passkeys.length
      ? `${data.passkeys.length} passkey${data.passkeys.length === 1 ? '' : 's'}`
      : 'Add passkey';
  } catch {}
}

async function showDashboard(user = 'admin') {
  loginView.classList.add('hidden');
  dashboardView.classList.remove('hidden');
  $('#session-user').textContent = user;
  try { (await api('/api/logs')).logs.forEach(appendLog); } catch {}
  await updatePasskeyCount();
  connectEvents();
  await refresh();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, 3000);
}

function showLogin(passkeyCount = null) {
  events?.close(); clearInterval(refreshTimer);
  dashboardView.classList.add('hidden'); loginView.classList.remove('hidden');
  if (!passkeyReady()) {
    $('#passkey-login').disabled = true;
    $('#passkey-note').textContent = 'Passkeys are unavailable in this browser context.';
  } else if (passkeyCount === 0) {
    $('#passkey-note').textContent = 'Sign in with your password once, then create a passkey.';
  }
  $('#password').focus();
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#username').value, password: $('#password').value }) });
    $('#password').value = '';
    await showDashboard($('#username').value);
  } catch (error) { $('#login-error').textContent = error.message; }
});

async function action(url, success) {
  try { await api(url, { method: 'POST' }); showToast(success); await refresh(); }
  catch (error) { showToast(error.message, true); }
}

$('#passkey-login').addEventListener('click', loginWithPasskey);
$('#passkey-register').addEventListener('click', registerPasskey);
$('#start-button').addEventListener('click', () => action('/api/crawler/start', 'Super Sweep started.'));
$('#stop-button').addEventListener('click', () => action('/api/crawler/stop', 'Stop command sent.'));
$('#check-button').addEventListener('click', () => action('/api/check', 'System check started.'));
$('#logout-button').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }).catch(() => {}); showLogin(); });
$('#clear-terminal').addEventListener('click', () => { terminal.replaceChildren(); seenLogs.clear(); });
$('#follow-terminal').addEventListener('click', event => { followTerminal = !followTerminal; event.currentTarget.classList.toggle('active', followTerminal); });

api('/api/session').then(session => session.authenticated ? showDashboard(session.username) : showLogin(session.passkeyCount)).catch(() => showLogin());
