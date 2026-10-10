import { setupAILyrics } from './ai-lyrics-ui.js';
import { EditHistory, fitStage, revealTimeline, shortcutFor } from './editor-tools.js';
import { drawTextClips, createTextClip, distributeWords } from './karaoke.js';
import { setupAIAgent } from './ai-agent.js';
import { setupKaraoke } from './karaoke-ui.js';
const IMAGE_DURATION = 5;
const MAX_IMAGE_DURATION = 120;
const MIN_CLIP_DURATION = 0.2;
const MAX_MEDIA_DURATION = 7200;
const EXPORT_WIDTH = 1280;
const EXPORT_HEIGHT = 720;
const EXPORT_FPS = 30;
const SEEK_TOLERANCE = 0.18;

const elements = Object.fromEntries([
  'file-input', 'upload-zone', 'asset-list', 'asset-count', 'stage-add',
  'preview-video', 'preview-image', 'stage-placeholder', 'stage', 'play-button',
  'back-button', 'forward-button', 'global-mute', 'time-display', 'ruler',
  'timeline-scroll', 'timeline-canvas', 'video-track', 'audio-track', 'playhead',
  'clip-count', 'timeline-duration', 'split-button', 'delete-button',
  'zoom-slider', 'inspector-empty', 'inspector-content', 'selected-icon',
  'selected-name', 'selected-type', 'clip-start', 'trim-in', 'trim-out',
  'audio-property', 'clip-mute', 'mute-switch', 'clip-volume', 'volume-value',
  'delete-inspector', 'toast', 'project-name', 'export-button', 'export-dialog',
  'close-export', 'cancel-export', 'start-export', 'export-message',
  'export-progress-bar', 'export-status', 'export-percent'
].map((id) => [id, document.getElementById(id)]));

const state = {
  assets: new Map(), clips: [], selectedId: null, playhead: 0, zoom: 52,
  playing: false, lastFrame: 0, globalMute: false, activeVisualId: null,
  audioElements: new Map(), audioGraph: null, exporting: false,
  exportCancelled: false, recorder: null, exportStream: null,
  exportCanvas: null, toastTimer: null, drag: null, frameRequest: null
};

const icon = (name) => `<svg class="icon"><use href="#i-${name}"/></svg>`;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const roundTime = (value) => Math.round(value * 1000) / 1000;
const getAsset = (clip) => clip.track === 'text' ? { kind: 'text', duration: MAX_MEDIA_DURATION, file: { name: clip.text || 'Chữ trống' } } : state.assets.get(clip.assetId);
const getSelectedClip = () => state.clips.find((clip) => clip.id === state.selectedId);
const projectDuration = () => state.clips.reduce((maximum, clip) => Math.max(maximum, clip.start + clip.duration), 0);
const assetLimit = (asset) => asset.kind === 'image' ? MAX_IMAGE_DURATION : asset.duration;
const editHistory = new EditHistory(snapshotProject());

function snapshotProject() {
  return { data: { clips: state.clips, projectName: elements['project-name'].value, globalMute: state.globalMute },
    view: { selectedId: state.selectedId, playhead: state.playhead } };
}

function recordEdit(group = null) {
  if (state.drag) return;
  editHistory.record(snapshotProject(), group);
  document.getElementById('undo-button').disabled = !editHistory.canUndo;
  document.getElementById('redo-button').disabled = !editHistory.canRedo;
}

function restoreEdit(direction) {
  if (state.exporting) return;
  if (state.drag) stopClipDrag();
  const snapshot = direction === 'undo' ? editHistory.undo() : editHistory.redo();
  if (!snapshot) return;
  pausePlayback();
  for (const [id, audio] of state.audioElements) {
    if (!snapshot.data.clips.some(c => c.id === id && c.track === 'audio')) {
      audio.pause(); audio.removeAttribute('src'); audio.load(); state.audioElements.delete(id);
    }
  }
  state.clips = snapshot.data.clips; state.selectedId = snapshot.view.selectedId;
  state.playhead = clamp(snapshot.view.playhead, 0, projectDuration());
  state.globalMute = snapshot.data.globalMute; state.activeVisualId = null; state.loopTextId = null;
  elements['project-name'].value = snapshot.data.projectName;
  updateGlobalMuteButton();
  renderAll(); revealClip(getSelectedClip());
  showToast(direction === 'undo' ? 'Đã hoàn tác.' : 'Đã làm lại.');
}

function updateGlobalMuteButton() {
  elements['global-mute'].innerHTML = icon(state.globalMute ? 'mute' : 'volume');
  elements['global-mute'].classList.toggle('muted', state.globalMute);
  elements['global-mute'].ariaLabel = state.globalMute ? 'Bật tiếng toàn bộ' : 'Tắt tiếng toàn bộ';
}

