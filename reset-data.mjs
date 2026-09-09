import { rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(path.dirname(fileURLToPath(import.meta.url)));
const targets = ['archive', 'discovered-sources.json'].map(name => path.join(root, name));
for (const target of targets) {
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to remove a path outside the project: ${target}`);
  }
}

for (const target of targets) await rm(target, { recursive: true, force: true });
console.log(`Cleared crawler data under ${root}`);
