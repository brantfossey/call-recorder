const DB_NAME = 'call-recorder';
const DB_VERSION = 1;

let dbPromise = null;

export function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('recordings', { keyPath: 'id' });
      const chunks = db.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true });
      chunks.createIndex('byRecording', 'recordingId', { unique: false });
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('Could not open storage'));
    };
  });
  return dbPromise;
}

function finish(request, map) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(map ? map(request.result) : request.result);
    request.onerror = () => reject(request.error || new Error('Storage request failed'));
  });
}

export function putRecording(record) {
  return openDb().then((db) => finish(
    db.transaction('recordings', 'readwrite').objectStore('recordings').put(record),
  ).then(() => record));
}

export function getRecording(id) {
  return openDb().then((db) => finish(
    db.transaction('recordings', 'readonly').objectStore('recordings').get(id),
  ));
}

export function listAll() {
  return openDb().then((db) => finish(
    db.transaction('recordings', 'readonly').objectStore('recordings').getAll(),
  ));
}

export function listRecordings() {
  return listAll().then((rows) => rows
    .filter((row) => row.status !== 'recording')
    .sort((a, b) => b.createdAt - a.createdAt));
}

export function updateRecording(id, patch) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction('recordings', 'readwrite');
    const store = tx.objectStore('recordings');
    const request = store.get(id);
    request.onsuccess = () => {
      if (!request.result) {
        reject(new Error('Recording not found'));
        return;
      }
      const next = { ...request.result, ...patch, updatedAt: Date.now() };
      store.put(next);
      tx.oncomplete = () => resolve(next);
    };
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Save aborted'));
  }));
}

export function appendChunk(recordingId, blob, seq, durationMs) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      reject(error || new Error('Save aborted'));
    };
    const tx = db.transaction(['chunks', 'recordings'], 'readwrite');
    tx.onerror = () => fail(tx.error);
    tx.onabort = () => fail(tx.error);
    tx.objectStore('chunks').add({
      recordingId,
      seq,
      blob,
      savedAt: Date.now(),
    });
    const getRequest = tx.objectStore('recordings').get(recordingId);
    getRequest.onerror = () => fail(getRequest.error);
    getRequest.onsuccess = () => {
      const record = getRequest.result;
      if (!record) {
        try { tx.abort(); } catch { /* already failing */ }
        fail(new Error('Recording not found'));
        return;
      }
      record.bytes += blob.size;
      record.chunkCount += 1;
      record.durationMs = Math.max(record.durationMs || 0, durationMs || 0);
      record.updatedAt = Date.now();
      tx.objectStore('recordings').put(record);
      tx.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(record);
      };
    };
  }));
}

export function getChunks(recordingId) {
  return openDb().then((db) => finish(
    db.transaction('chunks', 'readonly').objectStore('chunks').index('byRecording').getAll(recordingId),
    (rows) => rows.slice().sort((a, b) => a.seq - b.seq || a.id - b.id),
  ));
}

export function deleteRecording(id) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(['recordings', 'chunks'], 'readwrite');
    tx.objectStore('recordings').delete(id);
    const request = tx.objectStore('chunks').index('byRecording').openCursor(IDBKeyRange.only(id));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      cursor.delete();
      cursor.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Delete aborted'));
  }));
}