function revealClip(clip) {
  if (!clip) return;
  const viewport = elements['timeline-scroll'];
  const track = elements[clip.track === 'text' ? 'text-track' : clip.track === 'audio' ? 'audio-track' : 'video-track'];
  const position = revealTimeline({ start: clip.start, duration: clip.duration, zoom: state.zoom,
    scrollLeft: viewport.scrollLeft, viewportWidth: viewport.clientWidth,
    trackTop: track.offsetTop, trackHeight: track.offsetHeight, scrollTop: viewport.scrollTop, viewportHeight: viewport.clientHeight });
  viewport.scrollLeft = position.left; viewport.scrollTop = position.top;
}

function duplicateSelectedClip() {
  const clip = getSelectedClip(); if (!clip || state.exporting) return;
  pausePlayback();
  const next = structuredClone(clip); next.id = crypto.randomUUID(); next.start = roundTime(clip.start + clip.duration);
  state.clips.push(next); state.selectedId = next.id; state.playhead = next.start;
  renderAll(); revealClip(next); showToast('Đã nhân đôi clip.');
}

function resizeStage() {
  const wrapper = document.querySelector('.stage-wrap');
  const css = getComputedStyle(wrapper);
  const available = fitStage(wrapper.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
    wrapper.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom));
  elements.stage.style.width = `${available.width}px`; elements.stage.style.height = `${available.height}px`;
}

function handleShortcut(event) {
  if (state.exporting) return;
  const target = event.target;
  const editing = Boolean(target.closest?.('input, textarea, select, [contenteditable="true"], [role="textbox"]'));
  const action = shortcutFor(event, { editing, managedText: ['text-content', 'project-name'].includes(target.id), dialogOpen: Boolean(document.querySelector('dialog[open]')) });
  if (!action) return;
  // Space activates focused buttons normally. Other editor shortcuts still work after clicking a button.
  if (action === 'play' && target.closest?.('button, summary')) return;
  event.preventDefault();
  if (state.drag) stopClipDrag();
  if (action === 'undo' || action === 'redo') { restoreEdit(action); return; }
  if (action === 'delete') deleteSelectedClip();
  if (action === 'duplicate') duplicateSelectedClip();
  if (action === 'split') splitSelectedClip();
  if (action === 'text') karaokeUI.addText();
  if (action === 'play') state.playing ? pausePlayback() : startPlayback();
  if (action === 'help') document.getElementById('shortcuts-dialog').showModal();
  const offsets = { 'back-frame': -1 / EXPORT_FPS, 'next-frame': 1 / EXPORT_FPS, 'back-second': -1, 'next-second': 1 };
  if (action in offsets || action === 'start' || action === 'end') {
    pausePlayback(); seekTo(action === 'start' ? 0 : action === 'end' ? projectDuration() : state.playhead + offsets[action]);
    revealClip({ start: state.playhead, duration: 0, track: getSelectedClip()?.track || 'visual' });
  }
}


function formatTime(seconds) {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safeSeconds / 60)).padStart(2, '0')}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 3200);
}

function mediaKind(file) {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('audio/')) return 'audio';
  return null;
}

function readMediaDuration(url, kind) {
  return new Promise((resolve, reject) => {
    const media = document.createElement(kind);
    media.preload = 'metadata';
    const timeout = setTimeout(() => finish(new Error('Tệp mất quá nhiều thời gian để mở.')), 12000);
    function finish(error, duration) {
      clearTimeout(timeout);
      media.onloadedmetadata = null;
      media.onerror = null;
      media.removeAttribute('src');
      media.load();
      if (error) reject(error);
      else resolve(duration);
    }
    media.onloadedmetadata = () => finish(null, media.duration);
    media.onerror = () => finish(new Error('Không đọc được thời lượng tệp.'));
    media.src = url;
  });
}

async function createAsset(file) {
  const kind = mediaKind(file);
  if (!kind) throw new Error(`${file.name}: định dạng không được hỗ trợ.`);
  const url = URL.createObjectURL(file);
  try {
    const duration = kind === 'image' ? IMAGE_DURATION : await readMediaDuration(url, kind);
    if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_MEDIA_DURATION) {
      throw new Error(`${file.name}: thời lượng không hợp lệ hoặc quá 2 giờ.`);
    }
    const asset = { id: crypto.randomUUID(), file, url, kind, duration, image: null };
    if (kind === 'image') {
      const image = new Image();
      image.src = url;
      await image.decode();
      asset.image = image;
    }
    return asset;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

async function importFiles(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;
  const failures = [];
  for (const file of files) {
    try {
      const asset = await createAsset(file);
      state.assets.set(asset.id, asset);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `${file.name}: không thể mở tệp.`);
    }
  }
  renderAssets();
  if (failures.length) showToast(failures[0]);
  else showToast(`Đã thêm ${files.length} tệp vào thư viện.`);
}

