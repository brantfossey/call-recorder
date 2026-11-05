import {
  appendChunk,
  deleteRecording,
  getChunks,
  getRecording,
  listAll,
  listRecordings,
  putRecording,
  updateRecording,
} from './db.js';
import {
  CHUNK_MS,
  RecordingSession,
  acquireRecordingLock,
  extensionForMime,
  openMicrophone,
  withWebmDuration,
} from './media.js';

const SETTINGS_KEY = 'call-recorder-processing';

const els = {
  timer: document.querySelector('#timer'),
  meter: document.querySelector('#meter'),
  meterFill: document.querySelector('#meter-fill'),
  meterValue: document.querySelector('#meter-value'),
  statusText: document.querySelector('#status-text'),
  savedLine: document.querySelector('#saved-line'),
  alert: document.querySelector('#alert'),
  record: document.querySelector('#record'),
  pause: document.querySelector('#pause'),
  resume: document.querySelector('#resume'),
  stop: document.querySelector('#stop'),
  echo: document.querySelector('#opt-echo'),
  noise: document.querySelector('#opt-noise'),
  gain: document.querySelector('#opt-gain'),
  processing: document.querySelector('#processing'),
  settingsLock: document.querySelector('#settings-lock'),
  chunkNote: document.querySelector('#chunk-note'),
  applied: document.querySelector('#applied'),
  storage: document.querySelector('#storage'),
  empty: document.querySelector('#empty'),
  list: document.querySelector('#list'),
  libraryTitle: document.querySelector('#library-title'),
  install: document.querySelector('#install'),
  installHelp: document.querySelector('#install-help'),
  confirm: document.querySelector('#confirm'),
  confirmBody: document.querySelector('#confirm-body'),
};

const state = {
  mode: 'idle',
  session: null,
  releaseLock: null,
  recordingId: null,
  wakeLock: null,
  wakeOk: false,
  heard: false,
  quietSince: 0,
  bytes: 0,
  timer: 0,
  finishPromise: null,
  blobCache: null,
  activeUrl: null,
  activeId: null,
  installEvent: null,
};

init().catch((error) => {
  setAlert(storageMessage(error));
});

