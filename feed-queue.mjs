import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { vietnamReason } from './content-filter.mjs';

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
    return new CrawlQueue(file, data || { tag, region, jobs: {}, sources: {}, authors: {} });
  }
  constructor(file, data) { this.file = file; this.data = data; this.writes = Promise.resolve(); }
  save() {
    const snapshot = JSON.stringify(this.data);
    this.writes = this.writes.then(async () => { await writeFile(this.file + '.tmp', snapshot); await rename(this.file + '.tmp', this.file); });
    return this.writes;
  }
  ingest(rows, source, profile = false) {
    let added = 0;
    for (const item of rows) {
      if (profile && !matchesTag(item, this.data.tag)) continue;
      const id = item.id;
      const author = item.author;
      if (typeof id !== 'string' || !/^\d+$/.test(id) || !author?.uniqueId || !item.video) continue;
      if (this.data.jobs[id]) continue;
      const reason = vietnamReason(item);
      this.data.jobs[id] = { id, url: `https://www.tiktok.com/@${encodeURIComponent(author.uniqueId)}/video/${id}`, status: reason ? 'excluded' : 'pending', reason, source };
      if (!reason) this.data.authors[author.uniqueId] = true;
      added++;
    }
    return added;
  }
  async mark(id, status) { if (this.data.jobs[id]) { this.data.jobs[id].status = status; await this.save(); } }
}

// The request URL (including session parameters) stays in memory only.
export async function discoverFeed({ page, queue, source, url, profile = false, gate, stopped, maxPages = Infinity }) {
  const endpoint = profile ? '/api/post/item_list/' : '/api/challenge/item_list/';
  let template;
  let version = 0;
  let latest;
  let writeError;
  let chain = Promise.resolve();
  const accept = async (body, requestUrl) => {
    const feed = parseFeed(body);
    const added = queue.ingest(feed.rows, source, profile);
    if (latest?.cursor === feed.cursor && feed.more && !added) return;
    latest = feed;
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
    let attemptedCursor;
    let resume = oldCursor;
    while (!stopped() && version < maxPages) {
      await page.waitForTimeout(1800);
      await chain;
      if (writeError) throw writeError;
      await gate(page);
      if (latest && !latest.more) return;
      const before = version;
      const cursor = resume || latest?.cursor;
      if (template && cursor && attemptedCursor !== cursor) {
        attemptedCursor = cursor;
        resume = null;
        const next = new URL(template);
        next.searchParams.set('cursor', cursor);
        for (const key of ['X-Bogus', 'X-Gnarly', '_signature']) next.searchParams.delete(key);
        // Native browser request is the fallback if direct pagination is unavailable.
        await page.evaluate(async requestUrl => {
          try { await fetch(requestUrl, { signal: AbortSignal.timeout(10000) }); } catch { /* retry via UI */ }
        }, next.href);
        await chain;
      }
      if (version === before) {
        await page.evaluate(() => {
          window.scrollBy(0, Math.max(800, innerHeight));
          for (const node of document.querySelectorAll('main, [class*="DivPageWrapper"], [class*="DivScrollContainer"]')) {
            if (node.scrollHeight > node.clientHeight) node.scrollTop += Math.max(800, node.clientHeight);
          }
        });
        await page.mouse.wheel(0, 1600);
        await page.waitForTimeout(1600);
        await chain;
      }
      idle = version === before ? idle + 1 : 0;
      if (idle >= 10) break;
    }
    const entry = queue.data.sources[source] || {};
    if (entry.status !== 'exhausted') queue.data.sources[source] = { ...entry, status: 'retry', updatedAt: new Date().toISOString() };
    await queue.save();
  } catch (error) {
    queue.data.sources[source] = { ...queue.data.sources[source], status: 'retry', updatedAt: new Date().toISOString() };
    await queue.save();
    throw error;
  } finally { page.off('response', listener); await chain; if (writeError) throw writeError; }
}