function renderAssets() {
  elements['asset-list'].replaceChildren();
  elements['asset-count'].textContent = String(state.assets.size);
  if (!state.assets.size) {
    elements['asset-list'].innerHTML = '<div class="empty-library"><span class="empty-orbit">' + icon('video') + '</span><strong>Chưa có tệp nào</strong><p>Tải media lên để bắt đầu tạo video của bạn.</p></div>';
    return;
  }
  for (const asset of state.assets.values()) {
    const button = document.createElement('button');
    button.className = 'asset-item';
    button.type = 'button';
    const thumbnail = document.createElement('span');
    thumbnail.className = `asset-thumb ${asset.kind}`;
    if (asset.kind === 'image') {
      const image = document.createElement('img');
      image.src = asset.url;
      image.alt = '';
      thumbnail.append(image);
    } else thumbnail.innerHTML = icon(asset.kind === 'audio' ? 'music' : 'video');
    const details = document.createElement('span');
    details.className = 'asset-info';
    const name = document.createElement('strong');
    name.textContent = asset.file.name;
    const length = document.createElement('small');
    length.textContent = `${asset.kind === 'image' ? 'Ảnh' : asset.kind === 'audio' ? 'Âm thanh' : 'Video'} · ${formatTime(asset.duration)}`;
    details.append(name, length);
    const add = document.createElement('span');
    add.className = 'asset-add';
    add.textContent = '+';
    button.append(thumbnail, details, add);
    button.addEventListener('click', () => addAssetToTimeline(asset.id));
    elements['asset-list'].append(button);
  }
}

function addAssetToTimeline(assetId) {
  const asset = state.assets.get(assetId);
  if (!asset) return;
  const track = asset.kind === 'audio' ? 'audio' : 'visual';
  const start = state.clips.filter((clip) => clip.track === track)
    .reduce((maximum, clip) => Math.max(maximum, clip.start + clip.duration), 0);
  const clip = { id: crypto.randomUUID(), assetId, track, start, sourceStart: 0,
    duration: asset.duration, muted: false, volume: 1 };
  state.clips.push(clip);
  state.selectedId = clip.id;
  state.playhead = clip.start;
  renderAll();
  revealClip(clip);
  showToast(`Đã thêm ${asset.file.name} vào timeline.`);
}

function makeClipElement(clip) {
  const asset = getAsset(clip);
  const clipElement = document.createElement('div');
  clipElement.className = `clip ${asset.kind}${clip.id === state.selectedId ? ' selected' : ''}`;
  clipElement.dataset.clipId = clip.id;
  clipElement.style.left = `${clip.start * state.zoom}px`;
  clipElement.style.width = `${Math.max(clip.duration * state.zoom, 12)}px`;
  if (asset.kind === 'image') {
    const thumbnail = document.createElement('img');
    thumbnail.className = 'clip-thumb';
    thumbnail.src = asset.url;
    thumbnail.alt = '';
    clipElement.append(thumbnail);
  }
  const content = document.createElement('div');
  content.className = 'clip-inner';
  content.innerHTML = icon(asset.kind === 'audio' ? 'music' : asset.kind === 'image' ? 'image' : asset.kind === 'text' ? 'text' : 'video');
  const name = document.createElement('span');
  name.className = 'clip-name';
  name.textContent = asset.file.name;
  content.append(name);
  const duration = document.createElement('span');
  duration.className = 'clip-duration';
  duration.textContent = `${roundTime(clip.duration)}s`;
  clipElement.append(content, duration);
  for (const side of ['left', 'right']) {
    const handle = document.createElement('span');
    handle.className = `clip-handle ${side}`;
    handle.dataset.mode = side;
    clipElement.append(handle);
  }
  return clipElement;
}

