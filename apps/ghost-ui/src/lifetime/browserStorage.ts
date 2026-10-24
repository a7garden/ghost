import type { LifetimeStorage } from "./types";

const lifetimeOutboxPrefix = "ghost:lifetime:";
const maximumLifetimeOutboxes = 1024;

export function createBrowserLifetimeStorage(storage: Storage = window.localStorage): LifetimeStorage {
  return {
    getItem: key => storage.getItem(key),
    setItem: (key, value) => { storage.setItem(key, value); },
    listKeys() {
      const keys: string[] = [];
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (!key?.startsWith(lifetimeOutboxPrefix) || !key.endsWith(":outbox")) continue;
        if (keys.length === maximumLifetimeOutboxes) throw new Error("Lifetime outbox namespace contains too many journals to inspect safely.");
        keys.push(key);
      }
      return keys.sort();
    },
  };
}
