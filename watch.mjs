import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeSources } from './source-logic.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(await readFile(path.join(root, 'watch.config.json'), 'utf8'));
const interval = Math.max(5, Number(config.intervalMinutes) || 60) * 60_000;
let firstRun = true;

function childProcess(script, args = []) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [script, ...args], { cwd: root, stdio: 'inherit' });
    child.on('error', error => { console.error(error.message); resolve(1); });
    child.on('exit', code => resolve(code ?? 1));
  });
}

async function cycleSources() {
  let discovered = [];
  if (config.creativeCenter?.enabled) {
    const code = await childProcess('discover.mjs');
    if (code) console.error('Creative Center discovery loi; dung danh sach nguon co dinh.');
    else {
      try { discovered = JSON.parse(await readFile(path.join(root, 'discovered-sources.json'), 'utf8')); }
      catch { console.error('Khong doc duoc ket qua discovery; dung nguon co dinh.'); }
    }
  }
  // Dynamic Creative Center rows take priority. A hashtag is crawled only once
  // even if it appears in several regions.
  return mergeSources(Array.isArray(discovered) ? discovered : [], config.sources);
}

function run(source) {
  return new Promise(resolve => {
    const args = ['collector.mjs', `--tag=${source.tag}`, `--region=${source.region}`, `--lang=${source.lang}`, `--limit=${config.limitPerTag ?? 'all'}`];
    if (!firstRun) args.push('--auto');
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    child.on('error', error => { console.error(error.message); resolve(1); });
    child.on('exit', code => resolve(code ?? 1));
  });
}

console.log(`Crawler lien tuc da bat; lap lai moi ${interval / 60_000} phut.`);
while (true) {
  const sources = await cycleSources();
  if (!sources.length) throw new Error('Khong co nguon thu thap trong config hoac Creative Center.');
  console.log(`Chu ky nay co ${sources.length} nguon tren ${new Set(sources.map(s => s.region)).size} khu vuc.`);
  for (const source of sources) {
    console.log(`\nBat dau ${source.region}/#${source.tag} luc ${new Date().toLocaleString()}`);
    const code = await run(source);
    firstRun = false;
    if (code) console.error(`${source.region}/#${source.tag} ket thuc voi ma loi ${code}; se thu lai o chu ky sau.`);
    await new Promise(resolve => setTimeout(resolve, 20_000));
  }
  console.log(`Cho den ${new Date(Date.now() + interval).toLocaleString()}...`);
  await new Promise(resolve => setTimeout(resolve, interval));
}
