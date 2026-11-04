import { execFileSync } from 'node:child_process';

function inspectMachODylibs(executable) {
  const output = execFileSync('otool', ['-L', executable], { encoding: 'utf8' });
  return output.split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
}

export function assertPortableNodeRuntime(executable, { platform = process.platform, inspectDylibs = inspectMachODylibs } = {}) {
  let version;
  try {
    version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`The packaged Node runtime cannot execute: ${executable}`, { cause: error });
  }
  if (!/^v\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
    throw new Error(`The packaged Node runtime returned an invalid version: ${version || '(empty)'}`);
  }

  if (platform === 'darwin') {
    let dylibs;
    try {
      dylibs = inspectDylibs(executable);
    } catch (error) {
      throw new Error(`Could not inspect the packaged Node runtime dependencies: ${executable}`, { cause: error });
    }
    const external = dylibs.filter(path => !path.startsWith('/System/Library/') && !path.startsWith('/usr/lib/'));
    if (external.length) {
      const examples = external.slice(0, 8).map(path => `  ${path}`);
      if (external.length > examples.length) examples.push(`  …and ${external.length - examples.length} more`);
      throw new Error([
        `The packaged Node runtime depends on libraries outside macOS and will not run on another Mac: ${executable}`,
        ...examples,
        'Set GHOST_NODE_BINARY to the standalone Node binary from the official macOS distribution.',
      ].join('\n'));
    }
  }

  return version;
}
