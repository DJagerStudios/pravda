// A small IndexedDB store for the unlocked identity. Private keys are kept as
// non-extractable CryptoKey objects: this device can use them, but nothing,
// not even a script injected into the page, can export their bytes.

const DB = 'pravda';
const STORE = 'identity';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function idbGet(key) {
  try {
    return await run('readonly', (s) => s.get(key));
  } catch {
    return undefined;
  }
}

export async function idbPut(key, value) {
  try {
    await run('readwrite', (s) => s.put(value, key));
    return true;
  } catch {
    return false;
  }
}

export async function idbDelete(key) {
  try {
    await run('readwrite', (s) => s.delete(key));
  } catch {
    // Nothing stored, or storage unavailable: either way it is gone.
  }
}