function renderTimeline() {
  karaokeUI.renderList();
  const duration = Math.max(30, Math.ceil(projectDuration() + 5));
  const timelineWidth = Math.max(elements['timeline-scroll'].clientWidth, 146 + duration * state.zoom);
  elements['timeline-canvas'].style.width = `${timelineWidth}px`;
  elements.ruler.replaceChildren();
  const step = state.zoom < 40 ? 10 : 5;
  for (let second = 0; second <= duration; second += step) {
    const tick = document.createElement('span');
    tick.className = 'ruler-mark';
    tick.style.left = `${second * state.zoom}px`;
    tick.textContent = formatTime(second);
    elements.ruler.append(tick);
  }
  for (const track of ['visual', 'audio', 'text']) {
    const container = elements[track === 'visual' ? 'video-track' : track === 'text' ? 'text-track' : 'audio-track'].querySelector('.track-content');
    container.style.backgroundSize = `${state.zoom}px 100%`;
    container.replaceChildren(...state.clips.filter((clip) => clip.track === track).map(makeClipElement));
  }
  elements['clip-count'].textContent = `${state.clips.length} clip`;
  elements['timeline-duration'].textContent = `Tổng thời lượng ${formatTime(projectDuration())}`;
  renderPlayhead();
}

function renderPlayhead() {
  elements.playhead.style.left = `${146 + state.playhead * state.zoom}px`;
  elements['time-display'].textContent = `${formatTime(state.playhead)} / ${formatTime(projectDuration())}`;
  karaokeUI.renderClock();
}

function renderInspector() {
  const clip = getSelectedClip();
  elements['inspector-content'].closest('.inspector-panel').classList.toggle('has-selection', Boolean(clip));
  elements['inspector-empty'].hidden = Boolean(clip);
  elements['inspector-content'].hidden = !clip;
  elements['split-button'].disabled = !clip;
  elements['delete-button'].disabled = !clip;
  karaokeUI.render(clip);
  if (!clip) return;
  const asset = getAsset(clip);
  elements['selected-name'].textContent = asset.file.name;
  elements['selected-type'].textContent = asset.kind === 'image' ? 'Ảnh' : asset.kind === 'audio' ? 'Âm thanh' : asset.kind === 'text' ? 'Chữ / karaoke' : 'Video';
  elements['selected-icon'].className = `selected-icon ${asset.kind}`;
  elements['selected-icon'].innerHTML = icon(asset.kind === 'audio' ? 'music' : asset.kind === 'image' ? 'image' : asset.kind === 'text' ? 'text' : 'video');
  elements['clip-start'].value = String(roundTime(clip.start));
  elements['trim-in'].value = String(roundTime(clip.sourceStart));
  elements['trim-out'].value = String(roundTime(clip.sourceStart + clip.duration));
  elements['trim-out'].max = String(assetLimit(asset));
  elements['audio-property'].hidden = asset.kind === 'image' || asset.kind === 'text';
  elements['mute-switch'].classList.toggle('off', clip.muted);
  elements['clip-volume'].value = String(Math.round(clip.volume * 100));
  elements['volume-value'].textContent = `${Math.round(clip.volume * 100)}%`;
}

function renderAll() {
  recordEdit();
  renderTimeline();
  renderInspector();
  syncPreview();
}

function activeVisualClip() {
  return state.clips.filter((clip) => clip.track === 'visual' && state.playhead >= clip.start && state.playhead < clip.start + clip.duration)
    .sort((first, second) => second.start - first.start)[0];
}

function synchronizeMedia(media, targetTime, shouldPlay) {
  media.playbackRate = state.exporting ? 1 : state.previewSpeed;
  if (media.readyState >= 1 && Math.abs(media.currentTime - targetTime) > (shouldPlay ? SEEK_TOLERANCE : 0.0005)) {
    try { media.currentTime = targetTime; } catch (error) { showToast('Không thể tua tệp media này.'); }
  }
  if (shouldPlay && media.paused && media.readyState >= 2) {
    media.play().catch(() => { pausePlayback(); showToast('Trình duyệt không thể phát tệp này.'); });
  } else if (!shouldPlay && !media.paused) media.pause();
}

function syncPreview() {
  const clip = activeVisualClip();
  const video = elements['preview-video'];
  const image = elements['preview-image'];
  elements['stage-placeholder'].style.display = state.clips.length ? 'none' : 'flex';
  video.style.display = clip && getAsset(clip).kind === 'video' ? 'block' : 'none';
  image.style.display = clip && getAsset(clip).kind === 'image' ? 'block' : 'none';
  if (!clip || getAsset(clip).kind !== 'video') video.pause();
  if (clip) {
    const asset = getAsset(clip);
    if (asset.kind === 'image') image.src = asset.url;
    else {
      if (state.activeVisualId !== clip.id) { video.src = asset.url; video.load(); }
      video.muted = state.globalMute || clip.muted;
      video.volume = clip.volume;
      synchronizeMedia(video, clip.sourceStart + state.playhead - clip.start, state.playing);
    }
  }
  state.activeVisualId = clip?.id ?? null;
  syncAudio();
  const overlay = elements['text-overlay'];
  const context = overlay.getContext('2d');
  context.clearRect(0, 0, overlay.width, overlay.height);
  drawTextClips(context, state.clips, state.playhead, overlay.width, overlay.height);
}

