import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPortableNodeRuntime } from './node-runtime.mjs';

const systemDylibs = [
  '/System/Library/Frameworks/Security.framework/Versions/A/Security',
  '/usr/lib/libSystem.B.dylib',
];

test('accepts an executable Node runtime linked only to macOS system libraries', () => {
  assert.equal(assertPortableNodeRuntime(process.execPath, { platform: 'darwin', inspectDylibs: () => systemDylibs }), process.version);
});

test('rejects Homebrew and other machine-local dynamic libraries', () => {
  assert.throws(
    () => assertPortableNodeRuntime(process.execPath, {
      platform: 'darwin', inspectDylibs: () => [...systemDylibs, '/opt/homebrew/opt/libuv/lib/libuv.1.dylib'],
    }),
    /GHOST_NODE_BINARY.*standalone Node binary/s,
  );
});

test('does not require macOS dependency inspection on other host platforms', () => {
  assert.equal(assertPortableNodeRuntime(process.execPath, {
    platform: 'linux', inspectDylibs: () => { throw new Error('must not run'); },
  }), process.version);
});
