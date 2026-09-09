import { open } from 'node:fs/promises';
import path from 'node:path';

export async function isMp4(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const header = Buffer.alloc(12);
    const { bytesRead } = await handle.read(header, 0, 12, 0);
    return bytesRead === 12 && header.toString('ascii', 4, 8) === 'ftyp';
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  } finally { await handle?.close(); }
}

export async function isComplete(folder) {
  return isMp4(path.join(folder, 'video-original.mp4'));
}
