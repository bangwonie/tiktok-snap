import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const id = process.argv[2];
if (!/^\d+$/.test(id || '')) throw new Error('Use: node probe-api.mjs <video-id>');
const tag = String(process.argv[3] || '').replace(/^#/, '');

const root = path.dirname(fileURLToPath(import.meta.url));
let browser;
try {
  browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
} catch {
  const candidates = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].filter(Boolean);
  const executable = candidates.find(candidate => existsSync(candidate));
  if (!executable) throw new Error('Google Chrome is unavailable.');
  spawn(executable, ['--remote-debugging-port=9222', `--user-data-dir=${path.join(root, '.chrome-profile')}`, '--no-first-run'],
    { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 500));
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9222'); break; } catch { /* starting */ }
  }
  if (!browser) throw new Error('Chrome debug port did not start.');
}
const context = browser.contexts()[0];
if (!context) throw new Error('Chrome debug context is unavailable.');

const videoUrl = `https://www.tiktok.com/@x/video/${id}`;
const endpoints = [
  `https://www.tiktok.com/api/item/detail/?itemId=${id}`,
  `https://www.tiktok.com/oembed?url=${encodeURIComponent(videoUrl)}`,
];

try {
  for (const endpoint of endpoints) {
    const started = Date.now();
    try {
      const response = await context.request.get(endpoint, { timeout: 20_000, failOnStatusCode: false });
      const text = await response.text();
      const result = {
        endpoint: new URL(endpoint).pathname,
        http: response.status(),
        type: response.headers()['content-type'] || '',
        bytes: Buffer.byteLength(text),
        milliseconds: Date.now() - started,
      };
      try {
        const body = JSON.parse(text);
        const item = body.itemInfo?.itemStruct || body.itemInfo?.item_struct;
        Object.assign(result, {
          statusCode: body.statusCode ?? body.status_code ?? null,
          hasItem: !!item,
          hasMediaUrl: !!(item?.video?.playAddr || item?.video?.downloadAddr),
        });
      } catch { result.preview = text.slice(0, 80).replace(/\s+/g, ' '); }
      console.log(JSON.stringify(result));
    } catch (error) {
      console.log(JSON.stringify({ endpoint: new URL(endpoint).pathname, error: error.message, milliseconds: Date.now() - started }));
    }
  }
  if (tag) {
    const page = await context.newPage();
    const feedResult = new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), 20_000);
      page.on('response', async response => {
        if (new URL(response.url()).pathname !== '/api/challenge/item_list/') return;
        try {
          const body = await response.json();
          const item = body.itemList?.find(row => row.id === id);
          if (!item) return;
          clearTimeout(timer);
          resolve({ item, responseUrl: response.url() });
        } catch { /* another response may contain the item */ }
      });
    });
    const started = Date.now();
    await page.goto(`https://www.tiktok.com/tag/${encodeURIComponent(tag)}?lang=en-US`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {});
    const found = await feedResult;
    const media = found?.item?.video?.playAddr || found?.item?.video?.downloadAddr;
    const mediaUrl = typeof media === 'string' ? media : media?.urlList?.[0];
    const result = {
      endpoint: '/api/challenge/item_list/',
      found: !!found,
      hasMediaUrl: !!mediaUrl,
      milliseconds: Date.now() - started,
    };
    if (mediaUrl) {
      const mediaStarted = Date.now();
      const response = await context.request.get(mediaUrl, {
        headers: { referer: videoUrl, range: 'bytes=0-1023' }, timeout: 20_000, failOnStatusCode: false,
      });
      const bytes = await response.body();
      Object.assign(result, {
        mediaHttp: response.status(),
        mediaBytes: bytes.length,
        mediaType: response.headers()['content-type'] || '',
        mediaMilliseconds: Date.now() - mediaStarted,
        mp4Header: bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp',
      });
    }
    console.log(JSON.stringify(result));
    await page.close();
  }
} finally {
  await browser.close();
}
