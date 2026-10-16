// IndexedDB 저장소: notes(메타) / pdfs(원본 PDF Blob) / ink(페이지별 필기 데이터)
const DB_NAME = 'godnote';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('notes')) db.createObjectStore('notes', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pdfs')) db.createObjectStore('pdfs');
      if (!db.objectStoreNames.contains('ink')) db.createObjectStore('ink');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let result;
    const r = fn(s);
    if (r) r.onsuccess = () => { result = r.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const db = {
  allNotes: () => tx('notes', 'readonly', s => s.getAll()),
  getNote: id => tx('notes', 'readonly', s => s.get(id)),
  putNote: note => tx('notes', 'readwrite', s => s.put(note)),
  getPdf: id => tx('pdfs', 'readonly', s => s.get(id)),
  putPdf: (id, blob) => tx('pdfs', 'readwrite', s => s.put(blob, id)),
  delPdf: id => tx('pdfs', 'readwrite', s => s.delete(id)),
  getInk: id => tx('ink', 'readonly', s => s.get(id)).then(v => v || {}),
  putInk: (id, ink) => tx('ink', 'readwrite', s => s.put(ink, id)),
  delInk: id => tx('ink', 'readwrite', s => s.delete(id)),
};

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
