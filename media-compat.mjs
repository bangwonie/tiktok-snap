import { spawn } from 'node:child_process';
import { access, rename, rm, open } from 'node:fs/promises';
import path from 'node:path';

export function runMedia(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let output = '', errors = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { errors = (errors + bytes).slice(-3000); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`${command} exit ${code}: ${errors}`)));
  });
}
export async function probe(file) {
  return JSON.parse(await runMedia('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]));
}
export function compatible(info) {
  const videos = info.streams.filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic);
  return videos.length === 1 && videos[0].codec_name === 'h264' && videos[0].pix_fmt === 'yuv420p' &&
    info.streams.filter(s => s.codec_type === 'audio').every(s => s.codec_name === 'aac');
}
const exists = file => access(file).then(() => true, () => false);
export async function ensureCompatible(file) {
  const lockPath = file + '.convert.lock';
  const lock = await open(lockPath, 'wx');
  const temporary = path.join(path.dirname(file), 'video-compatible.tmp.mp4');
  const original = path.join(path.dirname(file), 'video-original.mp4');
  try {
    // Recover a conversion interrupted between the two renames.
    if (!await exists(file) && await exists(original)) {
      const { copyFile } = await import('node:fs/promises');
      await copyFile(original, file);
    }
    const before = await probe(file);
    if (compatible(before)) return false;
    if (await exists(original)) throw new Error(`Backup already exists: ${original}; refusing to overwrite`);
    await runMedia('ffmpeg', ['-hide_banner', '-v', 'error', '-y', '-i', file,
      '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-threads', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', temporary]);
    const after = await probe(temporary);
    if (!compatible(after) || Math.abs(Number(after.format.duration) - Number(before.format.duration)) > 1) throw new Error('Converted video failed validation');
    await runMedia('ffmpeg', ['-hide_banner', '-v', 'error', '-i', temporary, '-f', 'null', '-']);
    await rename(file, original);
    try { await rename(temporary, file); }
    catch (error) { await rename(original, file); throw error; }
    return true;
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
