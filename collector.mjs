import { CrawlQueue, discoverFeed } from './feed-queue.mjs';
import { chromium } from 'playwright';
import { mkdir, writeFile, rename, appendFile, rm, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isMp4, isComplete } from './archive-logic.mjs';
import { finalizeVideo } from './media-compat.mjs';
import { channelFolder, listVideos, videoFolder, saveChannel, migrateArchive } from './archive-layout.mjs';
import { excludedSource, vietnamReason } from './content-filter.mjs';
import { createLimiter } from './concurrency.mjs';
import { channelMetadata } from './channel-metadata.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const option = (key, fallback) => {
  const exact = args.indexOf(key);
  if (exact >= 0) return args[exact + 1] ?? fallback;
  const inline = args.find(value => value.startsWith(`${key}=`));
  return inline ? inline.slice(key.length + 1) : fallback;
};
const tag = option('--tag', 'viralusa').replace(/^#/, '');
const region = option('--region', 'US').toUpperCase();
const language = option('--lang', 'en');
if (excludedSource({ tag, region, lang: language })) throw new Error('Nguon Viet Nam da bi loai khoi crawler.');
const limitOption = option('--limit', 'all');
const limit = limitOption === 'all' ? Infinity : Number(limitOption);
const autoMode = args.includes('--auto');
const discoveryOnly = args.includes('--discover-only');
const discoveryPages = Number(option('--discovery-pages', 'Infinity'));
const failureCooldownSeconds = Math.max(10, Number(option('--failure-cooldown', '60')) || 60);
const profileLimit = (key, fallback = 'all') => {
  const value = String(option(key, fallback)).toLowerCase();
  if (value === 'all' || value === 'infinity') return Infinity;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`Invalid ${key}; use all or a positive integer.`);
  return parsed;
};
const profilePageBudget = profileLimit('--profile-page-budget');
const profileNoAddPages = profileLimit('--profile-no-add-pages');
const profileBacklogLimit = Math.max(0, Number(option('--profile-backlog-limit', '8')) || 0);
const concurrencyOption = (key, fallback, maximum) => {
  const parsed = Number(option(key, String(fallback)));
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`Invalid ${key}; use an integer from 1 to ${maximum}.`);
  }
  return parsed;
};
const downloadConcurrency = concurrencyOption('--download-concurrency', 3, 8);
const verifyConcurrency = concurrencyOption('--verify-concurrency', 2, 4);
if (!(discoveryPages > 0) || (discoveryPages !== Infinity && !Number.isSafeInteger(discoveryPages))) throw new Error('Invalid --discovery-pages');
let stopDiscovery = false;
let producer;
let discoveryPage;

