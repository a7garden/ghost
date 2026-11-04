import type { LifetimeStorage } from "./types";

const lifetimeOutboxPrefix = "ghost:lifetime:";
const maximumLifetimeOutboxes = 1024;

export function createBrowserLifetimeStorage(storage?: Storage): LifetimeStorage {
  // 기본값을 호출 시점에 해석한다. 모듈 평가와 무관하게 비브라우저·저장 차단
  // 환경에서도 안전하게 호출할 수 있다.
  const backend = storage ?? window.localStorage;
  return {
    getItem: key => backend.getItem(key),
    setItem: (key, value) => { backend.setItem(key, value); },
    listKeys() {
      const keys: string[] = [];
      for (let index = 0; index < backend.length; index += 1) {
        const key = backend.key(index);
        if (!key?.startsWith(lifetimeOutboxPrefix) || !key.endsWith(":outbox")) continue;
        if (keys.length === maximumLifetimeOutboxes) throw new Error("Lifetime outbox namespace contains too many journals to inspect safely.");
        keys.push(key);
      }
      return keys.sort();
    },
  };
}
