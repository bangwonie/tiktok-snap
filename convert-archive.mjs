import { readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureCompatible } from './media-compat.mjs';
import { listVideos } from './archive-layout.mjs';
const archive = path.join(path.dirname(fileURLToPath(import.meta.url)), 'archive');
let converted = 0, unchanged = 0, failed = 0;
for (const folder of await listVideos(archive)) {
  if (!await access(path.join(folder, 'complete.json')).then(() => true, () => false)) continue;
  try {
    if (await ensureCompatible(path.join(folder, 'video.mp4'))) { converted++; console.log(`H264: ${path.basename(folder)}`); }
    else unchanged++;
  } catch (error) { failed++; console.error(`${path.basename(folder)}: ${error.message}`); }
}
console.log(JSON.stringify({ converted, unchanged, failed }));
if (failed) process.exitCode = 1;
