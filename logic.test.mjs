import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeSources } from './source-logic.mjs';
import { isMp4, isComplete } from './archive-logic.mjs';
import { vietnamReason, excludedSource } from './content-filter.mjs';
import { crawlLinks } from './crawl-logic.mjs';
import { CrawlQueue, parseFeed, matchesTag } from './feed-queue.mjs';
import { compatible } from './media-compat.mjs';
import { migrateArchive, listVideos, videoFolder, saveChannel } from './archive-layout.mjs';

test('channel migration preserves video files and is safe to repeat', async () => {
  const { mkdir, readFile, rmdir } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'snap-layout-'));
  const legacy = path.join(root, '123');
  const target = videoFolder(root, 'Example', '123');
  try {
    await mkdir(legacy);
    await writeFile(path.join(legacy, 'channel.json'), JSON.stringify({ username: 'Example', bio: 'hello', capturedAt: '2026-09-08' }));
    await writeFile(path.join(legacy, 'video.mp4'), 'original bytes');
    assert.equal(await migrateArchive(root), 1);
    assert.equal(await readFile(path.join(target, 'video.mp4'), 'utf8'), 'original bytes');
    assert.deepEqual(await listVideos(root), [target]);
    assert.equal(await readFile(path.join(root, '@example', 'bio.txt'), 'utf8'), 'hello');
    await saveChannel(path.dirname(target), { username: 'Example', bio: null, capturedAt: '2026-09-09' });
    assert.equal(await readFile(path.join(root, '@example', 'bio.txt'), 'utf8'), 'hello');
    assert.equal(await migrateArchive(root), 0);
  } finally {
    for (const folder of [target, legacy]) {
      for (const name of ['channel.json', 'video.mp4']) await rm(path.join(folder, name), { force: true });
      await rmdir(folder).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    for (const name of ['channel.json', 'bio.txt']) await rm(path.join(root, '@example', name), { force: true });
    await rmdir(path.join(root, '@example'));
    await rmdir(root);
  }
});

