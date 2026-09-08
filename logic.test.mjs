import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergeSources } from './source-logic.mjs';
import { isMp4, isComplete } from './archive-logic.mjs';
import { vietnamReason, excludedSource } from './content-filter.mjs';

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