if (!tag || (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 1))) throw new Error('Use --tag fyp --limit 20 (limit: 1–500).');
const archive = path.join(root, 'archive');
await mkdir(archive, { recursive: true });
await migrateArchive(archive);
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
    if (autoMode) throw error;
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
  const temporary = `${output}.part`;
  const cookies = await context.cookies(mediaUrl);
  const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ');
  const response = await fetch(mediaUrl, {
    headers: {
      referer,
      'user-agent': await context.pages()[0]?.evaluate(() => navigator.userAgent).catch(() => '') || 'Mozilla/5.0',
      ...(cookie ? { cookie } : {}),
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(10 * 60_000),
  });
  try {
    if (!response.ok || !response.body) throw new Error(`Browser media HTTP ${response.status}`);
    await rm(temporary, { force: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary));
    if (!await isMp4(temporary)) throw new Error('Browser media response is not MP4.');
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function mediaUrls(item) {
  const values = [item?.video?.playAddr, item?.video?.downloadAddr];
  const urls = values.flatMap(value => typeof value === 'string' ? [value] : value?.urlList || []);
  return [...new Set(urls.filter(value => typeof value === 'string' && /^https:\/\//.test(value)))];
}
try {
  const marker = path.join(root, '.chrome-profile', '.login-ready');
  if (loginMode) {
    await page.goto('https://www.tiktok.com/login', { waitUntil: 'domcontentloaded' });
    await prompt('Anh dang nhap TikTok tren Chrome, sau do nhan Enter tai day: ');
    await gate(page);
    await mkdir(path.dirname(marker), { recursive: true });
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
    const backlog = [];
    const archivedFolders = await listVideos(archive);
    const videoIndex = new Map(archivedFolders.map(folder => [path.basename(folder), folder]));
    for (const oldFolder of archivedFolders) {
      if (await isComplete(oldFolder)) continue;
      const oldMetadata = await readJson(path.join(oldFolder, 'metadata.json'));
      if (oldMetadata?.tag?.toLowerCase() !== tag.toLowerCase()) continue;
      if (oldMetadata && (excludedSource({ region: oldMetadata.sourceRegion, lang: oldMetadata.language, tag: oldMetadata.tag }) || vietnamReason(oldMetadata))) continue;
      if (typeof oldMetadata?.url === 'string' && /^https:\/\/www\.tiktok\.com\/@[^/]+\/video\/\d+$/.test(oldMetadata.url)) backlog.push(oldMetadata.url);
    }
    if (backlog.length) console.log(`Retry ${backlog.length} video cu dang thieu file.`);
    const detail = await context.newPage();
    await detail.setExtraHTTPHeaders({ 'Accept-Language': `${language},en;q=0.8` });
    const runFallback = createLimiter(1);
    const runVerify = createLimiter(verifyConcurrency);
    const runChannelWrite = createLimiter(1);
    let saved = 0;
    let failed = 0;
    let excluded = 0;
    let deferredMedia = 0;
    let consecutiveFailures = 0;
    let failureBursts = 0;
    let cooldownUntil = 0;
    // TikTok/Akamai rate-limits rapid detail navigations. Keep requests human-paced.
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitForCooldown = async () => {
      const remaining = cooldownUntil - Date.now();
      if (remaining > 0) await pause(remaining);
    };
    console.log(`Downloader pool: ${downloadConcurrency} media; ${verifyConcurrency} FFmpeg; 1 page/yt-dlp fallback.`);
    const queue = await CrawlQueue.open(archive, tag, region);
    let removedUnavailable = 0;
    for (const job of Object.values(queue.data.jobs)) {
      if (job.status !== 'excluded' || job.reason !== 'video-unavailable') continue;
      const oldFolder = videoIndex.get(job.id);
      if (!oldFolder || await isComplete(oldFolder)) continue;
      const relative = path.relative(archive, oldFolder);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Unsafe archive cleanup path: ${oldFolder}`);
      await rm(oldFolder, { recursive: true, force: true });
      videoIndex.delete(job.id);
      removedUnavailable++;
    }
    if (removedUnavailable) console.log(`Da xoa ${removedUnavailable} thu muc video khong con phat duoc/khong con cong khai.`);
    for (const url of backlog) {
      const id = url.match(/\/video\/(\d+)/)[1];
      if (!queue.data.jobs[id]) queue.data.jobs[id] = { id, url, status: 'pending', source: 'archive' };
      else if (queue.data.jobs[id].status === 'done') queue.data.jobs[id].status = 'pending';
    }
    await queue.save();
    const pendingDownloads = () => Object.values(queue.data.jobs)
      .filter(job => job.status === 'pending' && (items.has(job.id) || job.item)).length;
    const waitForProfileCapacity = async () => {
      let announced = false;
      while (!stopDiscovery && pendingDownloads() > profileBacklogLimit) {
        if (!announced) {
          console.log(`Uu tien tai video: tam dung quet kenh khi con ${pendingDownloads()} video dang cho.`);
          announced = true;
        }
        await pause(1000);
      }
      if (announced && !stopDiscovery) console.log('Queue da ha xuong nguong; tiep tuc vet kenh.');
    };
    discoveryPage = await context.newPage();
    await discoveryPage.setExtraHTTPHeaders({ 'Accept-Language': `${language},en;q=0.8` });
    let discoveryDone = false;
    const discoveryErrors = [];
    producer = (async () => {
      try {
        await discoverFeed({ page: discoveryPage, queue, source: `tag:${tag}`, url: `https://www.tiktok.com/tag/${encodeURIComponent(tag)}?lang=${encodeURIComponent(language)}`,
          gate, stopped: () => stopDiscovery, maxPages: discoveryPages, maxIdle: 30, cursorRetries: 4 });
      } catch (error) {
        discoveryErrors.push(`tag:${tag}: ${error.message}`);
        console.error(`Quet hashtag #${tag} loi; van tiep tuc quet cac kenh da tim thay: ${error.message}`);
      }
      if (!args.includes('--no-profiles') && !stopDiscovery && discoveryPages === Infinity) {
        const authors = Object.keys(queue.data.authors);
        console.log(`Bat dau SUPER SWEEP ${authors.length} kenh tu #${tag}: lay toan bo video cong khai den hasMore=false.`);
        for (const [index, username] of authors.entries()) {
          if (stopDiscovery) break;
          const profileSource = `user:${username}`;
          try {
            await waitForProfileCapacity();
            await discoverFeed({ page: discoveryPage, queue, source: profileSource, profile: true,
              url: `https://www.tiktok.com/@${encodeURIComponent(username)}`, gate, stopped: () => stopDiscovery,
              maxPages: profilePageBudget, maxIdle: 15, maxNoAddPages: profileNoAddPages,
              cursorRetries: 4, beforeNextPage: waitForProfileCapacity });
          } catch (error) {
            discoveryErrors.push(`user:${username}: ${error.message}`);
            console.error(`Bo qua loi kenh @${username} (${index + 1}/${authors.length}): ${error.message}`);
          }
          const profileState = queue.data.sources[profileSource];
          if (profileState) {
            const updatedAt = new Date().toISOString();
            await runChannelWrite(() => saveChannel(channelFolder(archive, username), {
              username,
              url: `https://www.tiktok.com/@${encodeURIComponent(username)}`,
              superSweep: {
                status: profileState.status,
                cursor: profileState.cursor ?? null,
                hasMore: profileState.hasMore ?? null,
                videosFoundOnProfile: Object.values(queue.data.jobs).filter(job => job.source === profileSource).length,
                sourceTag: tag,
                sourceRegion: region,
                updatedAt,
                ...(profileState.status === 'exhausted' ? { completedAt: updatedAt } : {}),
              },
              capturedAt: updatedAt,
            }));
          }
          if (!stopDiscovery) await pause(1500);
        }
      }
    })().catch(error => { discoveryErrors.push(`unexpected: ${error.message}`); }).finally(() => { discoveryDone = true; });
    async function* queuedUrls() {
      const attempted = new Set();
      while (true) {
        const jobs = Object.values(queue.data.jobs);
        const pending = ['pending', 'failed', 'retry'].flatMap(status =>
          jobs.filter(job => job.status === status && !attempted.has(job.id)));
        // A restarted queue can contain old IDs before their profile API page is
        // replayed. Wait for that API metadata instead of opening every detail
        // page, which quickly triggers TikTok/Akamai navigation rate limits.
        const ready = pending.filter(job => items.has(job.id) || job.item);
        for (const job of ready) { attempted.add(job.id); yield job.url; }
        if (discoveryDone) {
          const deferred = pending.filter(job => !items.has(job.id) && !job.item);
          if (deferred.length) {
            const updatedAt = new Date().toISOString();
            for (const job of deferred) {
              job.status = 'retry';
              job.retryReason = 'awaiting-feed-metadata';
              job.updatedAt = updatedAt;
            }
            await queue.save();
            console.warn(`${deferred.length} video chua co metadata API; giu lai retry, khong mo trang chi tiet de tranh bi TikTok chan.`);
          }
          return;
        }
        await pause(500);
      }
    }
    if (discoveryOnly) { await producer; console.log(`Queue: ${Object.keys(queue.data.jobs).length} IDs; ${queue.file}`); }
    async function processUrl(url) {
      if (saved >= limit) return;
      const id = url.match(/\/video\/(\d+)/)[1];
      const folder = videoIndex.get(id) || videoFolder(archive, decodeURIComponent(new URL(url).pathname.split('/')[1].slice(1)), id);
      const completed = await isComplete(folder);
      if (completed) { await queue.mark(id, 'done'); return; }
      let usedFeedApi = false;
      let fallbackProfile = null;
      try {
        await waitForCooldown();
        let item = items.get(id) || queue.data.jobs[id]?.item;
        if (!item) {
          await pause(250);
          item = items.get(id) || queue.data.jobs[id]?.item;
        }
        usedFeedApi = !!item;
        if (!item && !autoMode) await runFallback(async () => {
          item = items.get(id);
          if (item) { usedFeedApi = true; return; }
          await navigate(detail, url);
          await gate(detail);
          for (let attempt = 0; attempt < 12; attempt++) {
            collect(await state(detail));
            item = items.get(id);
            if (item) break;
            await pause(1000);
          }
          if (item && !item.authorStats) {
            const authorId = typeof item.author === 'object' ? item.author.uniqueId : item.author;
            fallbackProfile = find(await state(detail), value => value.user?.uniqueId === authorId && value.stats);
          }
        });
        if (!item) {
          const diagnostic = await runFallback(async () => {
            await gate(detail);
            return detail.evaluate(() => ({
              title: document.title,
              path: location.pathname,
              scripts: [...document.querySelectorAll('script[id]')].map(s => s.id),
              hasVideo: !!document.querySelector('video'),
            }));
          });
          await json(path.join(archive, `${id}-diagnostic.json`), diagnostic);
          throw new Error(`Video metadata unavailable after 12s; see ${id}-diagnostic.json (page: ${diagnostic.title}).`);
        }
        const exclusionReason = vietnamReason(item);
        if (exclusionReason) {
          await queue.mark(id, 'excluded');
          excluded++;
          consecutiveFailures = 0;
          failureBursts = 0;
          console.log(`Bo qua ${id}: ${exclusionReason}`);
          await appendFile(path.join(archive, 'excluded.jsonl'), JSON.stringify({ id, at: new Date().toISOString(), reason: exclusionReason }) + '\n');
          await pause(2500);
          return;
        }
        const availableMediaUrls = mediaUrls(item);
        if (!availableMediaUrls.length && !await isMp4(path.join(folder, 'video.mp4'))) {
          const job = queue.data.jobs[id];
          job.status = 'retry';
          job.retryReason = 'awaiting-media-url';
          job.updatedAt = new Date().toISOString();
          await queue.save();
          deferredMedia++;
          return;
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
        if (!await isMp4(path.join(folder, 'video.mp4'))) {
          const output = path.join(folder, 'video.mp4');
          let directError;
          for (const mediaUrl of availableMediaUrls) {
            try {
              await downloadFromBrowser(mediaUrl, url, output);
              directError = null;
              console.log(`${id}: tai truc tiep tu media API.`);
              break;
            } catch (error) { directError = error; }
          }
          if (!await isMp4(output)) {
            if (directError) console.warn(`${id}: media API loi, dang fallback yt-dlp...`);
            try { await runFallback(() => downloadWithYtDlp(url, output)); }
            catch (ytError) {
              throw new Error(`${directError?.message || 'Feed has no usable media URL'}; ${ytError.message}`);
            }
          }
          if (!await isMp4(output)) {
            throw new Error('Downloaded output is not a valid MP4.');
          }
        }
        // Prefer author data embedded in the video response; avoid an extra profile navigation.
        const profileUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}`;
        const profile = item.authorStats ? { user: author, stats: item.authorStats }
          : fallbackProfile;
        const channelAuthor = { ...author, ...(profile?.user || {}) };
        await runChannelWrite(() => saveChannel(path.dirname(folder), channelMetadata({
          author: channelAuthor,
          stats: item.authorStats ?? profile?.stats ?? null,
          username,
          url: profileUrl,
          tag,
          region,
          language,
          capturedAt: new Date().toISOString(),
        })));
        await runVerify(() => finalizeVideo(folder));
        await queue.mark(id, 'done');
        saved++;
        consecutiveFailures = 0;
        failureBursts = 0;
        console.log(`[${saved}/${limit === Infinity ? 'all' : limit}] Da luu ${id} @${username}`);
        if (saved >= limit) return;
        await pause(usedFeedApi ? 500 + Math.floor(Math.random() * 500) : 2500 + Math.floor(Math.random() * 2500));
      } catch (error) {
        await queue.mark(id, 'failed');
        failed++;
        consecutiveFailures++;
        let cooldown = 0;
        if (consecutiveFailures >= 10) {
          cooldown = Math.min(300, failureCooldownSeconds * 2 ** failureBursts);
          failureBursts++;
          consecutiveFailures = 0;
          cooldownUntil = Math.max(cooldownUntil, Date.now() + cooldown * 1000);
        }
        const message = String(error.message).replace(/https?:\/\/\S+/g, '[URL]');
        console.error(`${id}: ${message}`);
        await appendFile(path.join(archive, 'errors.jsonl'), JSON.stringify({ id, at: new Date().toISOString(), error: message }) + '\n');
        await pause(5000);
        if (cooldown) {
          console.error(`TikTok co the dang chan tam thoi; nghi ${cooldown}s roi tiep tuc can quet.`);
          await runFallback(() => detail.goto('about:blank')).catch(() => {});
          await waitForCooldown();
        }
      }
      await pause(usedFeedApi ? 250 : 2000);
    }
    if (!discoveryOnly) {
      const iterator = queuedUrls()[Symbol.asyncIterator]();
      let activeClaims = 0;
      async function downloadWorker() {
        while (true) {
          while (limit !== Infinity && saved < limit && saved + activeClaims >= limit) await pause(50);
          if (saved >= limit) return;
          activeClaims++;
          const next = await iterator.next();
          if (next.done) { activeClaims--; return; }
          try { await processUrl(next.value); }
          finally { activeClaims--; }
        }
      }
      await Promise.all(Array.from({ length: downloadConcurrency }, () => downloadWorker()));
    }
    if (saved >= limit && limit !== Infinity) stopDiscovery = true;
    await producer;
    if (discoveryErrors.length) {
      console.error(`Discovery co ${discoveryErrors.length} nguon loi; cac nguon khac da tiep tuc va se retry o chu ky sau.`);
      process.exitCode = 1;
    }
    console.log(`Hoan tat: ${saved} video; ${excluded} bi loai; ${deferredMedia} cho media API; ${failed} loi. Kho: ${archive}`);
    if (failed && !saved) process.exitCode = 1;
  }
} finally { stopDiscovery = true; await producer; await discoveryPage?.close(); await browser.close(); }
