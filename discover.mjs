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
const limit = Math.max(1, Number(cc.topPerRegion) || 3);
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
      // Public rows are available without login. "View more" can redirect to login,
      // so only scroll the public table and never click it.
      for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 900); await page.waitForTimeout(900); }
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      const rows = await page.locator('[data-index]').evaluateAll((nodes, max) => nodes
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
        })
        .filter(row => row.tag && Number.isFinite(row.rank))
        .sort((a, b) => a.rank - b.rank)
        .slice(0, max), limit);
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