function syncAudio() {
  for (const clip of state.clips.filter((item) => item.track === 'audio')) {
    const isActive = state.playhead >= clip.start && state.playhead < clip.start + clip.duration;
    const audio = getAudioElement(clip);
    audio.muted = state.globalMute || clip.muted;
    audio.volume = clip.volume;
    if (isActive) synchronizeMedia(audio, clip.sourceStart + state.playhead - clip.start, state.playing);
    else audio.pause();
  }
}

function getAudioElement(clip) {
  if (state.audioElements.has(clip.id)) return state.audioElements.get(clip.id);
  const audio = new Audio(getAsset(clip).url);
  audio.preload = 'auto';
  audio.addEventListener('loadedmetadata', syncPreview);
  state.audioElements.set(clip.id, audio);
  return audio;
}

function pausePlayback() {
  state.playing = false;
  cancelAnimationFrame(state.frameRequest);
  elements['preview-video'].pause();
  for (const audio of state.audioElements.values()) audio.pause();
  elements['play-button'].innerHTML = icon('play');
  elements['play-button'].ariaLabel = 'Phát';
}

function startPlayback() {
  if (state.playing) return;
  if (!projectDuration()) { showToast('Hãy thêm media vào timeline trước.'); return; }
  if (state.playhead >= projectDuration()) state.playhead = 0;
  state.playing = true;
  state.lastFrame = performance.now();
  elements['play-button'].innerHTML = icon('pause');
  elements['play-button'].ariaLabel = 'Tạm dừng';
  state.frameRequest = requestAnimationFrame(tick);
  syncPreview();
}

function tick(now) {
  if (!state.playing) return;
  state.playhead = Math.min(projectDuration(), state.playhead + (now - state.lastFrame) / 1000 * (state.exporting ? 1 : state.previewSpeed));
  state.lastFrame = now;
  karaokeUI.loop();
  renderPlayhead();
  syncPreview();
  if (state.exporting) updateExportFrame();
  if (state.playhead >= projectDuration()) {
    pausePlayback();
    if (state.exporting) stopExport(false);
    return;
  }
  state.frameRequest = requestAnimationFrame(tick);
}

function seekTo(seconds) {
  state.playhead = clamp(seconds, 0, projectDuration());
  renderPlayhead();
  syncPreview();
}

function splitSelectedClip() {
  const clip = getSelectedClip();
  if (!clip) return;
  const firstDuration = state.playhead - clip.start;
  if (firstDuration < MIN_CLIP_DURATION || clip.duration - firstDuration < MIN_CLIP_DURATION) {
    showToast('Đặt con trỏ bên trong clip để cắt.');
    return;
  }
  const second = { ...structuredClone(clip), id: crypto.randomUUID(), start: state.playhead,
    sourceStart: clip.sourceStart + firstDuration, duration: clip.duration - firstDuration };
  clip.duration = firstDuration;
  state.clips.push(second);
  state.selectedId = second.id;
  renderAll();
  revealClip(second);
  showToast('Đã cắt clip tại vị trí con trỏ.');
}

function deleteSelectedClip() {
  if (!state.selectedId) return;
  state.clips = state.clips.filter((clip) => clip.id !== state.selectedId);
  const audio = state.audioElements.get(state.selectedId);
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); state.audioElements.delete(state.selectedId); }
  state.selectedId = null;
  state.playhead = Math.min(state.playhead, projectDuration());
  renderAll();
  showToast('Đã xóa clip khỏi timeline.');
}

function updateSelectedTiming() {
  const clip = getSelectedClip();
  if (!clip) return;
  const asset = getAsset(clip);
  const start = Number(elements['clip-start'].value);
  const trimIn = Number(elements['trim-in'].value);
  const trimOut = Number(elements['trim-out'].value);
  if (![start, trimIn, trimOut].every(Number.isFinite) || start < 0 || trimIn < 0 || trimOut > assetLimit(asset) || trimOut - trimIn < MIN_CLIP_DURATION) {
    showToast('Kiểm tra lại điểm bắt đầu và khoảng cắt.');
    renderInspector();
    return;
  }
  clip.start = roundTime(start);
  clip.sourceStart = roundTime(trimIn);
  clip.duration = roundTime(trimOut - trimIn);
  renderAll();
}

