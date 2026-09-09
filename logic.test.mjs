import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeSources } from './source-logic.mjs';
import { isMp4, isComplete } from './archive-logic.mjs';
import { vietnamReason, excludedSource } from './content-filter.mjs';
import { crawlLinks } from './crawl-logic.mjs';
import { CrawlQueue, compactFeedItem, parseFeed, matchesTag, discoverFeed, unavailableVideoReason } from './feed-queue.mjs';
import { acquireFinalizeLock, compatible } from './media-compat.mjs';
import { migrateArchive, listVideos, videoFolder, saveChannel } from './archive-layout.mjs';
import { createLimiter } from './concurrency.mjs';
import { channelMetadata } from './channel-metadata.mjs';

test('channel metadata keeps detailed public profile fields without raw feed data', () => {
  const metadata = channelMetadata({
    author: {
      id: '10', secUid: 'sec-10', uniqueId: 'creator', nickname: 'Creator', signature: 'Bio',
      verified: true, privateAccount: false, avatarThumb: 'https://cdn/avatar.jpg',
      commentSetting: 0, duetSetting: 1, stitchSetting: 2, downloadSetting: 0, openFavorite: true,
    },
    stats: { followerCount: 42, videoCount: 7 },
    tag: 'trend', region: 'US', language: 'en-US', capturedAt: '2026-09-09T00:00:00.000Z',
  });
  assert.equal(metadata.username, 'creator');
  assert.equal(metadata.verified, true);
  assert.equal(metadata.privateAccount, false);
  assert.equal(metadata.avatar.thumb, 'https://cdn/avatar.jpg');
  assert.deepEqual(metadata.settings, { comments: 0, duet: 1, stitch: 2, downloads: 0, favoritesOpen: true });
  assert.deepEqual(metadata.stats, { followerCount: 42, videoCount: 7 });
  assert.deepEqual(metadata.discoveredFrom, { tag: 'trend', region: 'US', language: 'en-US' });
});

test('concurrency limiter never exceeds its configured capacity', async () => {
  const run = createLimiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(Array.from({ length: 6 }, (_, index) => run(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2 + index));
    active--;
  })));
  assert.equal(peak, 2);
  assert.equal(active, 0);
});

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

test('finalizer recovers a lock left by a dead process', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'tiktok-finalize-lock-'));
  const lockPath = path.join(folder, '.finalize.lock');
  try {
    await writeFile(lockPath, JSON.stringify({ pid: 2147483647, createdAt: '2026-01-01T00:00:00.000Z' }));
    const lock = await acquireFinalizeLock(lockPath);
    const owner = JSON.parse(await (await import('node:fs/promises')).readFile(lockPath, 'utf8'));
    assert.equal(owner.pid, process.pid);
    await lock.close();
  } finally {
    await rm(lockPath, { force: true });
    const { rmdir } = await import('node:fs/promises');
    await rmdir(folder);
  }
});

test('feed requires valid pagination and rejects errors instead of reporting exhaustion', () => {
  assert.throws(() => parseFeed({ statusCode: 102, itemList: [], hasMore: false }));
  assert.throws(() => parseFeed({ itemList: [] }));
  assert.throws(() => parseFeed({ itemList: [], hasMore: true }));
  assert.equal(parseFeed({ itemList: [], hasMore: false }).more, false);
});

test('feed excludes removed placeholders but keeps playable video rows', () => {
  assert.equal(unavailableVideoReason({ video: { duration: 0, width: 0, height: 0 } }), 'video-unavailable');
  assert.equal(unavailableVideoReason({ video: { duration: 12, playAddr: { urlList: ['https://cdn/video.mp4'] } } }), null);
});

test('opening an older queue retires cached unavailable video placeholders', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'tiktok-queue-upgrade-'));
  let queue;
  try {
    queue = await CrawlQueue.open(folder, 'upgrade', 'US');
    queue.data.jobs.old = { id: '1', status: 'failed', item: { video: { duration: 0, width: 0, height: 0 } } };
    await queue.save();
    queue = await CrawlQueue.open(folder, 'upgrade', 'US');
    assert.equal(queue.data.jobs.old.status, 'excluded');
    assert.equal(queue.data.jobs.old.reason, 'video-unavailable');
    assert.equal(queue.data.jobs.old.item, undefined);
  } finally {
    if (queue) await rm(queue.file, { force: true });
    const { rmdir } = await import('node:fs/promises');
    await rmdir(path.join(folder, 'queues'));
    await rmdir(folder);
  }
});

test('queued state writes stay valid under rapid concurrent save requests', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'tiktok-queue-writes-'));
  let queue;
  try {
    queue = await CrawlQueue.open(folder, 'writes', 'US');
    const saves = [];
    for (let index = 1; index <= 40; index++) {
      queue.data.sequence = index;
      saves.push(queue.save());
    }
    await Promise.all(saves);
    queue = await CrawlQueue.open(folder, 'writes', 'US');
    assert.equal(queue.data.sequence, 40);
  } finally {
    if (queue) await rm(queue.file, { force: true });
    const { rmdir } = await import('node:fs/promises');
    await rmdir(path.join(folder, 'queues'));
    await rmdir(folder);
  }
});

test('stalled feed uses the configured sweep depth and remains retriable', async () => {
  let scrolls = 0;
  const page = {
    mouse: { wheel: async () => {} },
    keyboard: { press: async () => {} },
    on() {}, off() {},
    goto: async () => {},
    waitForTimeout: async () => {},
    evaluate: async () => { scrolls++; },
  };
  const queue = { data: { sources: {} }, save: async () => {} };
  await discoverFeed({ page, queue, source: 'tag:sweep', url: 'https://www.tiktok.com/tag/sweep',
    gate: async () => {}, stopped: () => false, maxIdle: 7, cursorRetries: 0 });
  assert.equal(scrolls, 7);
  assert.equal(queue.data.sources['tag:sweep'].status, 'retry');
  assert.equal(queue.data.sources['tag:sweep'].idleAttempts, 7);
});

