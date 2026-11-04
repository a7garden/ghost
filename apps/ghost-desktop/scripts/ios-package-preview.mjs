import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = fileURLToPath(new URL('../', import.meta.url));
const cli = join(desktop, 'node_modules/@tauri-apps/cli/tauri.js');
const apple = join(desktop, 'src-tauri/gen/apple');
const spec = join(apple, 'project.yml');
const [device, ...extra] = process.argv.slice(2);
if (!device || extra.length) throw new Error('Usage: npm run ios:preview -- DEVICE_NAME');
function run(program, args, cwd = desktop) {
  const result = spawnSync(program, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!existsSync(spec)) run(process.execPath, [cli, 'ios', 'init', '--ci']);

// Generated projects can contain a bare Node script name that Xcode cannot
// resolve from gen/apple. Keep the generated project disposable.
const template = readFileSync(spec, 'utf8');
const fixed = template.replace('node tauri ios xcode-script', 'node ../../../node_modules/@tauri-apps/cli/tauri.js ios xcode-script');
if (fixed !== template) {
  writeFileSync(spec, fixed);
  run('xcodegen', ['generate'], apple);
}
run(process.execPath, [cli, 'ios', 'dev', '--no-watch', '--no-dev-server', device]);