function startClipDrag(event) {
  const clipElement = event.target.closest('.clip');
  if (!clipElement || state.exporting) return;
  const clip = state.clips.find((item) => item.id === clipElement.dataset.clipId);
  if (!clip) return;
  event.preventDefault();
  elements['timeline-scroll'].focus({ preventScroll: true });
  state.selectedId = clip.id;
  recordEdit();
  state.drag = { id: clip.id, x: event.clientX, start: clip.start,
    sourceStart: clip.sourceStart, duration: clip.duration,
    mode: event.target.dataset.mode || 'move' };
  renderInspector();
  renderTimeline();
}

function moveClipDrag(event) {
  const drag = state.drag;
  if (!drag) return;
  const clip = state.clips.find((item) => item.id === drag.id);
  if (!clip) { stopClipDrag(); return; }
  const asset = getAsset(clip);
  const delta = roundTime((event.clientX - drag.x) / state.zoom);
  if (drag.mode === 'move') clip.start = Math.max(0, roundTime(drag.start + delta));
  if (drag.mode === 'left') {
    const change = clamp(delta, Math.max(-drag.sourceStart, -drag.start), drag.duration - MIN_CLIP_DURATION);
    clip.start = Math.max(0, roundTime(drag.start + change));
    clip.sourceStart = roundTime(drag.sourceStart + change);
    clip.duration = roundTime(drag.duration - change);
  }
  if (drag.mode === 'right') {
    clip.duration = roundTime(clamp(drag.duration + delta, MIN_CLIP_DURATION, assetLimit(asset) - drag.sourceStart));
  }
  renderTimeline();
  renderInspector();
  syncPreview();
}

function stopClipDrag() { if (!state.drag) return; state.drag = null; recordEdit(); }

function setExportProgress(progress) {
  const percent = Math.round(clamp(progress, 0, 1) * 100);
  elements['export-progress-bar'].style.width = `${percent}%`;
  elements['export-percent'].textContent = `${percent}%`;
}

function getExportMimeType() {
  return ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find((type) => MediaRecorder.isTypeSupported(type));
}

async function ensureAudioGraph() {
  if (!state.audioGraph) {
    const context = new AudioContext();
    state.audioGraph = { context, destination: context.createMediaStreamDestination(), sources: new WeakMap() };
  }
  const { context, destination, sources } = state.audioGraph;
  for (const media of [elements['preview-video'], ...state.clips.filter((clip) => clip.track === 'audio').map(getAudioElement)]) {
    if (sources.has(media)) continue;
    const source = context.createMediaElementSource(media);
    source.connect(context.destination);
    source.connect(destination);
    sources.set(media, source);
  }
  await context.resume();
  return destination.stream;
}

function drawContained(context, source, width, height) {
  const sourceWidth = source.videoWidth || source.naturalWidth;
  const sourceHeight = source.videoHeight || source.naturalHeight;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function updateExportFrame() {
  if (!state.exportCanvas) return;
  const context = state.exportCanvas.getContext('2d');
  context.fillStyle = '#080a0d';
  context.fillRect(0, 0, EXPORT_WIDTH, EXPORT_HEIGHT);
  const clip = activeVisualClip();
  if (clip) {
    const asset = getAsset(clip);
    if (asset.kind === 'image') drawContained(context, asset.image, EXPORT_WIDTH, EXPORT_HEIGHT);
    if (asset.kind === 'video' && elements['preview-video'].readyState >= 2) {
      drawContained(context, elements['preview-video'], EXPORT_WIDTH, EXPORT_HEIGHT);
    }
  }
  drawTextClips(context, state.clips, state.playhead, EXPORT_WIDTH, EXPORT_HEIGHT);
  setExportProgress(state.playhead / projectDuration());
}

function finishExport(chunks, mimeType) {
  if (!state.exportCancelled && chunks.length) {
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    const safeName = elements['project-name'].value.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 60) || 'video-studio';
    link.href = url;
    link.download = `${safeName}.webm`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setExportProgress(1);
    elements['export-status'].textContent = 'Hoàn tất';
    showToast('Video đã sẵn sàng để tải xuống.');
  }
  state.exportStream?.getVideoTracks().forEach((track) => track.stop());
  state.exportStream = null;
  state.exportCanvas = null;
  state.recorder = null;
  state.exporting = false;
  document.querySelector('.app-shell').inert = false;
  elements['start-export'].disabled = false;
  elements['cancel-export'].textContent = 'Đóng';
}

function stopExport(cancelled) {
  state.exportCancelled = cancelled;
  pausePlayback();
  if (state.recorder?.state === 'recording') state.recorder.stop();
  if (cancelled) elements['export-status'].textContent = 'Đã hủy';
}

