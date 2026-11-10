import { rmSync } from 'node:fs';
import { stopMockProvider } from './mock-provider';
import { readCleanupState } from './run-state';

/** Global teardown: only this run's metadata can identify its host and unique temporary root. */
export default async function globalTeardown(): Promise<void> {
  await stopMockProvider().catch(() => {});
  const cleanup = readCleanupState();
  if (cleanup?.hostPid) {
    try {
      process.kill(cleanup.hostPid, 'SIGTERM');
    } catch {
      // Already gone; nothing to clean.
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(cleanup.hostPid, 0);
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch {
        break;
      }
    }
    try {
      process.kill(cleanup.hostPid, 'SIGKILL');
    } catch {
      // Exited before the kill; fine.
    }
  }
  if (cleanup?.tempRoot) rmSync(cleanup.tempRoot, { recursive: true, force: true });
}