test('feed resumes a saved cursor and stops only on hasMore=false', async () => {
  let listener;
  let fetched;
  const response = (cursor, hasMore, requestUrl) => ({
    url: () => requestUrl,
    json: async () => ({ statusCode: 0, itemList: [], cursor, hasMore }),
  });
  const page = {
    mouse: { wheel: async () => {} }, keyboard: { press: async () => {} },
    on: (_event, callback) => { listener = callback; }, off: () => {},
    goto: async () => { listener(response('30', true, 'https://www.tiktok.com/api/challenge/item_list/?cursor=0')); },
    waitForTimeout: async () => {},
    evaluate: async (_callback, value) => {
      if (typeof value !== 'string') return;
      fetched = value;
      listener(response('60', false, value));
    },
  };
  const queue = {
    data: { tag: 'sweep', jobs: {}, authors: {}, sources: { 'tag:sweep': { cursor: '30', hasMore: true, status: 'retry' } } },
    ingest: () => 0,
    save: async () => {},
  };
  await discoverFeed({ page, queue, source: 'tag:sweep', url: 'https://www.tiktok.com/tag/sweep',
    gate: async () => {}, stopped: () => false, maxIdle: 3, cursorRetries: 4 });
  assert.equal(new URL(fetched).searchParams.get('cursor'), '30');
  assert.equal(queue.data.sources['tag:sweep'].cursor, '60');
  assert.equal(queue.data.sources['tag:sweep'].status, 'exhausted');
});

test('profile page budget remains retriable and keeps its latest cursor', async () => {
  let listener;
  let cursor = 0;
  const page = {
    mouse: { wheel: async () => {} }, keyboard: { press: async () => {} },
    on: (_event, callback) => { listener = callback; }, off: () => {},
    goto: async () => listener({
      url: () => 'https://www.tiktok.com/api/post/item_list/?cursor=0',
      json: async () => ({ statusCode: 0, itemList: [], cursor: String(++cursor), hasMore: true }),
    }),
    waitForTimeout: async () => {},
    evaluate: async (_callback, value) => {
      if (typeof value !== 'string') return;
      listener({
        url: () => value,
        json: async () => ({ statusCode: 0, itemList: [], cursor: String(++cursor), hasMore: true }),
      });
    },
  };
  const queue = {
    data: { tag: 'sweep', jobs: {}, authors: {}, sources: {} },
    ingest: () => 0,
    save: async () => {},
  };
  let capacityChecks = 0;
  await discoverFeed({ page, queue, source: 'user:large', url: 'https://www.tiktok.com/@large', profile: true,
    gate: async () => {}, stopped: () => false, maxPages: 8, maxNoAddPages: 3,
    beforeNextPage: async () => { capacityChecks++; } });
  assert.equal(queue.data.sources['user:large'].status, 'retry');
  assert.equal(queue.data.sources['user:large'].retryReason, 'no-new-ids-budget');
  assert.equal(queue.data.sources['user:large'].cursor, '3');
  assert.equal(queue.data.sources['user:large'].pagesThisPass, 3);
  assert.equal(capacityChecks, 2);
});

test('Super Sweep accepts every profile video and queue survives restart without duplicate jobs', async () => {
  assert.equal(matchesTag({ desc: '#catsup' }, 'cats'), false);
  const folder = await mkdtemp(path.join(os.tmpdir(), 'tiktok-queue-test-'));
  let queue;
  try {
    queue = await CrawlQueue.open(folder, 'cats', 'US');
    const item = { id: '123', author: { uniqueId: 'cat' }, video: { playAddr: 'https://cdn/video.mp4' }, textExtra: [{ hashtagName: 'cats' }] };
    queue.ingest([item, item, { ...item, id: '124', textExtra: [] }], 'user:cat', true);
    await queue.save();
    queue = await CrawlQueue.open(folder, 'cats', 'US');
    assert.equal(Object.keys(queue.data.jobs).length, 2);
    assert.equal(queue.data.jobs['123'].status, 'pending');
    assert.equal(queue.data.jobs['124'].status, 'pending');
    assert.deepEqual(queue.data.jobs['123'].item, compactFeedItem(item));
    await queue.mark('123', 'done');
    assert.equal(queue.data.jobs['123'].item, undefined);
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

test('an ID is complete only when video-original.mp4 is a valid MP4', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'tiktok-snap-test-'));
  try {
    assert.equal(await isComplete(folder), false);
    await writeFile(path.join(folder, 'video.mp4'), '<html>error</html>');
    assert.equal(await isComplete(folder), false);
    await writeFile(path.join(folder, 'video-original.mp4'), '<html>error</html>');
    assert.equal(await isComplete(folder), false);
    await writeFile(path.join(folder, 'video-original.mp4'), Buffer.from([0, 0, 0, 12, 102, 116, 121, 112, 105, 115, 111, 109]));
    assert.equal(await isMp4(path.join(folder, 'video-original.mp4')), true);
    assert.equal(await isComplete(folder), true);
  } finally {
    for (const file of ['video.mp4', 'video-original.mp4']) {
      await rm(path.join(folder, file), { force: true });
    }
    const { rmdir } = await import('node:fs/promises');
    await rmdir(folder);
  }
});
