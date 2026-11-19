import { rmSync } from 'node:fs';
import { stopMockProvider } from './mock-provider';
import { readCleanupState } from './run-state';

/** Global teardown only touches this run's Hosts and unique temporary root. */
export default async function globalTeardown(): Promise<void> {
  await stopMockProvider().catch(() => {});
  const cleanup = readCleanupState();
  await Promise.all((cleanup?.hostPids ?? []).map(async pid => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already gone; nothing to clean.
    }
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise(resolve => setTimeout(resolve, 100));
      } catch {
        break;
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // Exited before the kill; fine.
    }
  }));
  if (cleanup?.tempRoot) rmSync(cleanup.tempRoot, { recursive: true, force: true });
}
