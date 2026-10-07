// Images and pending image commands exceed localStorage's small synchronous quota.
let database: Promise<IDBDatabase> | undefined;
function open() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('ghost-ui-assets', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = undefined; reject(new Error('아바타 저장 공간을 열 수 없습니다. 브라우저 저장 권한을 확인해 주세요.')); };
  });
}
export const assetStorage = {
  async getItem(key: string): Promise<string | null> {
    const db = await open();
    return new Promise((resolve, reject) => { const req = db.transaction('records').objectStore('records').get(key); req.onsuccess = () => resolve(req.result ?? null); req.onerror = () => reject(req.error); });
  },
  async setItem(key: string, value: string) {
    const db = await open();
    return new Promise<void>((resolve, reject) => { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(value, key); tx.oncomplete = () => resolve(); tx.onerror = () => reject(new Error('저장 공간이 부족하거나 저장 권한이 없습니다.')); tx.onabort = () => reject(new Error('저장이 중단됐습니다. 다시 시도해 주세요.')); });
  },
};
