/** Tiny IndexedDB promise wrapper (no external idb dependency). */

export interface IDBPDatabase {
  get(store: string, key: IDBValidKey): Promise<any>;
  put(store: string, value: any): Promise<void>;
  delete(store: string, key: IDBValidKey): Promise<void>;
  getAllFromIndex(store: string, index: string, query?: IDBValidKey): Promise<any[]>;
  objectStoreNames: DOMStringList;
  createObjectStore(name: string, opts?: IDBObjectStoreParameters): IDBObjectStore;
}

type UpgradeFn = (db: IDBDatabase) => void;

export function openDB(
  name: string,
  version: number,
  opts: { upgrade: UpgradeFn },
): Promise<IDBPDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => opts.upgrade(req.result);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(wrap(req.result));
  });
}

function wrap(db: IDBDatabase): IDBPDatabase {
  return {
    objectStoreNames: db.objectStoreNames,
    createObjectStore: (n, o) => db.createObjectStore(n, o),
    get(store, key) {
      return tx(db, store, 'readonly', (s) => reqToPromise(s.get(key)));
    },
    put(store, value) {
      return tx(db, store, 'readwrite', (s) => reqToPromise(s.put(value))).then(() => undefined);
    },
    delete(store, key) {
      return tx(db, store, 'readwrite', (s) => reqToPromise(s.delete(key))).then(() => undefined);
    },
    getAllFromIndex(store, index, query) {
      return tx(db, store, 'readonly', (s) => {
        const idx = s.index(index);
        return reqToPromise(query !== undefined ? idx.getAll(query) : idx.getAll());
      });
    },
  };
}

function tx<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    fn(s).then(resolve, reject);
  });
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
