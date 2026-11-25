import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { shouldTransformFile, transformSource } from './i18n-plugin.mjs';

const root = new URL('../..', import.meta.url).pathname;
const keys = new Set();

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { walk(path); continue; }
    const id = path.replaceAll('\\', '/');
    if (!shouldTransformFile(id)) continue;
    const code = readFileSync(path, 'utf8');
    for (const key of transformSource(code, path).keys) keys.add(key);
  }
}

walk(join(root, 'app/src'));

const extra = [
  'app/src', 'desktop/src',
];
function walkExtra(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules' || name === '__tests__') continue;
    if (statSync(path).isDirectory()) { walkExtra(path); continue; }
    if (!/\.(mjs|ts|tsx)$/.test(name) || /\.(test|spec)\./.test(name)) continue;
    const code = readFileSync(path, 'utf8');
    for (const match of code.matchAll(/\bt\(\s*(['"`])([\s\S]*?)\1/g)) keys.add(match[2]);
    for (const match of code.matchAll(/fail\(\s*'[^']+'\s*,\s*'([^'\\]*(?:\\.[^'\\]*)*)'/g)) keys.add(match[1]);
    for (const match of code.matchAll(/fail\(\s*'[^']+'\s*,\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g)) keys.add(match[1]);
  }
}
for (const dir of extra) walkExtra(join(root, dir));

const list = [...keys].filter(Boolean).sort((a, b) => a.localeCompare(b));
console.log(list.join('\n'));
console.error(`keys: ${list.length}`);