async function startExport() {
  if (!projectDuration()) { showToast('Timeline đang trống.'); return; }
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream || !window.AudioContext) {
    showToast('Trình duyệt này chưa hỗ trợ xuất video.');
    return;
  }
  const mimeType = getExportMimeType();
  if (!mimeType) { showToast('Trình duyệt này chưa hỗ trợ xuất WebM.'); return; }
  try {
    pausePlayback();
    state.loopTextId = null;
    seekTo(0);
    state.exportCanvas = document.createElement('canvas');
    state.exportCanvas.width = EXPORT_WIDTH;
    state.exportCanvas.height = EXPORT_HEIGHT;
    const videoStream = state.exportCanvas.captureStream(EXPORT_FPS);
    const audioStream = await ensureAudioGraph();
    state.exportStream = new MediaStream([...videoStream.getVideoTracks(), ...audioStream.getAudioTracks()]);
    const recorder = new MediaRecorder(state.exportStream, { mimeType, videoBitsPerSecond: 6000000 });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { stopExport(true); showToast('Xuất video thất bại.'); };
    recorder.onstop = () => finishExport(chunks, mimeType);
    state.recorder = recorder;
    state.exporting = true;
    document.querySelector('.app-shell').inert = true;
    state.exportCancelled = false;
    elements['start-export'].disabled = true;
    elements['cancel-export'].textContent = 'Hủy xuất';
    elements['export-status'].textContent = 'Đang ghi video…';
    setExportProgress(0);
    updateExportFrame();
    recorder.start(1000);
    startPlayback();
  } catch (error) {
    state.exportStream?.getVideoTracks().forEach((track) => track.stop());
    state.exportCanvas = null;
    state.exporting = false;
    document.querySelector('.app-shell').inert = false;
    elements['start-export'].disabled = false;
    showToast(error instanceof Error ? error.message : 'Không thể bắt đầu xuất video.');
  }
}

function bindEvents() {
  elements['preview-video'].addEventListener('loadedmetadata', syncPreview);
  elements['file-input'].addEventListener('change', (event) => { void importFiles(event.target.files); event.target.value = ''; });
  elements['stage-add'].addEventListener('click', () => elements['file-input'].click());
  elements['upload-zone'].addEventListener('dragover', (event) => { event.preventDefault(); elements['upload-zone'].classList.add('dragging'); });
  elements['upload-zone'].addEventListener('dragleave', () => elements['upload-zone'].classList.remove('dragging'));
  elements['upload-zone'].addEventListener('drop', (event) => { event.preventDefault(); elements['upload-zone'].classList.remove('dragging'); void importFiles(event.dataTransfer.files); });
  elements['play-button'].addEventListener('click', () => state.playing ? pausePlayback() : startPlayback());
  elements['back-button'].addEventListener('click', () => seekTo(state.playhead - 5));
  elements['forward-button'].addEventListener('click', () => seekTo(state.playhead + 5));
  elements['global-mute'].addEventListener('click', () => { state.globalMute = !state.globalMute; updateGlobalMuteButton(); recordEdit(); syncPreview(); });
  elements['split-button'].addEventListener('click', splitSelectedClip);
  elements['delete-button'].addEventListener('click', deleteSelectedClip);
  elements['delete-inspector'].addEventListener('click', deleteSelectedClip);
  elements['zoom-slider'].addEventListener('input', (event) => { state.zoom = Number(event.target.value); renderTimeline(); });
  for (const id of ['clip-start', 'trim-in', 'trim-out']) elements[id].addEventListener('change', updateSelectedTiming);
  elements['clip-mute'].addEventListener('click', () => { const clip = getSelectedClip(); if (!clip) return; clip.muted = !clip.muted; recordEdit(); renderInspector(); syncPreview(); });
  elements['clip-volume'].addEventListener('input', (event) => { const clip = getSelectedClip(); if (!clip) return; clip.volume = Number(event.target.value) / 100; recordEdit(`volume:${clip.id}`); elements['volume-value'].textContent = `${event.target.value}%`; syncPreview(); });
  elements['ruler'].addEventListener('pointerdown', (event) => seekTo((event.clientX - elements.ruler.getBoundingClientRect().left) / state.zoom));
  for (const id of ['video-track', 'audio-track', 'text-track']) elements[id].addEventListener('pointerdown', (event) => { if (event.target.closest('.clip')) startClipDrag(event); else seekTo((event.clientX - elements[id].querySelector('.track-content').getBoundingClientRect().left) / state.zoom); });
  window.addEventListener('pointermove', moveClipDrag);
  window.addEventListener('pointerup', stopClipDrag);
  window.addEventListener('keydown', handleShortcut);
  window.addEventListener('pointercancel', stopClipDrag);
  window.addEventListener('blur', stopClipDrag);
  document.getElementById('undo-button').addEventListener('click', () => restoreEdit('undo'));
  document.getElementById('redo-button').addEventListener('click', () => restoreEdit('redo'));
  document.getElementById('shortcuts-button').addEventListener('click', () => document.getElementById('shortcuts-dialog').showModal());
  document.getElementById('close-shortcuts').addEventListener('click', () => document.getElementById('shortcuts-dialog').close());
  elements['project-name'].addEventListener('input', () => recordEdit('project-name'));
  document.addEventListener('focusout', () => editHistory.endGroup());
  elements['timeline-scroll'].tabIndex = 0;
  elements['timeline-scroll'].setAttribute('aria-label', 'Timeline. Delete xóa clip, Ctrl Z hoàn tác, S chia clip, T thêm chữ.');
  const observer = new ResizeObserver(resizeStage); observer.observe(document.querySelector('.stage-wrap'));
  resizeStage();
  elements['export-button'].addEventListener('click', () => { if (!projectDuration()) { showToast('Hãy thêm media vào timeline trước.'); return; } elements['export-dialog'].showModal(); });
  elements['close-export'].addEventListener('click', () => { if (state.exporting) stopExport(true); elements['export-dialog'].close(); });
  elements['cancel-export'].addEventListener('click', () => { if (state.exporting) stopExport(true); else elements['export-dialog'].close(); });
  elements['start-export'].addEventListener('click', () => { void startExport(); });
  elements['export-dialog'].addEventListener('cancel', () => { if (state.exporting) stopExport(true); });
  window.addEventListener('beforeunload', () => { for (const asset of state.assets.values()) URL.revokeObjectURL(asset.url); state.audioGraph?.context.close(); });
}

