import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateArchive } from './archive-layout.mjs';
const archive = path.join(path.dirname(fileURLToPath(import.meta.url)), 'archive');
console.log(`Moved ${await migrateArchive(archive)} video folders into channel folders.`);
