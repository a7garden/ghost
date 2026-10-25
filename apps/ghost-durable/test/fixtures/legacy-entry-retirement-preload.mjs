import { registerHooks, syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import childProcess from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=process.env.GHOST_RETIRED_ENTRY_TRAP_ROOT;
if (!root) throw new Error('Retirement fixture root is missing.');
const writeMarker=fs.writeFileSync.bind(fs);
function forbid(kind) {
  writeMarker(join(root,'unexpected-entry-effect'),kind,{mode:0o600});
  throw new Error(`Retired entry crossed ${kind}.`);
}
function selected(value) {
  const path=value instanceof URL ? fileURLToPath(value) : String(value);
  return path===root || path.startsWith(`${root}/`);
}
for (const name of ['open','readFile','realpath','stat','lstat','mkdir','writeFile']) {
  const original=promises[name].bind(promises);
  promises[name]=(...args)=>{if(selected(args[0]))forbid(`filesystem:${name}`);return original(...args);};
}
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
  childProcess[name]=()=>forbid(`child:${name}`);
}
syncBuiltinESMExports();
globalThis.fetch=()=>forbid('network:fetch');
registerHooks({resolve(specifier,context,nextResolve){
  if (/@oh-my-pi\/|oh-my-pi|omp-gateway/u.test(specifier)) forbid('OMP package import');
  return nextResolve(specifier,context);
}});