function agentContext() {
  return { projectName: elements['project-name'].value, playhead: state.playhead,
    selectedId: state.selectedId, duration: projectDuration(),
    clips: state.clips.slice(0, 120).map((clip) => ({
      id: clip.id, track: clip.track, start: clip.start, duration: clip.duration,
      text: clip.track === 'text' ? (clip.text || '').slice(0, 300) : undefined,
      assetName: clip.track !== 'text' ? getAsset(clip)?.file?.name?.slice(0, 120) : undefined
    })) };
}
function applyAgentActions(actions) {
  if (state.exporting || state.drag) throw new Error('Không thể sửa khi đang xuất hoặc kéo clip.');
  if (actions.some(a => a.type === 'move_selected') && !getSelectedClip()) throw new Error('Hãy chọn clip trước khi dời.');
  if (state.clips.length + actions.filter(a => a.type === 'add_text').length > 500)
    throw new Error('Timeline có quá nhiều clip.');
  pausePlayback();
  const previous = snapshotProject();
  try {
    for (const action of actions) {
      if (action.type === 'rename_project') elements['project-name'].value = action.title;
      else if (action.type === 'seek') state.playhead = action.seconds;
      else if (action.type === 'move_selected') getSelectedClip().start = action.seconds;
      else if (action.type === 'add_text') {
        const clip = createTextClip(action.start, crypto.randomUUID());
        clip.text = action.text;
        clip.duration = action.duration;
        clip.karaoke.sweepDuration = Math.max(0.01, action.duration - clip.karaoke.delay);
        clip.karaoke.words = distributeWords(clip.text, clip.karaoke.sweepDuration);
        clip.karaoke.points = [{ time: 0, progress: 0 }, { time: clip.karaoke.sweepDuration, progress: 100 }];
        state.clips.push(clip);
        state.selectedId = clip.id;
      }
    }
    state.playhead = clamp(state.playhead, 0, projectDuration());
    renderAll(); revealClip(getSelectedClip()); showToast('AI Agent đã áp dụng ' + actions.length + ' thao tác.');
  } catch (error) {
    state.clips = previous.data.clips;
    elements['project-name'].value = previous.data.projectName;
    state.selectedId = previous.view.selectedId; state.playhead = previous.view.playhead;
    renderAll(); throw error;
  }
}

const karaokeUI = setupKaraoke({ state, elements, renderAll, renderTimeline, syncPreview, seekTo, startPlayback, pausePlayback, showToast, getSelectedClip, recordEdit, revealClip, duplicateSelectedClip });
setupAILyrics({ state, elements, getSelectedClip, pausePlayback, renderAll, revealClip, showToast });
bindEvents();
setupAIAgent({ getContext: agentContext, applyActions: applyAgentActions });
renderAll();
