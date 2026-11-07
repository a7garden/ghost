import { cp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ghost = resolve(app, '../..');
const destination = join(app, 'src-tauri/resources');

/** Run a build step and fail the packaging when it fails. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} 실패 (${result.status})`);
}

// The Ghost host is one Bun process: it serves the API and the web UI. The
// desktop shell bundles that binary and the built UI, and nothing else.
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'host'), { recursive: true });
await mkdir(join(destination, 'ui'), { recursive: true });

const host = join(destination, 'host/ghost');
run('bun', ['build', 'apps/ghost-host/src/main.ts', '--compile', '--outfile', host], ghost);
await chmod(host, 0o755);

run('bun', ['run', 'build'], join(ghost, 'apps/ghost-ui'));
await cp(join(ghost, 'apps/ghost-ui/dist'), join(destination, 'ui'), { recursive: true });

const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
await writeFile(
  join(destination, 'payload.json'),
  `${JSON.stringify(
    {
      version: 'ghost-desktop-payload/2',
      ghost_features: 'host-ui',
      host_sha256: await sha(host),
      ui_index_sha256: await sha(join(destination, 'ui/index.html')),
      credentials_included: false,
    },
    null,
    2,
  )}\n`,
);
console.log('Ghost 호스트와 UI를 준비했습니다. 자격 증명과 사용자 데이터는 포함하지 않습니다.');