async function init() {
  if (!window.isSecureContext) {
    setAlert('Recording only works on a secure page. Open this app from its https address.');
  }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    els.record.disabled = true;
    setAlert('This browser cannot record audio. Open the page in Chrome.');
  }

  els.chunkNote.textContent = `Audio is saved on this phone every ${CHUNK_MS / 1000} seconds. If the page closes, reopen it and the recording is kept, except for those last few seconds.`;
  applySettings(loadSettings());
  [els.echo, els.noise, els.gain].forEach((input) => {
    input.addEventListener('change', () => saveSettings(readSettings()));
  });

  els.record.addEventListener('click', () => { startRecording(); });
  els.pause.addEventListener('click', pauseRecording);
  els.resume.addEventListener('click', resumeRecording);
  els.stop.addEventListener('click', () => { finishRecording(); });

  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('beforeunload', onBeforeUnload);
  window.addEventListener('pagehide', () => state.session?.requestData());

  bindInstall();
  const outcome = await recoverUnfinished();
  await renderList();
  refreshStorageNote();
  if (outcome.locked) setStatus('A recording is already running in another tab.');
  else if (outcome.recovered === 1) setStatus('Recovered an unfinished recording. The last few seconds may be missing.');
  else if (outcome.recovered > 1) setStatus(`Recovered ${outcome.recovered} unfinished recordings. The last few seconds may be missing.`);
  else setStatus('Ready to record.');
  registerWorker();
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return {
      echoCancellation: parsed.echoCancellation === true,
      noiseSuppression: parsed.noiseSuppression === true,
      autoGainControl: parsed.autoGainControl === true,
    };
  } catch {
    return { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function readSettings() {
  return {
    echoCancellation: els.echo.checked,
    noiseSuppression: els.noise.checked,
    autoGainControl: els.gain.checked,
  };
}

function applySettings(settings) {
  els.echo.checked = settings.echoCancellation;
  els.noise.checked = settings.noiseSuppression;
  els.gain.checked = settings.autoGainControl;
}

async function recoverUnfinished() {
  const release = await acquireRecordingLock();
  if (!release) return { locked: true, recovered: 0 };
  try {
    const rows = await listAll();
    let recovered = 0;
    for (const record of rows) {
      if (record.status !== 'recording') continue;
      if (!record.chunkCount) await deleteRecording(record.id);
      else {
        await updateRecording(record.id, { status: 'recovered' });
        recovered += 1;
      }
    }
    return { locked: false, recovered };
  } finally {
    release();
  }
}

async function startRecording() {
  if (state.mode !== 'idle') return;
  clearAlert();
  setMode('starting');
  setStatus('Starting microphone…');
  let release = null;
  let session = null;
  let createdId = null;
  try {
    release = await acquireRecordingLock();
    if (!release) {
      setMode('idle');
      setStatus('Ready to record.');
      setAlert('A recording is already running in another tab.');
      return;
    }
    const processing = readSettings();
    saveSettings(processing);
    const stream = await openMicrophone(processing);
    session = new RecordingSession(stream, onLevel);
    session.prime();
    const now = Date.now();
    const record = await putRecording({
      id: crypto.randomUUID(),
      name: defaultName(now),
      createdAt: now,
      updatedAt: now,
      durationMs: 0,
      mimeType: session.mimeType,
      extension: extensionForMime(session.mimeType),
      status: 'recording',
      bytes: 0,
      chunkCount: 0,
    });
    createdId = record.id;
    state.session = session;
    state.recordingId = record.id;
    state.releaseLock = release;
    state.bytes = 0;
    state.heard = false;
    state.quietSince = performance.now();
    release = null;
    session.onFatal = (error) => { finishRecording(error); };
    const track = stream.getAudioTracks()[0];
    if (track) {
      els.applied.hidden = false;
      els.applied.textContent = describeProcessing(processing, track.getSettings());
      track.addEventListener('ended', () => {
        if (state.recordingId === record.id && (state.mode === 'recording' || state.mode === 'paused')) {
          finishRecording(new Error('The microphone stopped.'));
        }
      });
    }
    session.start(async (blob, seq, elapsed) => {
      const updated = await appendChunk(record.id, blob, seq, elapsed);
      if (state.recordingId === record.id) {
        state.bytes = updated.bytes;
        updateSavedLine();
      }
    });
    renderTimer(0);
    setMode('recording');
    startTicking();
    state.wakeOk = await acquireWake();
    updateSavedLine();
    setStatus('Recording.');
    requestPersistence();
  } catch (error) {
    if (session) session.destroy();
    if (createdId) {
      try { await deleteRecording(createdId); } catch { /* nothing stored */ }
    }
    state.session = null;
    state.recordingId = null;
    if (release) release();
    if (state.releaseLock) {
      state.releaseLock();
      state.releaseLock = null;
    }
    setMode('idle');
    setStatus('Ready to record.');
    resetMeter();
    setAlert(micMessage(error));
  }
}

function pauseRecording() {
  if (state.mode !== 'recording' || !state.session) return;
  state.session.pause();
  setMode('paused');
  renderTimer(state.session.elapsed());
  updateSavedLine();
  setStatus('Paused.');
}

function resumeRecording() {
  if (state.mode !== 'paused' || !state.session) return;
  state.session.resume();
  setMode('recording');
  setStatus('Recording.');
}

function finishRecording(error) {
  if (state.finishPromise) return state.finishPromise;
  if (state.mode === 'idle' || state.mode === 'starting') return Promise.resolve();
  const session = state.session;
  const id = state.recordingId;
  setMode('stopping');
  stopTicking();
  setStatus('Saving…');
  state.finishPromise = (async () => {
    let problem = error || null;
    try {
      if (session) await session.stop();
    } catch (stopError) {
      problem = problem || stopError;
    }
    try { session?.destroy(); } catch { /* already closed */ }
    await releaseWake();
    let saved = null;
    try {
      const record = id ? await getRecording(id) : null;
      if (record && record.chunkCount > 0) {
        saved = await updateRecording(id, { status: problem ? 'recovered' : 'complete' });
      } else if (record) {
        await deleteRecording(id);
      }
    } catch (saveError) {
      problem = problem || saveError;
    }
    state.session = null;
    state.recordingId = null;
    state.bytes = 0;
    if (state.releaseLock) {
      state.releaseLock();
      state.releaseLock = null;
    }
    resetMeter();
    renderTimer(0);
    setMode('idle');
    els.savedLine.textContent = '';
    state.finishPromise = null;
    if (saved) {
      await renderList();
      document.querySelector(`[data-id="${saved.id}"] .play`)?.focus();
      setStatus(problem
        ? 'Recording stopped early. Saved audio is in the list.'
        : 'Recording saved.');
      if (problem) setAlert(problemMessage(problem));
    } else if (problem) {
      setStatus('Ready to record.');
      setAlert(problemMessage(problem));
    } else {
      setStatus('Nothing was captured.');
    }
    refreshStorageNote();
  })();
  return state.finishPromise;
}

function setMode(mode) {
  state.mode = mode;
  document.body.dataset.mode = mode;
  const starting = mode === 'starting';
  const stopping = mode === 'stopping';
  const live = mode === 'recording' || mode === 'paused';
  els.record.hidden = !(mode === 'idle' || starting);
  els.record.disabled = starting;
  els.record.textContent = starting ? 'Starting…' : 'Record';
  els.pause.hidden = mode !== 'recording';
  els.resume.hidden = mode !== 'paused';
  els.stop.hidden = !(live || stopping);
  els.stop.disabled = stopping;
  els.pause.disabled = false;
  els.resume.disabled = false;
  const lockSettings = starting || stopping || live;
  els.processing.disabled = lockSettings;
  els.settingsLock.hidden = !lockSettings;
  if (mode === 'idle') document.title = 'Call Recorder';
}

function startTicking() {
  stopTicking();
  state.timer = setInterval(() => {
    if (!state.session) return;
    renderTimer(state.session.elapsed());
    if (state.mode === 'recording') updateSavedLine();
  }, 200);
}

function stopTicking() {
  if (state.timer) clearInterval(state.timer);
  state.timer = 0;
}

function renderTimer(ms) {
  const text = formatClock(ms);
  els.timer.textContent = text;
  if (state.mode === 'recording') document.title = `● ${text} · Call Recorder`;
  else if (state.mode === 'paused') document.title = `Paused ${text} · Call Recorder`;
}

function onLevel(level) {
  const shown = Math.max(0, Math.min(100, Math.round(level)));
  els.meterFill.style.width = `${shown}%`;
  els.meterValue.textContent = `${shown}%`;
  els.meter.setAttribute('aria-valuenow', String(shown));
  els.meter.setAttribute('aria-valuetext', `${shown} percent`);
  if (shown > 8) state.heard = true;
}

function resetMeter() {
  onLevel(0);
  els.meter.setAttribute('aria-valuetext', 'No input yet');
}

function updateSavedLine() {
  const amount = formatBytes(state.bytes);
  const parts = [`${amount} saved on this phone.`];
  if (!state.wakeOk) parts.push('The screen may turn off; keep this page open.');
  if (state.mode === 'recording' && !state.heard && performance.now() - state.quietSince > 3000) {
    parts.push('No sound detected yet.');
  }
  const text = parts.join(' ');
  if (els.savedLine.textContent !== text) els.savedLine.textContent = text;
}

function describeProcessing(requested, actual) {
  const rows = [
    ['echoCancellation', 'echo cancellation'],
    ['noiseSuppression', 'noise suppression'],
    ['autoGainControl', 'auto gain'],
  ];
  const parts = rows.map(([key, label]) => {
    if (typeof actual[key] !== 'boolean') return `${label} not reported`;
    return `${label} ${actual[key] ? 'on' : 'off'}`;
  });
  let text = `This recording is using ${parts.join(', ')}.`;
  if (requested.echoCancellation === false && actual.echoCancellation === true) {
    text += ' This phone kept echo cancellation on, which can quiet a voice coming from the speaker.';
  }
  return text;
}

async function acquireWake() {
  if (!navigator.wakeLock?.request) return false;
  try {
    state.wakeLock = await navigator.wakeLock.request('screen');
    state.wakeLock.addEventListener('release', () => {
      state.wakeLock = null;
    });
    return true;
  } catch {
    return false;
  }
}

async function releaseWake() {
  try { await state.wakeLock?.release(); } catch { /* already released */ }
  state.wakeLock = null;
}

async function onVisible() {
  if (document.visibilityState !== 'visible') return;
  if (state.mode === 'recording' || state.mode === 'paused') {
    state.wakeOk = await acquireWake();
    try { await state.session?.context?.resume(); } catch { /* meter only */ }
    updateSavedLine();
  }
}

function onBeforeUnload(event) {
  if (state.mode === 'recording' || state.mode === 'paused' || state.mode === 'stopping') {
    event.preventDefault();
    event.returnValue = '';
  }
}

async function renderList() {
  const rows = await listRecordings();
  revokePlayback();
  els.list.replaceChildren(...rows.map(recordingItem));
  els.empty.hidden = rows.length > 0;
}

function recordingItem(record) {
  const item = document.createElement('li');
  item.className = 'recording';
  item.dataset.id = record.id;
  item.dataset.status = record.status;

  const name = document.createElement('input');
  name.className = 'name';
  name.type = 'text';
  name.maxLength = 120;
  name.value = record.name;
  name.setAttribute('aria-label', `Name for recording from ${formatWhen(record.createdAt)}`);
  name.autocomplete = 'off';
  name.spellcheck = true;
  name.enterKeyHint = 'done';
  let nameTimer = 0;
  const commit = () => {
    clearTimeout(nameTimer);
    commitName(record.id, name);
  };
  name.addEventListener('input', () => {
    clearTimeout(nameTimer);
    nameTimer = setTimeout(commit, 400);
  });
  name.addEventListener('change', commit);

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = `${formatWhen(record.createdAt)} · ${formatClock(record.durationMs)} · ${formatBytes(record.bytes)}`;

  const audio = document.createElement('audio');
  audio.controls = true;
  audio.preload = 'none';
  audio.hidden = true;

  const actions = document.createElement('div');
  actions.className = 'actions';
  const play = actionButton('Play', `Play ${record.name}`, () => onPlay(record, play, audio));
  play.classList.add('play');
  const download = actionButton('Download', `Download ${record.name}`, () => onDownload(record));
  download.classList.add('download');
  const share = actionButton('Share', `Share ${record.name}`, () => onShare(record));
  share.classList.add('share');
  const remove = actionButton('Delete', `Delete ${record.name}`, () => onDelete(record));
  remove.classList.add('delete');
  actions.append(play, download, share, remove);

  item.append(name, meta);
  if (record.status === 'recovered') {
    const note = document.createElement('p');
    note.className = 'recovered';
    note.textContent = 'Recovered after an interruption. The last few seconds may be missing.';
    item.append(note);
  }
  item.append(audio, actions);

  audio.addEventListener('play', () => syncPlay(play, audio, currentName(name, record)));
  audio.addEventListener('pause', () => syncPlay(play, audio, currentName(name, record)));
  audio.addEventListener('ended', () => syncPlay(play, audio, currentName(name, record)));
  return item;
}

function actionButton(text, label, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.addEventListener('click', onClick);
  return button;
}

function currentName(input, record) {
  return input.value.trim() || record.name;
}

async function commitName(id, input) {
  const next = input.value.trim().slice(0, 120);
  const record = await getRecording(id);
  if (!record) return;
  if (!next) {
    input.value = record.name;
    setAlert("The name can't be empty.");
    return;
  }
  input.value = next;
  if (next === record.name) return;
  try {
    await updateRecording(id, { name: next });
    const item = input.closest('li');
    item.querySelector('.play').setAttribute('aria-label', `Play ${next}`);
    item.querySelector('.download').setAttribute('aria-label', `Download ${next}`);
    item.querySelector('.share').setAttribute('aria-label', `Share ${next}`);
    item.querySelector('.delete').setAttribute('aria-label', `Delete ${next}`);
    if (state.blobCache?.id === id) state.blobCache = null;
  } catch {
    input.value = record.name;
    setAlert('Could not rename that recording.');
  }
}

async function onPlay(record, button, audio) {
  const liveName = button.closest('li')?.querySelector('.name')?.value?.trim() || record.name;
  try {
    if (state.activeId === record.id && audio.src) {
      if (audio.paused) await audio.play();
      else audio.pause();
      syncPlay(button, audio, liveName);
      return;
    }
    button.disabled = true;
    button.textContent = 'Preparing…';
    const file = await materialize(record);
    revokePlayback();
    const url = URL.createObjectURL(file);
    state.activeUrl = url;
    state.activeId = record.id;
    audio.hidden = false;
    audio.src = url;
    try {
      await audio.play();
    } catch (error) {
      if (error?.name !== 'NotAllowedError') throw error;
      setStatus('Tap the player to listen.');
      button.textContent = 'Play';
      return;
    }
    syncPlay(button, audio, liveName);
  } catch {
    setAlert('Could not play that recording.');
    button.textContent = 'Play';
  } finally {
    button.disabled = false;
  }
}

function syncPlay(button, audio, name) {
  const playing = !audio.paused && !audio.ended;
  button.textContent = playing ? 'Pause playback' : 'Play';
  button.setAttribute('aria-label', `${playing ? 'Pause playback of' : 'Play'} ${name}`);
  button.setAttribute('aria-pressed', playing ? 'true' : 'false');
}

async function onDownload(record) {
  try {
    const file = await materialize(record);
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus('Download started.');
  } catch {
    setAlert('Could not download that recording.');
  }
}

async function onShare(record) {
  try {
    const file = await materialize(record);
    const payload = { files: [file], title: file.name };
    if (!navigator.share || !navigator.canShare?.(payload)) {
      setAlert('Sharing files is not available in this browser. Use Download.');
      return;
    }
    await navigator.share(payload);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    setAlert('Could not share that file. Use Download.');
  }
}

async function onDelete(record) {
  const input = document.querySelector(`[data-id="${record.id}"] .name`);
  if (input) await commitName(record.id, input);
  const fresh = await getRecording(record.id);
  const name = fresh?.name || record.name;
  els.confirmBody.textContent = `${name} will be removed from this phone. This cannot be undone.`;
  els.confirm.showModal();
  const confirmed = await new Promise((resolve) => {
    els.confirm.addEventListener('close', () => {
      resolve(els.confirm.returnValue === 'delete');
    }, { once: true });
  });
  if (!confirmed) {
    document.querySelector(`[data-id="${record.id}"] .delete`)?.focus();
    return;
  }
  try {
    await deleteRecording(record.id);
    if (state.blobCache?.id === record.id) state.blobCache = null;
    if (state.activeId === record.id) revokePlayback();
    await renderList();
    els.libraryTitle.focus();
    setStatus('Recording deleted.');
    refreshStorageNote();
  } catch {
    setAlert('Could not delete that recording.');
  }
}

async function materialize(record) {
  const input = document.querySelector(`[data-id="${record.id}"] .name`);
  if (input) await commitName(record.id, input);
  const fresh = await getRecording(record.id);
  const source = fresh || record;
  if (state.blobCache?.id === source.id && state.blobCache.updatedAt === source.updatedAt) {
    return state.blobCache.file;
  }
  const rows = await getChunks(source.id);
  if (!rows.length) throw new Error('empty');
  const type = source.mimeType || rows[0].blob.type || 'audio/webm';
  let blob = new Blob(rows.map((row) => row.blob), { type });
  blob = await withWebmDuration(blob, source.durationMs);
  const file = new File(
    [blob],
    safeFilename(source.name, source.extension || extensionForMime(blob.type || type)),
    { type: blob.type || type, lastModified: source.createdAt },
  );
  state.blobCache = { id: source.id, updatedAt: source.updatedAt, file };
  return file;
}

function revokePlayback() {
  document.querySelectorAll('audio').forEach((audio) => {
    audio.pause();
    if (audio.getAttribute('src')) {
      audio.removeAttribute('src');
      audio.load();
    }
    audio.hidden = true;
  });
  if (state.activeUrl) URL.revokeObjectURL(state.activeUrl);
  state.activeUrl = null;
  state.activeId = null;
}

function safeFilename(name, extension) {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const base = (cleaned || 'recording').slice(0, 80);
  return `${base}.${extension}`;
}

function defaultName(time) {
  const formatted = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(time);
  return `Recording ${formatted}`;
}

function formatWhen(time) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(time);
}

function formatClock(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatBytes(bytes) {
  const size = bytes || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10240 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function setStatus(text) {
  els.statusText.textContent = text;
}

function setAlert(text) {
  els.alert.hidden = false;
  els.alert.textContent = text;
}

function clearAlert() {
  els.alert.hidden = true;
  els.alert.textContent = '';
}

function micMessage(error) {
  const name = error?.name || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
    return 'Microphone permission is blocked. In Chrome, allow the microphone for this site and try again.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return 'No microphone was found on this phone.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return 'The microphone is in use by another app. Close that app and try again.';
  }
  if (name === 'SecurityError') {
    return 'Recording only works on a secure page. Open this app from its https address.';
  }
  return 'Could not start the microphone. Try again.';
}

function problemMessage(error) {
  if (error?.name === 'QuotaExceededError') {
    return 'This phone is out of space for recordings. Delete one or free up storage, then try again.';
  }
  if (error?.message === 'The microphone stopped.') {
    return 'The microphone stopped. Audio saved before that is in the list.';
  }
  return 'Saving failed, so the recording stopped. Audio saved before that is in the list.';
}

function storageMessage() {
  return 'Could not open storage on this phone. Recordings need storage that Chrome is not blocking.';
}

async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
      await navigator.storage.persist();
    }
  } catch { /* the note explains the risk */ }
  refreshStorageNote();
}

async function refreshStorageNote() {
  let persisted = false;
  try {
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
  } catch { /* leave the cautious note */ }
  els.storage.textContent = persisted
    ? 'On this phone only. Chrome will try to keep this storage.'
    : 'On this phone only. Nothing is uploaded. Installing the app makes Chrome less likely to clear recordings when space is low.';
}

function bindInstall() {
  if (window.matchMedia('(display-mode: standalone)').matches) {
    els.installHelp.hidden = true;
  }
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    state.installEvent = event;
    els.install.hidden = false;
  });
  els.install.addEventListener('click', async () => {
    if (!state.installEvent) return;
    state.installEvent.prompt();
    try { await state.installEvent.userChoice; } catch { /* dismissed */ }
    state.installEvent = null;
    els.install.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    els.install.hidden = true;
    els.installHelp.hidden = true;
  });
}

function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).catch(() => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}
