import { readdir, readFile, mkdir, writeFile, rename, access } from 'node:fs/promises';
import path from 'node:path';

export function channelFolder(archive, username) {
  if (typeof username !== 'string' || !username.trim()) throw new Error('Missing channel username');
  return path.join(archive, '@' + encodeURIComponent(username.trim().toLowerCase()));
}
export function videoFolder(archive, username, id) {
  if (!/^\d+$/.test(id)) throw new Error('Invalid video ID');
  return path.join(channelFolder(archive, username), id);
}
export async function listVideos(archive) {
  const folders = [];
  for (const entry of await readdir(archive, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const folder = path.join(archive, entry.name);
    if (/^\d+$/.test(entry.name)) folders.push(folder);
    else if (entry.name.startsWith('@')) {
      for (const video of await readdir(folder, { withFileTypes: true })) {
        if (video.isDirectory() && /^\d+$/.test(video.name)) folders.push(path.join(folder, video.name));
      }
    }
  }
  return folders;
}
export async function saveChannel(folder, channel) {
  await mkdir(folder, { recursive: true });
  let previous = {};
  try { previous = JSON.parse(await readFile(path.join(folder, 'channel.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const incomingIsNewer = !previous.capturedAt || String(channel.capturedAt || '') >= previous.capturedAt;
  const [older, newer] = incomingIsNewer ? [previous, channel] : [channel, previous];
  const merged = { ...older, ...Object.fromEntries(Object.entries(newer).filter(([, value]) => value != null)) };
  for (const [name, text] of [['channel.json', JSON.stringify(merged, null, 2)], ['bio.txt', merged.bio ?? '']]) {
    await writeFile(path.join(folder, name + '.tmp'), text);
    await rename(path.join(folder, name + '.tmp'), path.join(folder, name));
  }
}
export async function migrateArchive(archive) {
  let moved = 0;
  for (const source of await listVideos(archive)) {
    if (path.dirname(source) !== archive) continue;
    const entries = await readdir(source);
    if (entries.some(name => name.endsWith('.convert.lock'))) throw new Error(`Conversion still locked: ${source}`);
    let metadata = {}, channel = {};
    for (const name of ['metadata.json', 'channel.json']) {
      try {
        const data = JSON.parse(await readFile(path.join(source, name), 'utf8'));
        if (name === 'metadata.json') metadata = data; else channel = data;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const username = channel.username || metadata.author?.username;
    if (!username) throw new Error(`Cannot identify channel: ${source}`);
    const destination = videoFolder(archive, username, path.basename(source));
    const resolvedRoot = path.resolve(archive) + path.sep;
    for (const target of [source, destination]) {
      if (!path.resolve(target).startsWith(resolvedRoot)) throw new Error('Archive path escapes root');
    }
    if (await access(destination).then(() => true, () => false)) throw new Error(`Destination exists: ${destination}`);
    await saveChannel(path.dirname(destination), { ...metadata.author, ...channel, username });
    await rename(source, destination);
    moved++;
  }
  return moved;
}
