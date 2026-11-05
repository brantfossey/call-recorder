// Speakerphone and table mics need the room, including sound leaving the handset.
// Echo cancellation removes that speaker sound. Noise suppression and auto gain
// reshape it. All three stay off unless the listener turns them on.
export const DEFAULT_PROCESSING = Object.freeze({
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
});

// Short enough that a crash loses only a moment, long enough that a two-hour
// take is a few thousand small writes instead of one fragile blob.
export const CHUNK_MS = 2000;

const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

export function extensionForMime(mime) {
  const type = (mime || '').toLowerCase();
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('wav')) return 'wav';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  return 'webm';
}

export async function openMicrophone(processing) {
  const preferred = {
    echoCancellation: processing.echoCancellation,
    noiseSuppression: processing.noiseSuppression,
    autoGainControl: processing.autoGainControl,
    voiceIsolation: false,
    channelCount: { ideal: 1 },
    // Older Android builds still read these names for the same processing stack.
    googEchoCancellation: processing.echoCancellation,
    googNoiseSuppression: processing.noiseSuppression,
    googAutoGainControl: processing.autoGainControl,
    googHighpassFilter: false,
  };
  const standard = {
    echoCancellation: { ideal: processing.echoCancellation },
    noiseSuppression: { ideal: processing.noiseSuppression },
    autoGainControl: { ideal: processing.autoGainControl },
    channelCount: { ideal: 1 },
  };
  const stop = new Set([
    'NotAllowedError',
    'PermissionDeniedError',
    'SecurityError',
    'NotFoundError',
    'DevicesNotFoundError',
    'AbortError',
  ]);
  let lastError = null;
  for (const audio of [preferred, standard, true]) {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio, video: false });
    } catch (error) {
      lastError = error;
      if (stop.has(error?.name)) throw error;
    }
  }
  throw lastError || new Error('Could not open the microphone');
}

export function acquireRecordingLock() {
  if (!navigator.locks?.request) return Promise.resolve(() => {});
  return new Promise((resolve) => {
    let settled = false;
    navigator.locks.request('call-recorder-recording', { ifAvailable: true }, (lock) => {
      if (!lock) {
        settled = true;
        resolve(null);
        return undefined;
      }
      return new Promise((release) => {
        settled = true;
        resolve(() => release());
      });
    }).catch(() => {
      if (!settled) resolve(() => {});
    });
  });
}

function createMediaRecorder(stream, mimeType) {
  const withRate = {};
  if (mimeType) withRate.mimeType = mimeType;
  withRate.audioBitsPerSecond = 64000;
  try {
    return new MediaRecorder(stream, withRate);
  } catch {
    if (mimeType) return new MediaRecorder(stream, { mimeType });
    return new MediaRecorder(stream);
  }
}

export class RecordingSession {
  constructor(stream, onLevel) {
    this.stream = stream;
    this.onLevel = onLevel || (() => {});
    this.mimeType = pickMimeType();
    this.recorder = null;
    this.context = null;
    this.queue = Promise.resolve();
    this.seq = 0;
    this.elapsedMs = 0;
    this.segmentStarted = 0;
    this.clockOn = false;
    this.chunkError = null;
    this.fatalNotified = false;
    this.onFatal = null;
    this.onChunk = null;
    this.meterOn = false;
    this.meterFrame = 0;
    this.stopPromise = null;
  }

  prime() {
    this.recorder = createMediaRecorder(this.stream, this.mimeType);
    this.mimeType = this.recorder.mimeType || this.mimeType || 'audio/webm';
    this.recorder.addEventListener('dataavailable', (event) => this.handleData(event));
    this.recorder.addEventListener('error', (event) => {
      this.notifyFatal(event.error || new Error('Recording failed'));
    });
    this.startMeter();
  }

  start(onChunk) {
    if (!this.recorder) this.prime();
    this.onChunk = onChunk;
    this.startClock();
    this.recorder.start(CHUNK_MS);
  }

  pause() {
    if (!this.recorder || this.recorder.state !== 'recording') return;
    this.recorder.pause();
    this.pauseClock();
  }

  resume() {
    if (!this.recorder || this.recorder.state !== 'paused') return;
    this.recorder.resume();
    this.startClock();
  }

  requestData() {
    if (this.recorder && this.recorder.state === 'recording') {
      try { this.recorder.requestData(); } catch { /* page is going away */ }
    }
  }

  elapsed() {
    if (!this.clockOn) return this.elapsedMs;
    return this.elapsedMs + (performance.now() - this.segmentStarted);
  }

  startClock() {
    if (this.clockOn) return;
    this.segmentStarted = performance.now();
    this.clockOn = true;
  }

