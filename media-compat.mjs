import { spawn } from 'node:child_process';
import { access, rename, rm, open, copyFile, readdir, readFile } from 'node:fs/promises';
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
const finalName = 'video-original.mp4';
const internal = name => name === '.finalize.lock' || name === 'video-finalizing.tmp.mp4';

export async function acquireFinalizeLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const lock = await open(lockPath, 'wx');
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return lock;
    } catch (error) {
      if (error.code !== 'EEXIST' || attempt) throw error;
      let owner;
      try { owner = JSON.parse(await readFile(lockPath, 'utf8')); } catch { owner = null; }
      let alive = false;
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); alive = true; } catch { /* stale owner */ }
      }
      if (alive) throw error;
      await rm(lockPath, { force: true });
    }
  }
}

export async function finalizeVideo(folder) {
  const final = path.join(folder, finalName);
  const temporary = path.join(folder, 'video-finalizing.tmp.mp4');
  const lockPath = path.join(folder, '.finalize.lock');
  const lock = await acquireFinalizeLock(lockPath);
  try {
    let source, info;
    // Probe and fully decode every candidate before choosing it. A damaged H.264
    // file can still have a valid MP4 header and must not hide a clean source.
    const candidates = [];
    for (const name of ['video-original.mp4', 'video.mp4', 'video-h264.mp4']) {
      const file = path.join(folder, name);
      if (!await exists(file)) continue;
      try {
        const candidateInfo = await probe(file);
        await runMedia('ffmpeg', ['-hide_banner', '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-']);
        if (candidateInfo.streams.some(stream => stream.codec_type === 'video' && !stream.disposition?.attached_pic)) {
          candidates.push({ file, info: candidateInfo });
        }
      } catch { /* another copy may be intact */ }
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
    // A byte-for-byte copy of a fully decoded compatible source does not need
    // a second decode. Transcoded output still gets a complete decode check.
    if (candidate !== source && !compatible(info)) {
      await runMedia('ffmpeg', ['-hide_banner', '-v', 'error', '-xerror', '-i', candidate, '-f', 'null', '-']);
    }
    if (candidate !== final) await rename(temporary, final);
    let removed = 0;
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (entry.name !== finalName && !internal(entry.name)) {
        await rm(path.join(folder, entry.name), { recursive: entry.isDirectory(), force: true });
        removed++;
      }
    }
    return { converted: !compatible(info), removed };
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