test('compatibility requires H264 8-bit 420 and AAC audio', () => {
  const video = { codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p' };
  assert.equal(compatible({ streams: [video] }), true);
  assert.equal(compatible({ streams: [video, { codec_type: 'audio', codec_name: 'aac' }] }), true);
  assert.equal(compatible({ streams: [{ ...video, codec_name: 'hevc' }] }), false);
  assert.equal(compatible({ streams: [{ ...video, pix_fmt: 'yuv420p10le' }] }), false);
  assert.equal(compatible({ streams: [video, { codec_type: 'audio', codec_name: 'opus' }] }), false);
});

test('feed requires valid pagination and rejects errors instead of reporting exhaustion', () => {
  assert.throws(() => parseFeed({ statusCode: 102, itemList: [], hasMore: false }));
  assert.throws(() => parseFeed({ itemList: [] }));
  assert.throws(() => parseFeed({ itemList: [], hasMore: true }));
  assert.equal(parseFeed({ itemList: [], hasMore: false }).more, false);
});

test('profile enrichment requires exact hashtag and queue survives restart without duplicate jobs', async () => {
  assert.equal(matchesTag({ desc: '#catsup' }, 'cats'), false);
  const folder = await mkdtemp(path.join(os.tmpdir(), 'tiktok-queue-test-'));
  let queue;
  try {
    queue = await CrawlQueue.open(folder, 'cats', 'US');
    const item = { id: '123', author: { uniqueId: 'cat' }, video: {}, textExtra: [{ hashtagName: 'cats' }] };
    queue.ingest([item, item, { ...item, id: '124', textExtra: [] }], 'user:cat', true);
    await queue.save();
    queue = await CrawlQueue.open(folder, 'cats', 'US');
    assert.equal(Object.keys(queue.data.jobs).length, 1);
    assert.equal(queue.data.jobs['123'].status, 'pending');
    await queue.mark('123', 'done');
    queue.ingest([item], 'tag:cats');
    assert.equal(queue.data.jobs['123'].status, 'done');
  } finally {
    if (queue) await rm(queue.file, { force: true });
    const { rmdir } = await import('node:fs/promises');
    await rmdir(path.join(folder, 'queues'));
    await rmdir(folder);
  }
});

test('crawl continues past 30 screens, deduplicates IDs, and stops on idle', async () => {
  let screen = 0;
  const urls = [];
  for await (const url of crawlLinks({
    read: async () => screen < 40 ? [
      `https://www.tiktok.com/@a/video/${screen + 1}?lang=en`,
      `https://www.tiktok.com/@b/video/${screen + 1}`,
    ] : ['https://www.tiktok.com/@a/video/40'],
    scroll: async () => { screen++; }, maxIdle: 3,
  })) urls.push(url);
  assert.equal(urls.length, 40);
  assert.equal(urls[0], 'https://www.tiktok.com/@a/video/1');
  assert.equal(screen, 42);
});

test('crawl downloads a screen before requesting the next and can stop early', async () => {
  let scrolls = 0;
  for await (const url of crawlLinks({
    read: async () => ['https://www.tiktok.com/@a/video/1'],
    scroll: async () => { scrolls++; },
  })) { assert.ok(url.endsWith('/1')); break; }
  assert.equal(scrolls, 0);
});

test('exclude Vietnam sources including discovery and CLI language signals', () => {
  assert.deepEqual(mergeSources([{ region: 'VN', tags: ['music'] }], [
    { region: 'US', tags: ['tiktokvn', 'music'] },
    { region: 'GLOBAL', lang: 'vi-VN', tags: ['food'] },
  ]), [{ tag: 'music', region: 'US', lang: 'en' }]);
  assert.equal(excludedSource({ region: 'vn' }), true);
});

test('exclude Vietnamese content before download, retain unrelated languages', () => {
  assert.equal(vietnamReason({ region: 'VN' }), 'region-vn');
  assert.equal(vietnamReason({ textLanguage: 'vi' }), 'language-vi');
  assert.equal(vietnamReason({ desc: 'Một ngày vui vẻ' }), 'vietnamese-content-signal');
  assert.equal(vietnamReason({ desc: '#xuhuong #tiktokvn' }), 'vietnamese-content-signal');
  assert.equal(vietnamReason({ author: { signature: 'Việt Nam' } }), 'vietnamese-content-signal');
  assert.equal(vietnamReason({ desc: 'Hello world, olá, café, mañana' }), null);
  assert.equal(vietnamReason({}), null);
});

test('trending source wins over duplicate configured hashtag', () => {
  assert.deepEqual(mergeSources(
    [{ region: 'US', lang: 'en-US', tags: [' #Viral '] }],
    [{ region: 'GLOBAL', tags: ['viral', '', null, 'music'] }],
  ), [
    { tag: 'Viral', region: 'US', lang: 'en-US' },
    { tag: 'music', region: 'GLOBAL', lang: 'en' },
  ]);
});

test('fixed sources work without discovery', () => {
  assert.deepEqual(mergeSources([], [{ tags: ['fyp'] }]), [
    { tag: 'fyp', region: 'GLOBAL', lang: 'en' },
  ]);
});

test('completion marker cannot hide missing or invalid video and channel', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'tiktok-snap-test-'));
  try {
    await writeFile(path.join(folder, 'complete.json'), '{}');
    await writeFile(path.join(folder, 'metadata.json'), '{}');
    await writeFile(path.join(folder, 'channel.json'), '{}');
    assert.equal(await isComplete(folder), false);
    await writeFile(path.join(folder, 'video.mp4'), '<html>error</html>');
    assert.equal(await isComplete(folder), false);
    await writeFile(path.join(folder, 'video.mp4'), Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]));
    assert.equal(await isMp4(path.join(folder, 'video.mp4')), true);
    assert.equal(await isComplete(folder), true);
    await rm(path.join(folder, 'channel.json'));
    assert.equal(await isComplete(folder), false);
  } finally {
    for (const file of ['complete.json', 'metadata.json', 'channel.json', 'video.mp4']) {
      await rm(path.join(folder, file), { force: true });
    }
    const { rmdir } = await import('node:fs/promises');
    await rmdir(folder);
  }
});