  pauseClock() {
    if (!this.clockOn) return;
    this.elapsedMs += performance.now() - this.segmentStarted;
    this.clockOn = false;
  }

  handleData(event) {
    const blob = event.data;
    if (!blob || blob.size === 0 || !this.onChunk) return;
    const seq = this.seq;
    this.seq += 1;
    const elapsed = Math.round(this.elapsed());
    this.queue = this.queue
      .then(() => this.onChunk(blob, seq, elapsed))
      .catch((error) => this.notifyFatal(error));
  }

  notifyFatal(error) {
    if (!this.chunkError) this.chunkError = error || new Error('Recording failed');
    if (this.fatalNotified) return;
    this.fatalNotified = true;
    queueMicrotask(() => this.onFatal?.(this.chunkError));
  }

  stop() {
    if (!this.stopPromise) this.stopPromise = this.finishStop();
    return this.stopPromise;
  }

  async finishStop() {
    const recorder = this.recorder;
    if (recorder && recorder.state !== 'inactive') {
      await new Promise((resolve) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        recorder.addEventListener('stop', done, { once: true });
        try {
          if (recorder.state === 'paused') {
            this.startClock();
            recorder.resume();
          }
        } catch { /* stop still flushes the take */ }
        try {
          recorder.stop();
        } catch {
          done();
        }
        setTimeout(done, 8000);
      });
    }
    this.pauseClock();
    await new Promise((resolve) => setTimeout(resolve, 40));
    try {
      await this.queue;
    } catch (error) {
      if (!this.chunkError) this.chunkError = error;
    }
    if (this.chunkError) throw this.chunkError;
  }

  startMeter() {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const context = new AudioCtx();
    this.context = context;
    // MediaRecorder is the only consumer of the recorded stream. A clone feeds
    // the meter so the level keeps moving for the whole take.
    try {
      this.meterStream = this.stream.clone();
    } catch {
      this.meterStream = this.stream;
    }
    const source = context.createMediaStreamSource(this.meterStream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    // Leave the analyser off the speakers. A silent connection to the
    // destination lets Chrome stop pulling samples, and playing the mic
    // back would howl.
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let display = 0;
    const tick = () => {
      if (!this.meterOn) return;
      if (context.state === 'suspended') context.resume().catch(() => {});
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i += 1) {
        const value = (data[i] - 128) / 128;
        sum += value * value;
      }
      const instant = Math.min(100, Math.sqrt(Math.sqrt(sum / data.length)) * 100);
      display = Math.max(instant, display * 0.9);
      this.onLevel(display);
      this.meterFrame = requestAnimationFrame(tick);
    };
    this.meterOn = true;
    context.resume().then(tick).catch(() => {});
  }

  destroy() {
    this.meterOn = false;
    if (this.meterFrame) cancelAnimationFrame(this.meterFrame);
    try {
      if (this.meterStream && this.meterStream !== this.stream) {
        this.meterStream.getTracks().forEach((track) => track.stop());
      }
    } catch { /* already stopped */ }
    try {
      this.stream.getTracks().forEach((track) => track.stop());
    } catch { /* already stopped */ }
    if (this.context && this.context.state !== 'closed') {
      this.context.close().catch(() => {});
    }
  }
}

const ID_SEGMENT = 0x18538067n;
const ID_INFO = 0x1549a966n;
const ID_TIMECODE_SCALE = 0x2ad7b1n;
const ID_DURATION = 0x4489n;
const ID_SEEK_HEAD = 0x114d9b74n;
const ID_CUES = 0x1c53bb6bn;
const ID_CLUSTER = 0x1f43b675n;

// Chrome's MediaRecorder writes a WebM file with no Duration element, so players
// report an endless clip. The duration we tracked is written into the Info
// header. Clusters are not rewritten, and a SeekHead (file offsets) blocks the
// insert so we never shift bytes we cannot patch.
export async function withWebmDuration(blob, durationMs) {
  const type = blob.type || '';
  if (!type.includes('webm') && !type.includes('matroska')) return blob;
  if (!Number.isFinite(durationMs) || durationMs < 1) return blob;
  try {
    const scan = Math.min(blob.size, 256 * 1024);
    const header = new Uint8Array(await blob.slice(0, scan).arrayBuffer());
    const patched = patchWebmDuration(header, durationMs);
    if (!patched) return blob;
    return new Blob([patched, blob.slice(scan)], { type: type || 'audio/webm' });
  } catch {
    return blob;
  }
}

