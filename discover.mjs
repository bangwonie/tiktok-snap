import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { excludedSource } from './content-filter.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'watch.config.json'), 'utf8'));
const cc = config.creativeCenter || {};
if (!cc.enabled) process.exit(0);
const requestedRegions = process.argv.find(arg => arg.startsWith('--region='))?.split('=')[1]
  ?.toUpperCase().split(',').map(value => value.trim()).filter(Boolean);
const configuredRegions = cc.regions || [...new Set((config.sources || []).map(source => source.region))];
const regions = configuredRegions.filter(region => !excludedSource({ region }) && (!requestedRegions || requestedRegions.includes(region)));
const configuredLimit = String(cc.topPerRegion ?? 'all').toLowerCase();
const limit = configuredLimit === 'all' ? Infinity : Math.max(1, Number(configuredLimit) || 3);
const idleScrolls = Math.max(3, Number(cc.idleScrolls) || 8);
const maxScrolls = Math.max(idleScrolls, Number(cc.maxScrolls) || 200);
const countryCode = String(cc.countryCode || 'GB').toUpperCase();
const period = [7, 30, 120].includes(Number(cc.periodDays)) ? Number(cc.periodDays) : 7;
const browser = await chromium.launch({ headless: false, channel: 'chrome', chromiumSandbox: true });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
const page = await context.newPage();
const output = [];
try {
  for (const region of regions) {
    const source = (config.sources || []).find(item => item.region === region) || {};
    const query = new URLSearchParams({ period: String(period), region, countryCode });
    const url = `https://ads.tiktok.com/creative/creativeCenter/trends/hashtag?${query}`;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(5000);
      await page.keyboard.press('Escape').catch(() => {});
      const dialog = page.locator('[role="dialog"]').first();
      if (await dialog.isVisible({ timeout: 500 }).catch(() => false)) {
        const close = page.locator('[aria-label*="close" i], [data-e2e*="close" i]').first();
        if (await close.isVisible({ timeout: 500 }).catch(() => false)) await close.click({ timeout: 1000 }).catch(() => {});
      }
      // Gather every public row while scrolling. The table may virtualize old
      // rows, so merge each visible batch instead of reading only at the end.
      const found = new Map();
      let idle = 0;
      for (let scroll = 0; scroll < maxScrolls && idle < idleScrolls; scroll++) {
        const rows = await page.locator('[data-index]').evaluateAll(nodes => nodes
          .map(node => node.innerText.split('\n').map(value => value.trim()).filter(Boolean))
          .filter(parts => parts.some(value => value === 'See analytics') && parts.some(value => value.startsWith('#')))
          .map(parts => {
            const tagAt = parts.findIndex(value => value.startsWith('#'));
            const postsAt = parts.indexOf('Posts');
            const viewsAt = parts.indexOf('Views');
            return {
              rank: Number(parts[0]),
              tag: parts[tagAt].slice(1),
              category: tagAt >= 0 && parts[tagAt + 1] !== parts[postsAt - 1] ? parts[tagAt + 1] : null,
              posts: postsAt > 0 ? parts[postsAt - 1] : null,
              views: viewsAt > 0 ? parts[viewsAt - 1] : null,
            };
          }).filter(row => row.tag && Number.isFinite(row.rank)));
        let added = 0;
        for (const row of rows) {
          const key = `${row.rank}:${row.tag.toLowerCase()}`;
          if (!found.has(key)) { found.set(key, row); added++; }
        }
        idle = added ? 0 : idle + 1;
        if (idle >= idleScrolls) break;
        await page.evaluate(() => {
          window.scrollTo(0, document.body.scrollHeight);
          for (const node of document.querySelectorAll('main, [class*="table" i], [class*="list" i]')) {
            if (node.scrollHeight > node.clientHeight) node.scrollTop = node.scrollHeight;
          }
        });
        await page.mouse.wheel(0, 1800);
        await page.waitForTimeout(1000);
      }
      const allRows = [...found.values()].sort((a, b) => a.rank - b.rank);
      const rows = Number.isFinite(limit) ? allRows.slice(0, limit) : allRows;
      output.push({ region, countryCode, lang: source.lang || 'en', tags: rows.map(row => row.tag), rows, discoveredAt: new Date().toISOString(), url });
      console.log(`${region}: ${rows.map(row => `#${row.tag} (${row.posts} posts, ${row.views} views)`).join(', ') || 'khong co du lieu'}`);
    } catch (error) {
      console.error(`${region}: Creative Center error: ${error.message}`);
    }
  }
  // Unsupported region codes silently fall back to the same default market.
  // Group by the exact top-3 signature and keep only the real/default region.
  const groups = new Map();
  for (const result of output) {
    const signature = result.rows.map(row => `${row.tag}|${row.posts}|${row.views}`).join(';;').toLowerCase();
    if (!groups.has(signature)) groups.set(signature, []);
    groups.get(signature).push(result);
  }
  const filtered = [];
  for (const group of groups.values()) {
    if (group.length === 1) { filtered.push(group[0]); continue; }
    const keep = group.find(result => result.region === 'US') || group[0];
    filtered.push(keep);
    console.log(`Bo ${group.length - 1} region fallback trung ${keep.region}: ${group.filter(item => item !== keep).map(item => item.region).join(', ')}`);
  }
  await writeFile(path.join(root, 'discovered-sources.json'), JSON.stringify(filtered, null, 2));
} finally {
  await context.close();
  await browser.close();
}
