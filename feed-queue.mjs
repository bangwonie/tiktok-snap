import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { vietnamReason } from './content-filter.mjs';

const present = entries => Object.fromEntries(entries.filter(([, value]) => value !== undefined && value !== null));
let temporarySequence = 0;

async function replaceQueueFile(file, snapshot) {
  const temporary = `${file}.${process.pid}.${++temporarySequence}.tmp`;
  await writeFile(temporary, snapshot);
  let lastError;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await rename(temporary, file);
        return;
      } catch (error) {
        lastError = error;
        if (!['EPERM', 'EACCES', 'EEXIST'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
      }
    }
    // Windows antivirus/indexing can briefly lock the destination. A complete
    // direct write keeps the sweep alive if every atomic rename retry loses.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await writeFile(file, snapshot);
        return;
      } catch (error) {
        lastError = error;
        if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
        await new Promise(resolve => setTimeout(resolve, 100 * 2 ** attempt));
      }
    }
    throw lastError;
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

function mediaAddress(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value?.urlList)) return undefined;
  return present([
    ['uri', value.uri],
    ['urlList', value.urlList.filter(url => typeof url === 'string' && /^https:\/\//.test(url))],
    ['width', value.width],
    ['height', value.height],
  ]);
}

function hasMediaAddress(value) {
  return typeof value === 'string' && /^https:\/\//.test(value) ||
    Array.isArray(value?.urlList) && value.urlList.some(url => typeof url === 'string' && /^https:\/\//.test(url));
}

export function unavailableVideoReason(item) {
  const video = item?.video;
  if (!video) return 'not-a-video';
  if (hasMediaAddress(video.playAddr) || hasMediaAddress(video.downloadAddr)) return null;
  const emptyShape = Number(video.duration || 0) <= 0 && Number(video.width || 0) <= 0 && Number(video.height || 0) <= 0;
  return emptyShape ? 'video-unavailable' : null;
}

// Queue only the fields needed to download, filter, and write public metadata.
// Keeping this small makes API-discovered videos restart-safe without retaining
// the entire TikTok response.
export function compactFeedItem(item) {
  const author = item?.author || {};
  const video = item?.video || {};
  return present([
    ['id', item?.id],
    ['desc', item?.desc],
    ['createTime', item?.createTime],
    ['region', item?.region],
    ['textLanguage', item?.textLanguage],
    ['textExtra', item?.textExtra],
    ['stats', item?.stats],
    ['authorStats', item?.authorStats],
    ['author', present([
      ['id', author.id], ['secUid', author.secUid], ['uniqueId', author.uniqueId],
      ['nickname', author.nickname], ['signature', author.signature], ['verified', author.verified],
      ['privateAccount', author.privateAccount], ['avatarThumb', author.avatarThumb],
      ['avatarMedium', author.avatarMedium], ['avatarLarger', author.avatarLarger],
      ['commentSetting', author.commentSetting], ['duetSetting', author.duetSetting],
      ['stitchSetting', author.stitchSetting], ['downloadSetting', author.downloadSetting],
      ['openFavorite', author.openFavorite],
    ])],
    ['video', present([
      ['duration', video.duration], ['width', video.width], ['height', video.height],
      ['ratio', video.ratio], ['format', video.format], ['bitrate', video.bitrate],
      ['playAddr', mediaAddress(video.playAddr)],
      ['downloadAddr', mediaAddress(video.downloadAddr)],
    ])],
  ]);
}

export function parseFeed(body) {
  if (!body || (body.statusCode ?? body.status_code ?? 0) !== 0 || !Array.isArray(body.itemList)) throw new Error('Invalid feed response');
  const more = body.hasMore;
  if (![true, false, 0, 1].includes(more)) throw new Error('Feed missing hasMore');
  if (more && body.cursor == null) throw new Error('Feed missing cursor');
  return { rows: body.itemList, cursor: String(body.cursor ?? '0'), more: Boolean(more) };
}
export function matchesTag(item, tag) {
  const wanted = tag.toLowerCase();
  if ((item.textExtra || []).some(t => t.hashtagName?.toLowerCase() === wanted)) return true;
  return [...String(item.desc || '').matchAll(/#([^\s#.,!?;:]+)/gu)].some(m => m[1].toLowerCase() === wanted);
}
export class CrawlQueue {
  static async open(archive, tag, region) {
    const dir = path.join(archive, 'queues');
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, createHash('sha256').update(`${region}:${tag.toLowerCase()}`).digest('hex').slice(0, 20) + '.json');
    let data;
    try { data = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const queue = new CrawlQueue(file, data || { tag, region, jobs: {}, sources: {}, authors: {} });
    let normalized = false;
    for (const job of Object.values(queue.data.jobs || {})) {
      const reason = job.item && unavailableVideoReason(job.item);
      if (!reason || ['done', 'excluded'].includes(job.status)) continue;
      job.status = 'excluded';
      job.reason = reason;
      delete job.item;
      normalized = true;
    }
    if (normalized) await queue.save();
    return queue;
  }
  constructor(file, data) { this.file = file; this.data = data; this.writes = Promise.resolve(); }
  save() {
    const snapshot = JSON.stringify(this.data);
    this.writes = this.writes.catch(() => {}).then(() => replaceQueueFile(this.file, snapshot));
    return this.writes;
  }
  ingest(rows, source) {
    let added = 0;
    for (const item of rows) {
      const id = item.id;
      const author = item.author;
      if (typeof id !== 'string' || !/^\d+$/.test(id) || !author?.uniqueId || !item.video) continue;
      const reason = vietnamReason(item) || unavailableVideoReason(item);
      const existing = this.data.jobs[id];
      if (existing) {
        existing.lastSeenAt = new Date().toISOString();
        if (!['done', 'excluded'].includes(existing.status)) {
          existing.source = source;
          existing.status = reason ? 'excluded' : 'pending';
          existing.reason = reason;
          if (reason) delete existing.item;
          else existing.item = compactFeedItem(item);
        }
        if (!reason) this.data.authors[author.uniqueId] = true;
        continue;
      }
      this.data.jobs[id] = {
        id,
        url: `https://www.tiktok.com/@${encodeURIComponent(author.uniqueId)}/video/${id}`,
        status: reason ? 'excluded' : 'pending',
        reason,
        source,
        lastSeenAt: new Date().toISOString(),
        ...(reason ? {} : { item: compactFeedItem(item) }),
      };
      if (!reason) this.data.authors[author.uniqueId] = true;
      added++;
    }
    return added;
  }
  async mark(id, status) {
    if (!this.data.jobs[id]) return;
    if (this.data.jobs[id].status === 'excluded' && status === 'failed') return;
    this.data.jobs[id].status = status;
    if (status === 'done' || status === 'excluded') delete this.data.jobs[id].item;
    await this.save();
  }
}

// The request URL (including session parameters) stays in memory only.
export async function discoverFeed({ page, queue, source, url, profile = false, gate, stopped,
  maxPages = Infinity, maxIdle = profile ? 15 : 30, maxNoAddPages = Infinity,
  cursorRetries = 4, beforeNextPage = async () => {} }) {
  const endpoint = profile ? '/api/post/item_list/' : '/api/challenge/item_list/';
  let template;
  let version = 0;
  let latest;
  let writeError;
  let noAddPages = 0;
  let chain = Promise.resolve();
  const accept = async (body, requestUrl) => {
    const feed = parseFeed(body);
    const added = queue.ingest(feed.rows, source);
    if (latest?.cursor === feed.cursor && feed.more && !added) return;
    latest = feed;
    noAddPages = added ? 0 : noAddPages + 1;
    template = requestUrl;
    version++;
    queue.data.sources[source] = { cursor: feed.cursor, hasMore: feed.more, status: feed.more ? 'running' : 'exhausted', updatedAt: new Date().toISOString() };
    await queue.save();
    console.log(`${source}: ${feed.rows.length} rows, +${added} IDs, cursor=${feed.cursor}, hasMore=${feed.more}`);
  };
  const listener = response => {
    if (new URL(response.url()).pathname !== endpoint) return;
    chain = chain.then(async () => {
      try { await accept(await response.json(), response.url()); }
      catch (error) { if (/Invalid feed|Feed missing|JSON|Unexpected/.test(error.message)) return; throw error; }
    }).catch(error => { writeError = error; });
  };
  page.on('response', listener);
  const oldCursor = queue.data.sources[source]?.hasMore ? queue.data.sources[source].cursor : null;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    let idle = 0;
    const cursorAttempts = new Map();
    let resume = oldCursor;
    while (!stopped() && version < maxPages) {
      await page.waitForTimeout(1800);
      await chain;
      if (writeError) throw writeError;
      await gate(page);
      if (latest && !latest.more) return;
      if (noAddPages >= maxNoAddPages) break;
      await beforeNextPage();
      if (stopped()) break;
      const before = version;
      const cursor = resume || latest?.cursor;
      const attempts = cursorAttempts.get(cursor) || 0;
      if (template && cursor && attempts < cursorRetries) {
        cursorAttempts.set(cursor, attempts + 1);
        const next = new URL(template);
        next.searchParams.set('cursor', cursor);
        for (const key of ['X-Bogus', 'X-Gnarly', '_signature']) next.searchParams.delete(key);
        // Native browser request is the fallback if direct pagination is unavailable.
        await page.evaluate(async requestUrl => {
          try { await fetch(requestUrl, { signal: AbortSignal.timeout(10000) }); } catch { /* retry via UI */ }
        }, next.href);
        await chain;
        if (version > before) resume = null;
      }
      if (version === before) {
        await page.evaluate(idleCount => {
          const distance = Math.max(1200, innerHeight * 1.5);
          if (idleCount > 0 && idleCount % 6 === 0) window.scrollBy(0, -Math.round(distance / 3));
          window.scrollBy(0, distance);
          for (const node of document.querySelectorAll('main, [class*="DivPageWrapper"], [class*="DivScrollContainer"]')) {
            if (node.scrollHeight > node.clientHeight) node.scrollTop = Math.min(node.scrollHeight, node.scrollTop + distance);
          }
        }, idle);
        await page.mouse.wheel(0, 2400);
        if (idle > 0 && idle % 8 === 0) await page.keyboard.press('End').catch(() => {});
        await page.waitForTimeout(1800 + Math.min(idle, 10) * 250);
        await chain;
      }
      idle = version === before ? idle + 1 : 0;
      if (idle >= maxIdle) break;
    }
    const entry = queue.data.sources[source] || {};
    if (entry.status !== 'exhausted') queue.data.sources[source] = {
      ...entry, status: 'retry', idleAttempts: idle, noAddPages, pagesThisPass: version,
      retryReason: noAddPages >= maxNoAddPages ? 'no-new-ids-budget' : version >= maxPages ? 'page-budget' : 'idle',
      updatedAt: new Date().toISOString(),
    };
    await queue.save();
  } catch (error) {
    queue.data.sources[source] = { ...queue.data.sources[source], status: 'retry', updatedAt: new Date().toISOString() };
    await queue.save();
    throw error;
  } finally { page.off('response', listener); await chain; if (writeError) throw writeError; }
}