function readVint(bytes, offset, asId) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return null;
  let width = 1;
  let mask = 0x80;
  while ((first & mask) === 0) {
    width += 1;
    mask >>= 1;
    if (width > 8) return null;
  }
  if (offset + width > bytes.length) return null;
  let value = 0n;
  for (let i = 0; i < width; i += 1) value = (value << 8n) + BigInt(bytes[offset + i]);
  if (asId) return { width, value, unknown: false };
  const marker = 1n << BigInt(7 * width);
  value -= marker;
  const unknown = value === (1n << BigInt(7 * width)) - 1n;
  return { width, value, unknown };
}

function readId(bytes, offset) {
  return readVint(bytes, offset, true);
}

function elementAt(bytes, offset) {
  const id = readId(bytes, offset);
  if (!id) return null;
  const size = readVint(bytes, offset + id.width, false);
  if (!size) return null;
  const header = id.width + size.width;
  const start = offset + header;
  if (!size.unknown && start + Number(size.value) > bytes.length + 1) {
    // Size claims more than we scanned. Still usable if the header itself fits.
  }
  return { id: id.value, idWidth: id.width, size, start, offset, header };
}

function patchWebmDuration(bytes, durationMs) {
  let offset = 0;
  let segment = null;
  while (offset + 2 < bytes.length) {
    const element = elementAt(bytes, offset);
    if (!element) return null;
    if (element.id === ID_SEGMENT) {
      segment = element;
      break;
    }
    if (element.size.unknown) return null;
    offset = element.start + Number(element.size.value);
  }
  if (!segment) return null;

  let cursor = segment.start;
  const limit = bytes.length;
  let info = null;
  let blocked = false;
  while (cursor + 2 < limit) {
    const element = elementAt(bytes, cursor);
    if (!element) break;
    if (element.id === ID_CLUSTER) break;
    if (element.id === ID_SEEK_HEAD || element.id === ID_CUES) blocked = true;
    if (element.id === ID_INFO && !element.size.unknown) info = element;
    if (element.size.unknown) break;
    const next = element.start + Number(element.size.value);
    if (next <= cursor) break;
    cursor = next;
  }
  if (!info) return null;
  if (info.start + Number(info.size.value) > bytes.length) return null;

  const payloadStart = info.start;
  const payloadEnd = info.start + Number(info.size.value);
  const payload = bytes.subarray(payloadStart, payloadEnd);
  let scale = 1000000;
  let duration = null;
  let insertAt = 0;
  let child = 0;
  while (child + 2 < payload.length) {
    const element = elementAt(payload, child);
    if (!element || element.size.unknown) break;
    const end = element.start + Number(element.size.value);
    if (end > payload.length) break;
    if (element.id === ID_TIMECODE_SCALE) {
      scale = Number(readUint(payload, element.start, Number(element.size.value))) || 1000000;
      insertAt = end;
    }
    if (element.id === ID_DURATION) duration = { element, at: child };
    child = end;
  }

  const durationValue = durationMs * (1000000 / scale);
  if (duration) {
    const { element } = duration;
    const width = Number(element.size.value);
    if (!writeFloat(bytes, payloadStart + element.start, width, durationValue)) return null;
    return bytes;
  }
  if (blocked) return null;

  const durationBytes = floatElement(durationValue);
  const newPayload = concat([
    payload.subarray(0, insertAt),
    durationBytes,
    payload.subarray(insertAt),
  ]);
  const idBytes = bytes.subarray(info.offset, info.offset + info.idWidth);
  const sizeBytes = encodeSize(BigInt(newPayload.length));
  const infoBytes = concat([idBytes, sizeBytes, newPayload]);
  return concat([
    bytes.subarray(0, info.offset),
    infoBytes,
    bytes.subarray(payloadEnd),
  ]);
}

function readUint(bytes, start, length) {
  let value = 0n;
  for (let i = 0; i < length; i += 1) value = (value << 8n) + BigInt(bytes[start + i]);
  return value;
}

function writeFloat(bytes, offset, width, value) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (width === 4) view.setFloat32(offset, value, false);
  else if (width === 8) view.setFloat64(offset, value, false);
  else return false;
  return true;
}

function floatElement(value) {
  const bytes = new Uint8Array(11);
  bytes[0] = 0x44;
  bytes[1] = 0x89;
  bytes[2] = 0x88;
  new DataView(bytes.buffer).setFloat64(3, value, false);
  return bytes;
}

function encodeSize(value) {
  let width = 1;
  let max = (1n << 7n) - 1n;
  while (value >= max) {
    width += 1;
    if (width > 8) throw new Error('WebM size is too large');
    max = (1n << BigInt(7 * width)) - 1n;
  }
  const out = new Uint8Array(width);
  let rest = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  out[0] |= 1 << (8 - width);
  return out;
}

function concat(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}
