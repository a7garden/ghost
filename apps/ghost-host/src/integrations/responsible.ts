import { dlopen, FFIType, ptr } from "bun:ffi";
import { join } from "node:path";
import { atomicWrite, releaseDirectoryOf } from "../update/storage.ts";

/**
 * macOS attributes a child's privacy (TCC) requests to its responsible process, which is the Host for
 * everything it starts. Chrome's bundled updater then appears as the Host trying to modify apps.
 * Re-executing a program with responsibility disclaimed (as Ghost Control does for PC control) makes it
 * answer for itself under its own signature.
 */
export function execResponsible(program: string, args: readonly string[]): never {
  const lib = dlopen("/usr/lib/libSystem.B.dylib", {
    posix_spawnattr_init: { args: [FFIType.ptr], returns: FFIType.i32 },
    posix_spawnattr_setflags: { args: [FFIType.ptr, FFIType.i16], returns: FFIType.i32 },
    responsibility_spawnattrs_setdisclaim: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
    posix_spawn: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  }).symbols;
  const cString = (value: string) => Buffer.from(`${value}\0`);
  // The buffers stay referenced until posix_spawn returns; on success it never does.
  const argvStrings = [program, ...args].map(cString);
  const envStrings = Object.entries(process.env).flatMap(([key, value]) => value === undefined ? [] : [cString(`${key}=${value}`)]);
  const table = (strings: Buffer[]) => {
    const pointers = new BigUint64Array(strings.length + 1);
    strings.forEach((string, index) => { pointers[index] = BigInt(ptr(string)); });
    return pointers;
  };
  const argv = table(argvStrings), envp = table(envStrings), path = cString(program);
  const attr = new BigUint64Array(1);
  const POSIX_SPAWN_SETEXEC = 0x40;
  let status = lib.posix_spawnattr_init(ptr(attr));
  if (status === 0) status = lib.posix_spawnattr_setflags(ptr(attr), POSIX_SPAWN_SETEXEC);
  if (status === 0) status = lib.responsibility_spawnattrs_setdisclaim(ptr(attr), 1);
  if (status === 0) status = lib.posix_spawn(null, ptr(path), null, ptr(attr), ptr(argv), ptr(envp));
  throw new Error(`could not run ${program} as its own responsible process (errno ${status})`);
}

const quoteSh = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/**
 * An executable path that starts `program` as its own responsible process, written into `directory`.
 * Only a release's compiled Host can re-execute itself for this; elsewhere `program` is returned as is.
 */
export function responsibleLauncher(directory: string, name: string, program: string): string {
  if (process.platform !== "darwin" || !releaseDirectoryOf(process.execPath)) return program;
  const path = join(directory, name);
  atomicWrite(path, `#!/bin/sh\nexec ${quoteSh(process.execPath)} exec-responsible ${quoteSh(program)} "$@"\n`, 0o700);
  return path;
}
