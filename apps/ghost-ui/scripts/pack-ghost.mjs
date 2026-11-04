import { createPrivateKey, createPublicKey } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { packPackage, verifyPackage } from '../server/package-format.mjs';

const [input, output, keyPath] = process.argv.slice(2);
if (!input || !output?.endsWith('.ghost') || !keyPath) {
  throw new Error('Usage: node scripts/pack-ghost.mjs PACKAGE_DIR OUTPUT.ghost ED25519_PRIVATE_KEY.pem');
}
const metadata = JSON.parse(await readFile(join(input, 'package.json'), 'utf8'));
const payload = new Map();
async function walk(directory) {
  for (const entry of (await readdir(join(input, directory), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) payload.set(path, await readFile(join(input, path)));
    else throw new Error(`Unsupported file: ${path}`);
  }
}
await walk('agent');
if ((await readdir(input)).includes('ui')) await walk('ui');
const key = createPrivateKey(await readFile(keyPath));
const bytes = packPackage(metadata, payload, key);
const pkg = verifyPackage(bytes, new Map([[metadata.id.split('/')[0], createPublicKey(key).export({ type: 'spki', format: 'pem' })]]));
await writeFile(output, bytes, { flag: 'wx' });
console.log(`${pkg.metadata.id} ${pkg.metadata.version} ${pkg.metadata.digest}`);
