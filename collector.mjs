import { chromium } from 'playwright';
import { mkdir, writeFile, access, rename, appendFile, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const exact = args.indexOf(key);
  if (exact >= 0) return args[exact + 1] ?? fallback;
  const inline = args.find(value => value.startsWith(`${key}=`));
  return inline ? inline.slice(key.length + 1) : fallback;
};
const tag = option('--tag', 'fyp').replace(/^#/, '');
const region = option('--region', 'GLOBAL').toUpperCase();
const language = option('--lang', 'en');
const limit = Number(option('--limit', '20'));
const autoMode = args.includes('--auto');
const refreshMode = args.includes('--refresh');
if (!tag || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Use --tag fyp --limit 20 (limit: 1–500).');
const archive = path.join(root, 'archive');
await mkdir(archive, { recursive: true });
const exists = async p => access(p).then(() => true, () => false);
const prompt = async message => {
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try { await input.question(message); } finally { input.close(); }
};
const loginMode = args.includes('--login');
const debugPort = Number(option('--debug-port', '9222'));
let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
} catch {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  const executable = candidates.find(p => existsSync(p));
  if (!executable) throw new Error('Khong tim thay Google Chrome. Hay cai Chrome roi chay lai.');
  const profile = path.join(root, '.chrome-profile');
  spawn(executable, [`--remote-debugging-port=${debugPort}`, `--user-data-dir=${profile}`, '--no-first-run'], { detached: true, stdio: 'ignore' }).unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`); break; } catch { /* starting */ }
  }
  if (!browser) throw new Error(`Chrome khong san sang tren cong ${debugPort}.`);
}
const context = browser.contexts()[0];
if (!context) throw new Error('Chrome debug khong co browser context. Mo lai Chrome bang lenh trong README.');
context.setDefaultTimeout(15000);
const page = context.pages()[0] || await context.newPage();
await page.setExtraHTTPHeaders({ 'Accept-Language': `${language},en;q=0.8` });
// Listen before discovery: list responses can contain metadata missing from detail HTML.
const items = new Map();
function collect(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.id === 'string' && value.video && value.author) {
    items.set(value.id, value);
    if (items.size > 2000) items.delete(items.keys().next().value);
  }
  for (const child of Object.values(value)) collect(child);
}
context.on('response', async response => {
  try {
    const u = new URL(response.url());
    if (!(u.hostname === 'tiktok.com' || u.hostname.endsWith('.tiktok.com')) ||
        !response.headers()['content-type']?.includes('application/json')) return;
    collect(await response.json());
  } catch { /* A navigation can cancel a response body. */ }
});
async function gate(p) {
  const denied = async () => /chrome-error:/.test(p.url()) || await p.locator('body').innerText({ timeout: 3000 })
    .then(text => /Access Denied|You don't have permission to access/i.test(text), () => false);
  const blocked = async () => await denied() || /\/login/.test(p.url()) || await p
    .locator('[class*="captcha"], [id*="captcha"], iframe[src*="captcha"]')
    .evaluateAll(nodes => nodes.some(n => {
      const r = n.getBoundingClientRect();
      const s = getComputedStyle(n);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    })).catch(() => false);
  while (await blocked()) {
    await p.bringToFront();
    if (autoMode) throw new Error('TikTok dang chan/yeu cau xac minh; bo qua nguon nay va thu lai o chu ky sau.');
    await prompt(await denied()
      ? 'TikTok Access Denied/loi truy cap. Tool dang dung. Khi trang TikTok mo lai duoc, nhan Enter (Ctrl+C de thoat): '
      : 'TikTok yeu cau dang nhap/xac minh. Xu ly tren trinh duyet, roi nhan Enter: ');
  }
}
async function navigate(p, url) {
  try {
    await p.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (error) {
    if (!/ERR_HTTP_RESPONSE_CODE_FAILURE|chrome-error:\/\//.test(error.message)) throw error;
    await p.bringToFront();
    await prompt('Loi truy cap TikTok. Kiem tra trang tren Chrome; khi mo lai duoc, nhan Enter (Ctrl+C de thoat): ');
  }
  await gate(p);
  if (new URL(p.url()).pathname !== new URL(url).pathname) {
    throw new Error('Trang hien tai khong phai trang can thu thap. Chay lai khi truy cap TikTok hoat dong.');
  }
}
async function state(p) {
  return p.locator('script[type="application/json"], script#SIGI_STATE, script#__UNIVERSAL_DATA_FOR_REHYDRATION__').evaluateAll(nodes => nodes.flatMap(n => {
    try { return [JSON.parse(n.textContent)]; } catch { return []; }
  })).catch(error => {
    if (/Execution context was destroyed|Target page, context or browser has been closed/i.test(String(error))) return [];
    throw error;
  });
}
function find(value, predicate) {
  if (!value || typeof value !== 'object') return null;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) { const match = find(child, predicate); if (match) return match; }
  return null;
}
async function json(file, data) {
  await writeFile(file + '.tmp', JSON.stringify(data, null, 2));
  await rename(file + '.tmp', file);
}
async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
}
async function downloadWithYtDlp(url, output) {
  const cookieFile = path.join(os.tmpdir(), `tiktok-snap-${randomUUID()}.cookies.txt`);
  const cookies = await context.cookies('https://www.tiktok.com');
  const cookieText = ['# Netscape HTTP Cookie File', ...cookies.map(cookie => {
    const domain = cookie.domain;
    const includeSubdomains = domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expires = cookie.expires > 0 ? Math.floor(cookie.expires) : 0;
    return [domain, includeSubdomains, cookie.path || '/', secure, expires, cookie.name,
      String(cookie.value).replace(/[\t\r\n]/g, '')].join('\t');
  })].join('\r\n') + '\r\n';
  await writeFile(cookieFile, cookieText, { mode: 0o600 });
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('yt-dlp', [
        '--no-playlist', '--no-progress', '--newline', '--impersonate', 'chrome',
        '--retries', '2', '--fragment-retries', '2', '--retry-sleep', '1',
        '--cookies', cookieFile, '--merge-output-format', 'mp4',
        '--output', output, '--force-overwrites', url,
      ], { windowsHide: true });
      let errorText = '';
      child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-4000); });
      child.on('error', error => reject(new Error(`Khong chay duoc yt-dlp: ${error.message}`)));
      child.on('exit', code => code === 0
        ? resolve()
        : reject(new Error(`yt-dlp exit ${code}: ${errorText.trim() || 'unknown error'}`)));
    });
  } finally {
    await rm(cookieFile, { force: true });
  }
}
async function downloadFromBrowser(mediaUrl, referer, output) {
  if (!mediaUrl || !/^https:\/\//.test(mediaUrl)) throw new Error('Browser metadata has no video URL.');
  const response = await context.request.get(mediaUrl, { headers: { referer }, timeout: 60000 });
  try {
    if (!response.ok()) throw new Error(`Browser fallback HTTP ${response.status()}`);
    const bytes = await response.body();
    if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new Error('Browser fallback is not MP4.');
    await writeFile(`${output}.part`, bytes);
    await rename(`${output}.part`, output);
  } finally { await response.dispose(); }
}
try {
  const marker = path.join(root, '.browser-profile', '.login-ready');
  if (loginMode) {
    await navigate(page, 'https://www.tiktok.com/login');
    await prompt('Anh dang nhap TikTok tren Chrome, sau do nhan Enter tai day: ');
    await gate(page);
    await writeFile(marker, 'ready');
    if (args.includes('--login')) process.exitCode = 0;
  }
  if (!args.includes('--login')) {
    await navigate(page, `https://www.tiktok.com/tag/${encodeURIComponent(tag)}?lang=${encodeURIComponent(language)}`);
    await page.bringToFront();
    if (!autoMode) await prompt('Anh kiem tra/xac minh TikTok tren Chrome truoc. Khi san sang thu thap, nhan Enter tai day: ');
    await gate(page);
    // Return to the requested hashtag if verification took the user elsewhere.
    if (new URL(page.url()).pathname !== `/tag/${encodeURIComponent(tag)}`) {
      await navigate(page, `https://www.tiktok.com/tag/${encodeURIComponent(tag)}?lang=${encodeURIComponent(language)}`);
      await gate(page);
    }
    const links = new Set();
    let idle = 0;
    // Bounded discovery; TikTok's displayed order, not a global view-count ranking.
    for (let round = 0; round < 30 && links.size < limit * 3 && idle < 5; round++) {
      await page.waitForTimeout(2200);
      await gate(page);
      const before = links.size;
      for (const url of await page.locator('a[href*="/video/"]').evaluateAll(nodes => nodes
        .map(n => ({ href: n.href, rect: n.getBoundingClientRect() }))
        .filter(n => n.rect.width > 0 && n.rect.height > 0)
        .sort((a, b) => a.rect.top - b.rect.top || a.rect.left - b.rect.left)
        .map(n => n.href))) {
        if (/^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+/.test(url)) links.add(url.split('?')[0]);
      }
      idle = links.size === before ? idle + 1 : 0;
      await page.mouse.wheel(0, 1400);
    }
    console.log(`Tim thay ${links.size} video cho #${tag}.`);
    if (!links.size) throw new Error('Khong tim thay video. Kiem tra trang TikTok/dang nhap/xac minh; giao dien co the da thay doi.');
    const backlog = [];
    for (const entry of await readdir(archive, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const oldFolder = path.join(archive, entry.name);
      if (await exists(path.join(oldFolder, 'video.mp4'))) continue;
      const oldMetadata = await readJson(path.join(oldFolder, 'metadata.json'));
      if (oldMetadata?.url) backlog.push(oldMetadata.url);
    }
    if (backlog.length) console.log(`Retry ${backlog.length} video cu dang thieu file.`);
    const detail = await context.newPage();
    await detail.setExtraHTTPHeaders({ 'Accept-Language': `${language},en;q=0.8` });
    let saved = 0;
    let failed = 0;
    let consecutiveFailures = 0;
    // TikTok/Akamai rate-limits rapid detail navigations. Keep requests human-paced.
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (const url of new Set([...backlog, ...links])) {
      if (saved >= limit) break;
      const id = url.match(/\/video\/(\d+)/)[1];
      const folder = path.join(archive, id);
      const completed = await exists(path.join(folder, 'complete.json'));
      if (completed && !refreshMode) continue;
      try {
        await navigate(detail, url);
        await gate(detail);
        let item;
        for (let attempt = 0; attempt < 12; attempt++) {
          collect(await state(detail));
          item = items.get(id);
          if (item) break;
          await detail.waitForTimeout(1000);
        }
        if (!item) {
          await gate(detail);
          const diagnostic = await detail.evaluate(() => ({
            title: document.title,
            path: location.pathname,
            scripts: [...document.querySelectorAll('script[id]')].map(s => s.id),
            hasVideo: !!document.querySelector('video'),
          }));
          await json(path.join(archive, `${id}-diagnostic.json`), diagnostic);
          throw new Error(`Video metadata unavailable after 12s; see ${id}-diagnostic.json (page: ${diagnostic.title}).`);
        }
        await mkdir(folder, { recursive: true });
        const author = typeof item.author === 'object' ? item.author : { uniqueId: item.author };
        const username = author.uniqueId || url.match(/\/@([^/]+)/)[1];
        const previous = await readJson(path.join(folder, 'metadata.json'));
        const metadata = { id, url, tag: previous?.tag || tag, sourceRegion: previous?.sourceRegion || region,
          language: previous?.language || language, capturedAt: new Date().toISOString(), caption: item.desc,
          stats: item.stats, createTime: item.createTime, author: { username, nickname: author.nickname, bio: author.signature ?? null } };
        await json(path.join(folder, 'metadata.json'), metadata);
        await appendFile(path.join(folder, 'snapshots.jsonl'), JSON.stringify({
          capturedAt: metadata.capturedAt, stats: metadata.stats ?? null,
        }) + '\n');
        if (!await exists(path.join(folder, 'video.mp4'))) {
          const output = path.join(folder, 'video.mp4');
          try {
            await downloadWithYtDlp(url, output);
          } catch (ytError) {
            const media = item.video.playAddr || item.video.downloadAddr;
            const mediaUrl = typeof media === 'string' ? media : media?.urlList?.[0];
            console.warn(`${id}: yt-dlp loi, dang thu URL tu Chrome...`);
            try { await downloadFromBrowser(mediaUrl, url, output); }
            catch (fallbackError) { throw new Error(`${ytError.message}; fallback: ${fallbackError.message}`); }
          }
          const bytes = await import('node:fs/promises').then(fs => fs.readFile(output));
          if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') {
            throw new Error('yt-dlp output is not a valid MP4.');
          }
        }
        // Prefer author data embedded in the video response; avoid an extra profile navigation.
        const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
        const profile = find(await state(detail), v => v.user?.uniqueId === username && v.stats);
        const bio = author.signature ?? profile?.user?.signature ?? null;
        await json(path.join(folder, 'channel.json'), { username, url: profileUrl, bio,
          nickname: profile?.user?.nickname ?? author.nickname, stats: profile?.stats ?? null, capturedAt: new Date().toISOString() });
        await json(path.join(folder, 'complete.json'), { savedAt: new Date().toISOString() });
        saved++;
        consecutiveFailures = 0;
        console.log(`[${saved}/${limit}] ${completed ? 'Da cap nhat' : 'Da luu'} ${id} @${username}`);
        await pause(2500 + Math.floor(Math.random() * 2500));
      } catch (error) {
        failed++;
        consecutiveFailures++;
        const message = String(error.message).replace(/https?:\/\/\S+/g, '[URL]');
        console.error(`${id}: ${message}`);
        await appendFile(path.join(archive, 'errors.jsonl'), JSON.stringify({ id, at: new Date().toISOString(), error: message }) + '\n');
        await pause(5000);
        if (consecutiveFailures >= 10) {
          console.error('Dung sau 10 loi lien tiep; TikTok co the dang chan truy cap.');
          break;
        }
      }
      await detail.waitForTimeout(2000);
    }
    console.log(`Hoan tat: ${saved} video moi; ${failed} loi. Kho: ${archive}`);
    if (failed && !saved) process.exitCode = 1;
  }
} finally { await browser.close(); }
