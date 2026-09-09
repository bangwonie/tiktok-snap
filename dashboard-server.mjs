import { createServer } from 'node:http';
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicRoot = path.join(root, 'dashboard');
const archiveRoot = path.join(root, 'archive');
const passwordFile = path.join(root, '.dashboard-password');
const passkeyFile = path.join(root, '.dashboard-passkeys.json');
const host = process.env.DASHBOARD_HOST || '127.0.0.1';
const port = Number(process.env.DASHBOARD_PORT || 4313);
const username = process.env.DASHBOARD_USERNAME || 'admin';
const sessionTtl = 12 * 60 * 60 * 1000;
const sessions = new Map();
const loginAttempts = new Map();
const ceremonies = new Map();
const eventClients = new Set();
const logs = [];
let crawlerProcess;
let crawlerStartedAt;
let crawlerExit = null;
let checkProcess;
let checkStartedAt;
let lastCheck;
let processCache = { at: 0, rows: [] };

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('DASHBOARD_PORT must be a valid port');

async function loadPassword() {
  if (process.env.DASHBOARD_PASSWORD) return { password: process.env.DASHBOARD_PASSWORD, generated: false };
  try {
    const password = (await readFile(passwordFile, 'utf8')).trim();
    if (!password) throw new Error(`${passwordFile} is empty`);
    return { password, generated: false };
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const password = randomBytes(12).toString('base64url');
  await writeFile(passwordFile, password, { flag: 'wx', mode: 0o600 });
  return { password, generated: true };
}

const credentials = await loadPassword();

async function loadPasskeys() {
  try {
    const value = JSON.parse(await readFile(passkeyFile, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

let passkeys = await loadPasskeys();

async function savePasskeys() {
  const temporary = `${passkeyFile}.tmp`;
  await writeFile(temporary, JSON.stringify(passkeys, null, 2), { mode: 0o600 });
  await rename(temporary, passkeyFile);
}

const toBase64Url = value => Buffer.from(value).toString('base64url');
const fromBase64Url = value => Buffer.from(String(value || ''), 'base64url');

function sessionToken(request) { return parseCookies(request).dashboard_session; }

function ceremonyContext(request) {
  const origin = request.headers.origin || `http://${request.headers.host}`;
  const parsed = new URL(origin);
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== '::1') {
    throw Object.assign(new Error('Passkeys are limited to this local dashboard.'), { status: 400 });
  }
  return { origin: parsed.origin, rpId: parsed.hostname };
}

function beginCeremony(type, request, extra = {}) {
  const id = randomBytes(18).toString('base64url');
  const challenge = randomBytes(32).toString('base64url');
  ceremonies.set(id, { type, challenge, createdAt: Date.now(), ...ceremonyContext(request), ...extra });
  return { id, challenge };
}

function takeCeremony(id, type) {
  const ceremony = ceremonies.get(String(id || ''));
  ceremonies.delete(String(id || ''));
  if (!ceremony || ceremony.type !== type || Date.now() - ceremony.createdAt > 5 * 60_000) {
    throw Object.assign(new Error('This passkey request has expired. Please try again.'), { status: 400 });
  }
  return ceremony;
}

function validateClientData(encoded, ceremony, type) {
  let data;
  try { data = JSON.parse(fromBase64Url(encoded).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid passkey client data.'), { status: 400 }); }
  if (data.type !== type || data.challenge !== ceremony.challenge || data.origin !== ceremony.origin) {
    throw Object.assign(new Error('Passkey challenge or origin did not match.'), { status: 400 });
  }
  return fromBase64Url(encoded);
}

function validateAuthenticator(encoded, ceremony) {
  const data = fromBase64Url(encoded);
  if (data.length < 37) throw Object.assign(new Error('Invalid authenticator data.'), { status: 400 });
  const expectedRpId = createHash('sha256').update(ceremony.rpId).digest();
  if (!timingSafeEqual(data.subarray(0, 32), expectedRpId) || !(data[32] & 0x01) || !(data[32] & 0x04)) {
    throw Object.assign(new Error('Passkey authenticator validation failed.'), { status: 400 });
  }
  return { data, counter: data.readUInt32BE(33) };
}

function createSession(response) {
  const token = randomBytes(32).toString('base64url');
  sessions.set(token, { expiresAt: Date.now() + sessionTtl });
  return { 'Set-Cookie': `dashboard_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionTtl / 1000}` };
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function securityHeaders(extra = {}) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...extra,
  };
}

function sendJson(response, status, data, extra = {}) {
  response.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', ...extra }));
  response.end(JSON.stringify(data));
}

function parseCookies(request) {
  return Object.fromEntries(String(request.headers.cookie || '').split(';').map(part => part.trim()).filter(Boolean).map(part => {
    const at = part.indexOf('=');
    return at < 0 ? [part, ''] : [part.slice(0, at), decodeURIComponent(part.slice(at + 1))];
  }));
}

function authenticated(request) {
  const token = parseCookies(request).dashboard_session;
  const session = token && sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return false;
  }
  session.expiresAt = Date.now() + sessionTtl;
  return true;
}

function sameOrigin(request) {
  const origin = request.headers.origin;
  return !origin || origin === `http://${request.headers.host}` || origin === `https://${request.headers.host}`;
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 64 * 1024) throw Object.assign(new Error('Request too large'), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

function addLog(source, message, level = 'info') {
  for (const raw of String(message).split(/\r?\n/)) {
    const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
    if (!text) continue;
    const entry = { id: `${Date.now()}-${randomBytes(3).toString('hex')}`, at: new Date().toISOString(), source, level, text };
    logs.push(entry);
    if (logs.length > 1000) logs.shift();
    const packet = `event: log\ndata: ${JSON.stringify(entry)}\n\n`;
    for (const client of eventClients) client.write(packet);
  }
}

function attachLogs(child, source) {
  child.stdout?.on('data', chunk => addLog(source, chunk));
  child.stderr?.on('data', chunk => addLog(source, chunk, 'error'));
}

function run(command, args, options = {}) {
  return spawn(command, args, { cwd: root, windowsHide: true, shell: false, ...options });
}

async function archiveSummary() {
  const result = {
    channels: 0,
    videoFolders: 0,
    videos: 0,
    bytes: 0,
    queue: { pending: 0, done: 0, failed: 0, retry: 0, excluded: 0 },
    queueFiles: 0,
    errors: 0,
    sources: [],
  };
  let channelEntries = [];
  try { channelEntries = await readdir(archiveRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  for (const channel of channelEntries) {
    if (!channel.isDirectory()) continue;
    if (!channel.name.startsWith('@')) continue;
    result.channels++;
    const channelPath = path.join(archiveRoot, channel.name);
    for (const entry of await readdir(channelPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      result.videoFolders++;
      const video = path.join(channelPath, entry.name, 'video-original.mp4');
      try {
        const info = await stat(video);
        if (info.isFile()) { result.videos++; result.bytes += info.size; }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const queueDir = path.join(archiveRoot, 'queues');
  let queueFiles = [];
  try { queueFiles = (await readdir(queueDir, { withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith('.json')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  result.queueFiles = queueFiles.length;
  for (const entry of queueFiles) {
    try {
      const data = JSON.parse(await readFile(path.join(queueDir, entry.name), 'utf8'));
      for (const job of Object.values(data.jobs || {})) {
        if (job?.status in result.queue) result.queue[job.status]++;
      }
      for (const [name, source] of Object.entries(data.sources || {})) {
        result.sources.push({ queue: `${data.region || 'GLOBAL'}/#${data.tag || '?'}`, name,
          status: source.status || 'unknown', cursor: source.cursor ?? null, updatedAt: source.updatedAt ?? null });
      }
    } catch (error) { result.errors++; addLog('dashboard', `Could not read queue ${entry.name}: ${error.message}`, 'error'); }
  }
  result.sources.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return result;
}

function capture(command, args) {
  return new Promise(resolve => {
    const child = run(command, args);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(output));
  });
}

async function crawlerProcesses() {
  if (Date.now() - processCache.at < 5000) return processCache.rows;
  if (process.platform !== 'win32') {
    const rows = crawlerProcess && crawlerProcess.exitCode == null ? [{ pid: crawlerProcess.pid, script: 'watch.mjs' }] : [];
    processCache = { at: Date.now(), rows };
    return rows;
  }
  const script = "$rows=Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -match '(watch|collector|discover)\\.mjs' } | Select-Object ProcessId,ParentProcessId,CommandLine; $rows | ConvertTo-Json -Compress";
  const output = await capture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  try {
    const parsed = output.trim() ? JSON.parse(output) : [];
    processCache = { at: Date.now(), rows: (Array.isArray(parsed) ? parsed : [parsed]).map(row => ({
      pid: row.ProcessId, parentPid: row.ParentProcessId,
      script: String(row.CommandLine || '').match(/(watch|collector|discover)\.mjs/i)?.[1] || 'node',
    })) };
    return processCache.rows;
  } catch {
    processCache = { at: Date.now(), rows: [] };
    return processCache.rows;
  }
}

async function statusPayload() {
  const [archive, processes] = await Promise.all([archiveSummary(), crawlerProcesses()]);
  const running = processes.length > 0 || Boolean(crawlerProcess && crawlerProcess.exitCode == null);
  return {
    crawler: {
      state: running ? 'running' : 'stopped',
      managedPid: crawlerProcess && crawlerProcess.exitCode == null ? crawlerProcess.pid : null,
      stoppable: running,
      startedAt: crawlerStartedAt || null,
      lastExit: crawlerExit,
      processes,
    },
    archive,
    check: { running: Boolean(checkProcess && checkProcess.exitCode == null), startedAt: checkStartedAt || null, last: lastCheck || null },
    serverTime: new Date().toISOString(),
  };
}

async function startCrawler() {
  if ((crawlerProcess && crawlerProcess.exitCode == null) || (await crawlerProcesses()).length) return false;
  crawlerExit = null;
  crawlerStartedAt = new Date().toISOString();
  const child = run(process.execPath, ['watch.mjs'], { stdio: ['ignore', 'pipe', 'pipe'] });
  crawlerProcess = child;
  processCache.at = 0;
  addLog('system', `Crawler started (PID ${child.pid}).`);
  attachLogs(child, 'crawler');
  child.on('error', error => addLog('system', `Crawler failed to start: ${error.message}`, 'error'));
  child.on('exit', (code, signal) => {
    crawlerExit = { code, signal, at: new Date().toISOString() };
    crawlerProcess = undefined;
    processCache.at = 0;
    addLog('system', `Crawler stopped (code ${code ?? '-'}, signal ${signal ?? '-'}).`, code ? 'error' : 'info');
  });
  return true;
}

async function terminateProcessTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
      child.on('error', () => resolve());
      child.on('close', resolve);
    });
  } else crawlerProcess?.kill('SIGTERM');
}

async function stopCrawler() {
  const processes = await crawlerProcesses();
  const managedPid = crawlerProcess && crawlerProcess.exitCode == null ? crawlerProcess.pid : null;
  const knownPids = new Set(processes.map(item => item.pid));
  const roots = processes.filter(item => !knownPids.has(item.parentPid));
  const targets = managedPid ? [managedPid] : (roots.length ? roots : processes).map(item => item.pid);
  if (!targets.length) return false;
  addLog('system', `Stopping crawler process tree ${targets.join(', ')}...`);
  for (const pid of targets) await terminateProcessTree(pid);
  processCache.at = 0;
  return true;
}

function runStep(label, args) {
  return new Promise(resolve => {
    const windows = process.platform === 'win32';
    const executable = windows ? (process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe') : 'npm';
    const commandArgs = windows ? ['/d', '/s', '/c', `npm.cmd ${args.join(' ')}`] : args;
    let child;
    try { child = run(executable, commandArgs, { stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { addLog('check', error.message, 'error'); resolve(1); return; }
    checkProcess = child;
    addLog('check', `> npm ${args.join(' ')}`);
    attachLogs(child, 'check');
    let settled = false;
    const finish = code => { if (!settled) { settled = true; resolve(code); } };
    child.on('error', error => { addLog('check', error.message, 'error'); finish(1); });
    child.on('close', code => { addLog('check', `${label}: ${code === 0 ? 'PASS' : `FAIL (${code})`}`, code ? 'error' : 'info'); finish(code ?? 1); });
  });
}

async function startCheck() {
  if (checkProcess && checkProcess.exitCode == null) return false;
  checkStartedAt = new Date().toISOString();
  lastCheck = null;
  void (async () => {
    const syntax = await runStep('Syntax', ['run', 'check']);
    const tests = syntax === 0 ? await runStep('Tests', ['test']) : null;
    lastCheck = { ok: syntax === 0 && tests === 0, syntax, tests, finishedAt: new Date().toISOString() };
  })().catch(error => {
    addLog('check', error.stack || error.message, 'error');
    lastCheck = { ok: false, syntax: null, tests: null, finishedAt: new Date().toISOString() };
  }).finally(() => {
    checkProcess = undefined;
  });
  return true;
}

async function serveStatic(pathname, response) {
  const files = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
    '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  };
  const item = files[pathname];
  if (!item) return false;
  try {
    const body = await readFile(path.join(publicRoot, item[0]));
    response.writeHead(200, securityHeaders({ 'Content-Type': item[1], 'Cache-Control': 'no-cache' }));
    response.end(body);
  } catch (error) { sendJson(response, 500, { error: error.message }); }
  return true;
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
    if (request.method === 'GET' && await serveStatic(url.pathname, response)) return;
    if (url.pathname === '/api/session' && request.method === 'GET') {
      sendJson(response, 200, { authenticated: authenticated(request), username, passkeyCount: passkeys.length });
      return;
    }
    if (url.pathname === '/api/login' && request.method === 'POST') {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Invalid origin.' });
      const ip = request.socket.remoteAddress || 'local';
      const attempt = loginAttempts.get(ip) || { count: 0, resetAt: Date.now() + 60_000 };
      if (attempt.resetAt <= Date.now()) { attempt.count = 0; attempt.resetAt = Date.now() + 60_000; }
      if (attempt.count >= 8) return sendJson(response, 429, { error: 'Try again in one minute.' });
      const body = await readBody(request);
      if (!safeEqual(body.username, username) || !safeEqual(body.password, credentials.password)) {
        attempt.count++;
        loginAttempts.set(ip, attempt);
        return sendJson(response, 401, { error: 'Incorrect username or password.' });
      }
      loginAttempts.delete(ip);
      sendJson(response, 200, { ok: true, passkeyCount: passkeys.length }, createSession(response));
      return;
    }
    if (url.pathname === '/api/passkey/login/options' && request.method === 'POST') {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Invalid origin.' });
      if (!passkeys.length) return sendJson(response, 404, { error: 'No passkey has been created yet.' });
      const ceremony = beginCeremony('login', request);
      sendJson(response, 200, {
        ceremonyId: ceremony.id,
        publicKey: {
          challenge: ceremony.challenge,
          rpId: ceremonyContext(request).rpId,
          timeout: 60_000,
          userVerification: 'required',
          allowCredentials: passkeys.map(item => ({ type: 'public-key', id: item.id, transports: item.transports || [] })),
        },
      });
      return;
    }
    if (url.pathname === '/api/passkey/login/verify' && request.method === 'POST') {
      if (!sameOrigin(request)) return sendJson(response, 403, { error: 'Invalid origin.' });
      const body = await readBody(request);
      const ceremony = takeCeremony(body.ceremonyId, 'login');
      const credential = passkeys.find(item => safeEqual(item.id, body.credential?.rawId));
      if (!credential) return sendJson(response, 401, { error: 'Unknown passkey.' });
      const clientData = validateClientData(body.credential.response.clientDataJSON, ceremony, 'webauthn.get');
      const authenticator = validateAuthenticator(body.credential.response.authenticatorData, ceremony);
      const signed = Buffer.concat([authenticator.data, createHash('sha256').update(clientData).digest()]);
      const publicKey = createPublicKey({ key: fromBase64Url(credential.publicKey), format: 'der', type: 'spki' });
      if (!verify('sha256', signed, publicKey, fromBase64Url(body.credential.response.signature))) {
        return sendJson(response, 401, { error: 'Passkey signature was rejected.' });
      }
      if (credential.counter && authenticator.counter && authenticator.counter <= credential.counter) {
        return sendJson(response, 401, { error: 'Passkey counter validation failed.' });
      }
      credential.counter = authenticator.counter;
      credential.lastUsedAt = new Date().toISOString();
      await savePasskeys();
      sendJson(response, 200, { ok: true }, createSession(response));
      return;
    }
    if (!authenticated(request)) return sendJson(response, 401, { error: 'Authentication required.' });
    if (request.method === 'POST' && !sameOrigin(request)) return sendJson(response, 403, { error: 'Invalid origin.' });
    if (url.pathname === '/api/passkeys' && request.method === 'GET') {
      return sendJson(response, 200, { passkeys: passkeys.map(({ id, name, createdAt, lastUsedAt }) => ({ id, name, createdAt, lastUsedAt })) });
    }
    if (url.pathname === '/api/passkey/register/options' && request.method === 'POST') {
      const ceremony = beginCeremony('register', request, { session: sessionToken(request) });
      return sendJson(response, 200, {
        ceremonyId: ceremony.id,
        publicKey: {
          challenge: ceremony.challenge,
          rp: { id: ceremonyContext(request).rpId, name: 'TikTok Snap Control' },
          user: { id: toBase64Url(createHash('sha256').update(username).digest()), name: username, displayName: 'TikTok Snap Admin' },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
          timeout: 60_000,
          attestation: 'none',
          authenticatorSelection: { residentKey: 'preferred', requireResidentKey: false, userVerification: 'required' },
          excludeCredentials: passkeys.map(item => ({ type: 'public-key', id: item.id, transports: item.transports || [] })),
        },
      });
    }
    if (url.pathname === '/api/passkey/register/verify' && request.method === 'POST') {
      const body = await readBody(request);
      const ceremony = takeCeremony(body.ceremonyId, 'register');
      if (!safeEqual(ceremony.session, sessionToken(request))) return sendJson(response, 401, { error: 'Registration session changed.' });
      const rawId = String(body.credential?.rawId || '');
      if (!rawId || passkeys.some(item => safeEqual(item.id, rawId))) return sendJson(response, 409, { error: 'This passkey is already registered.' });
      validateClientData(body.credential.response.clientDataJSON, ceremony, 'webauthn.create');
      const authenticator = validateAuthenticator(body.credential.response.authenticatorData, ceremony);
      const publicKeyBytes = fromBase64Url(body.credential.response.publicKey);
      const algorithm = Number(body.credential.response.publicKeyAlgorithm);
      if (![-7, -257].includes(algorithm)) return sendJson(response, 400, { error: 'Unsupported passkey algorithm.' });
      createPublicKey({ key: publicKeyBytes, format: 'der', type: 'spki' });
      passkeys.push({
        id: rawId,
        publicKey: toBase64Url(publicKeyBytes),
        algorithm,
        counter: authenticator.counter,
        transports: Array.isArray(body.credential.response.transports) ? body.credential.response.transports : [],
        name: String(body.name || 'Windows passkey').trim().slice(0, 80) || 'Windows passkey',
        createdAt: new Date().toISOString(),
      });
      await savePasskeys();
      addLog('security', `Passkey registered: ${passkeys.at(-1).name}`);
      return sendJson(response, 201, { ok: true, passkeyCount: passkeys.length });
    }
    if (url.pathname === '/api/status' && request.method === 'GET') return sendJson(response, 200, await statusPayload());
    if (url.pathname === '/api/logs' && request.method === 'GET') return sendJson(response, 200, { logs });
    if (url.pathname === '/api/crawler/start' && request.method === 'POST') {
      const started = await startCrawler();
      return sendJson(response, started ? 202 : 409, started ? { ok: true } : { error: 'Crawler is already running.' });
    }
    if (url.pathname === '/api/crawler/stop' && request.method === 'POST') {
      const stopped = await stopCrawler();
      return sendJson(response, stopped ? 202 : 409, stopped ? { ok: true } : { error: 'Crawler is already stopped.' });
    }
    if (url.pathname === '/api/check' && request.method === 'POST') {
      const started = await startCheck();
      return sendJson(response, started ? 202 : 409, started ? { ok: true } : { error: 'A system check is already running.' });
    }
    if (url.pathname === '/api/events' && request.method === 'GET') {
      response.writeHead(200, securityHeaders({
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
      }));
      response.write(': connected\n\n');
      eventClients.add(response);
      request.on('close', () => eventClients.delete(response));
      return;
    }
    if (url.pathname === '/api/logout' && request.method === 'POST') {
      const token = parseCookies(request).dashboard_session;
      if (token) sessions.delete(token);
      return sendJson(response, 200, { ok: true }, { 'Set-Cookie': 'dashboard_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    sendJson(response, 404, { error: 'Not found' });
  } catch (error) {
    addLog('dashboard', error.stack || error.message, 'error');
    if (!response.headersSent) sendJson(response, error.status || 500, { error: error.status ? error.message : 'Dashboard error.' });
    else response.end();
  }
});

const keepAlive = setInterval(() => {
  for (const client of eventClients) client.write(': ping\n\n');
  const now = Date.now();
  for (const [token, session] of sessions) if (session.expiresAt <= now) sessions.delete(token);
  for (const [id, ceremony] of ceremonies) if (now - ceremony.createdAt > 5 * 60_000) ceremonies.delete(id);
}, 20_000);

server.listen(port, host, () => {
  console.log(`TikTok Snap Dashboard: http://localhost:${port}`);
  console.log(`Username: ${username}`);
  if (credentials.generated) console.log(`New password: ${credentials.password}`);
  else if (!process.env.DASHBOARD_PASSWORD) console.log(`Password file: ${passwordFile}`);
});

async function shutdown() {
  clearInterval(keepAlive);
  if (crawlerProcess && crawlerProcess.exitCode == null) await terminateProcessTree(crawlerProcess.pid);
  server.close();
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
