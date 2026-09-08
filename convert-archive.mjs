import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { access } from 'node:fs/promises';
import { finalizeVideo } from './media-compat.mjs';
import { listVideos } from './archive-layout.mjs';
const archive = path.join(path.dirname(fileURLToPath(import.meta.url)), 'archive');
let converted = 0, cleaned = 0, removed = 0, failed = 0, missing = 0;
for (const folder of await listVideos(archive)) {
  if (!(await Promise.all(['video.mp4','video-original.mp4','video-h264.mp4'].map(name=>access(path.join(folder,name)).then(()=>true,()=>false)))).some(Boolean)) { missing++; continue; }
  try {
    const result = await finalizeVideo(folder);
    converted += Number(result.converted); removed += result.removed; cleaned++;
    console.log(`[${cleaned}] OK ${path.basename(folder)}${result.converted ? ' converted' : ''}`);
  } catch (error) { failed++; console.error(`${path.basename(folder)}: ${error.message}`); }
}
console.log(JSON.stringify({ converted, cleaned, removed, failed, missing }));
if (failed) process.exitCode = 1;
