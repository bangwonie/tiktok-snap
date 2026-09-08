import { spawn } from 'node:child_process';
import { access, rename, rm, open, copyFile, readdir } from 'node:fs/promises';
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
const disposable = name => ['video.mp4', 'video-h264.mp4', 'video-compatible.tmp.mp4', 'metadata.json', 'snapshots.jsonl', 'complete.json', 'channel.json'].includes(name) || /^video.*\.(part|ytdl)$/.test(name);
export async function finalizeVideo(folder) {
  const final = path.join(folder, 'video-original.mp4');
  const temporary = path.join(folder, 'video-finalizing.tmp.mp4');
  const lockPath = path.join(folder, '.finalize.lock');
  const lock = await open(lockPath, 'wx');
  try {
    let source, info;
    // Prefer an already compatible copy, but validate it before removing anything.
    const candidates = [];
    for (const name of ['video-original.mp4', 'video.mp4', 'video-h264.mp4']) {
      const file = path.join(folder, name);
      if (!await exists(file)) continue;
      try { candidates.push({ file, info: await probe(file) }); } catch { /* another copy may be intact */ }
    }
    const selected = candidates.find(c => compatible(c.info)) || candidates[0];
    if (!selected) throw new Error('No readable video; files retained');
    ({ file: source, info } = selected);
    if (compatible(info)) {
      if (source !== final) await copyFile(source, temporary);
    } else {
      const prefix = ['-hide_banner', '-v', 'error', '-y', '-i', source, '-map', '0:v:0', '-map', '0:a?'];
      const suffix = ['-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', temporary];
      try {
        await runMedia('ffmpeg', [...prefix, '-c:v', 'h264_nvenc', '-preset', 'p4', '-cq', '20', '-b:v', '0', ...suffix]);
      } catch {
        await runMedia('ffmpeg', [...prefix, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '4', ...suffix]);
      }
    }
    const candidate = source === final && compatible(info) ? final : temporary;
    const after = await probe(candidate);
    if (!compatible(after) || !Number.isFinite(Number(after.format.duration)) || Math.abs(Number(after.format.duration) - Number(info.format.duration)) > 1) throw new Error('Video failed validation; files retained');
    await runMedia('ffmpeg', ['-hide_banner', '-v', 'error', '-xerror', '-i', candidate, '-f', 'null', '-']);
    if (candidate !== final) await rename(temporary, final);
    let removed = 0;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.isFile() && disposable(entry.name)) { await rm(path.join(folder, entry.name)); removed++; }
    }
    return { converted: !compatible(info), removed };
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
