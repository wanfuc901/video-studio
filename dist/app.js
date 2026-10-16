import { createSessionStore, SessionAutosaver, projectRecord } from './session-store.js';
import { exportPreset, setupPrecisionWheel } from './precision-tools.js';
import { setupAILyrics } from './ai-lyrics-ui.js';
import { EditHistory, fitStage, revealTimeline, shortcutFor, visibleTimeRange, clipInRange, CLIP_KINDS, clipKind, countClipKinds, clipRangeIds, reconcileSelection } from './editor-tools.js';
import { drawTextClips } from './karaoke.js';
import { setupKaraoke } from './karaoke-ui.js';
import { renderOfflineExport, supportsOfflineExport, loadMediabunny, estimatedExportBytes, ExportDecodeError } from './offline-export.js';
const IMAGE_DURATION = 5;
const MAX_IMAGE_DURATION = 120;
const MIN_CLIP_DURATION = 0.2;
const MAX_MEDIA_DURATION = 7200;
const EXPORT_FPS = 30;
const SEEK_TOLERANCE = 0.18;
const TRACK_LABEL_WIDTH = 146;
const AUTOSAVE_DELAY_MS = 700;
// Above this estimated size the export streams to a file picked by the user instead of RAM.
const STREAM_EXPORT_BYTES = 400 * 1024 * 1024;
const EXPORT_FRAME_WAIT_MS = 5000;
const EXPORT_FRAME_POLL_MS = 30;
const CLIP_KIND_NAMES = { video: 'clip video', image: 'clip ảnh', audio: 'clip âm thanh', text: 'câu chữ' };
const BULK_MENU_GAP = 6;
const VIEWPORT_MARGIN = 8;

const elements = Object.fromEntries([
  'file-input', 'upload-zone', 'asset-list', 'asset-count', 'stage-add',
  'preview-video', 'preview-image', 'stage-placeholder', 'stage', 'play-button',
  'back-button', 'forward-button', 'global-mute', 'time-display', 'ruler',
  'timeline-scroll', 'timeline-canvas', 'video-track', 'audio-track', 'playhead',
  'clip-count', 'timeline-duration', 'split-button', 'delete-button', 'bulk-delete-menu', 'delete-inspector-label',
  'zoom-slider', 'inspector-empty', 'inspector-content', 'selected-icon',
  'selected-name', 'selected-type', 'clip-start', 'trim-in', 'trim-out',
  'audio-property', 'clip-mute', 'mute-switch', 'clip-volume', 'volume-value',
  'delete-inspector', 'toast', 'project-name', 'export-button', 'export-dialog',
  'close-export', 'cancel-export', 'start-export', 'export-message',
  'export-progress-bar', 'export-status', 'export-percent', 'export-resolution', 'export-mode', 'stage-resolution'
].map((id) => [id, document.getElementById(id)]));

const state = {
  // selectedId is the clip shown in the inspector; selectedIds holds every selected clip, including it.
  assets: new Map(), clips: [], selectedId: null, selectedIds: new Set(), playhead: 0, zoom: 52,
  playing: false, lastFrame: 0, globalMute: false, activeVisualId: null,
  audioElements: new Map(), audioGraph: null, exporting: false,
  exportCancelled: false, recorder: null, exportStream: null,
  exportCanvas: null, exportVisual: null, exportAbort: null, exportSettings: exportPreset('1080'), exportRun: 0, toastTimer: null,
  drag: null, dragFrame: 0, frameRequest: null, renderedRange: null, scrollFrame: 0, beats: [],
  previewFrameReady: true, previewFrameToken: 0
};

const icon = (name) => `<svg class="icon"><use href="#i-${name}"/></svg>`;
const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const roundTime = (value) => Math.round(value * 1000) / 1000;
const getAsset = (clip) => clip.track === 'text' ? { kind: 'text', duration: MAX_MEDIA_DURATION, file: { name: clip.text || 'Chữ trống' } } : state.assets.get(clip.assetId);
const getSelectedClip = () => state.clips.find((clip) => clip.id === state.selectedId);
const projectDuration = () => state.clips.reduce((maximum, clip) => Math.max(maximum, clip.start + clip.duration), 0);
const assetLimit = (asset) => asset.kind === 'image' ? MAX_IMAGE_DURATION : asset.duration;
let editHistory = new EditHistory(snapshotProject());
let sessionAutosaver = null, restoringSession = true, mediaImports = 0, unsavedWithoutStore = false;
function saveSession() { if (!restoringSession) { if(sessionAutosaver)sessionAutosaver.schedule();else unsavedWithoutStore=true; } }

function snapshotProject() {
  return { data: { clips: state.clips, projectName: elements['project-name'].value, globalMute: state.globalMute },
    view: { selectedId: state.selectedId, selectedIds: [...state.selectedIds], playhead: state.playhead } };
}

function recordEdit(group = null) {
  if (state.drag) return;
  editHistory.record(snapshotProject(), group || state.wheelEditGroup || null);
  document.getElementById('undo-button').disabled = !editHistory.canUndo;
  document.getElementById('redo-button').disabled = !editHistory.canRedo;
  saveSession();
}

function restoreEdit(direction) {
  if (state.exporting) return;
  if (state.drag) stopClipDrag();
  const snapshot = direction === 'undo' ? editHistory.undo() : editHistory.redo();
  if (!snapshot) return;
  pausePlayback();
  for (const id of [...state.audioElements.keys()]) {
    if (!snapshot.data.clips.some(c => c.id === id && c.track === 'audio')) releaseAudio(id);
  }
  state.clips = snapshot.data.clips; state.selectedId = snapshot.view.selectedId;
  state.selectedIds = new Set(snapshot.view.selectedIds ?? []);
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
  if (action === 'select-all') selectClips(state.clips.map((clip) => clip.id), state.selectedId ?? state.clips[0]?.id);
  if (action === 'deselect') selectClips([], null);
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
  mediaImports++;
  void navigator.storage?.persist?.().catch(() => {});
  const failures = [];
  for (const file of files) {
    try {
      const asset = await createAsset(file);
      state.assets.set(asset.id, asset);
      saveSession();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : `${file.name}: không thể mở tệp.`);
    }
  }
  mediaImports--;
  renderAssets();
  saveSession();
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
  clipElement.className = `clip ${asset.kind}${state.selectedIds.has(clip.id) ? ' selected' : ''}`;
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

function trackContent(track) {
  return elements[track === 'visual' ? 'video-track' : track === 'text' ? 'text-track' : 'audio-track'].querySelector('.track-content');
}

function timelineRange(overscanScreens = 1) {
  const viewport = elements['timeline-scroll'];
  return visibleTimeRange({ scrollLeft: viewport.scrollLeft, viewportWidth: viewport.clientWidth || 1200, zoom: state.zoom, labelWidth: TRACK_LABEL_WIDTH, overscanScreens });
}

function renderRuler(duration, range) {
  const step = state.zoom < 40 ? 10 : 5;
  const ticks = [];
  for (let second = Math.floor(range.start / step) * step; second <= Math.min(duration, range.end); second += step) {
    const tick = document.createElement('span');
    tick.className = 'ruler-mark';
    tick.style.left = `${second * state.zoom}px`;
    tick.textContent = formatTime(second);
    ticks.push(tick);
  }
  for (const beat of state.beats) {
    if (beat < range.start || beat > range.end) continue;
    const mark = document.createElement('span');
    mark.className = 'beat-mark';
    mark.style.left = `${beat * state.zoom}px`;
    ticks.push(mark);
  }
  elements.ruler.replaceChildren(...ticks);
}

// Only clips near the viewport are in the DOM; long songs with hundreds of lines stay responsive.
function renderTimeline() {
  syncSelection();
  karaokeUI.renderList();
  const duration = Math.max(30, Math.ceil(projectDuration() + 5));
  const timelineWidth = Math.max(elements['timeline-scroll'].clientWidth, TRACK_LABEL_WIDTH + duration * state.zoom);
  elements['timeline-canvas'].style.width = `${timelineWidth}px`;
  const range = timelineRange();
  state.renderedRange = range;
  renderRuler(duration, range);
  const draggedId = state.drag?.id;
  for (const track of ['visual', 'audio', 'text']) {
    const container = trackContent(track);
    container.style.backgroundSize = `${state.zoom}px 100%`;
    container.replaceChildren(...state.clips.filter((clip) => clip.track === track && (clip.id === draggedId || clipInRange(clip, range))).map(makeClipElement));
  }
  const selectedCount = state.selectedIds.size;
  elements['clip-count'].textContent = `${state.clips.length} clip${selectedCount > 1 ? ` · đang chọn ${selectedCount}` : ''}`;
  elements['timeline-duration'].textContent = `Tổng thời lượng ${formatTime(projectDuration())}`;
  renderPlayhead();
}

function onTimelineScroll() {
  if (state.scrollFrame) return;
  state.scrollFrame = requestAnimationFrame(() => {
    state.scrollFrame = 0;
    const view = timelineRange(0), rendered = state.renderedRange;
    if (!rendered || view.start < rendered.start || view.end > rendered.end) renderTimeline();
  });
}

function renderPlayhead() {
  elements.playhead.style.left = `${TRACK_LABEL_WIDTH + state.playhead * state.zoom}px`;
  elements['time-display'].textContent = `${formatTime(state.playhead)} / ${formatTime(projectDuration())}`;
  karaokeUI.renderClock();
}

function renderInspector() {
  const clip = getSelectedClip();
  elements['inspector-content'].closest('.inspector-panel').classList.toggle('has-selection', Boolean(clip));
  elements['inspector-empty'].hidden = Boolean(clip);
  elements['inspector-content'].hidden = !clip;
  elements['split-button'].disabled = !clip;
  renderDeleteLabels();
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

// readyState can report data before Chrome has presented the new frame (after a src change or seek);
// the real-time export holds the previous frame until requestVideoFrameCallback confirms a fresh one.
function markPreviewFramePending(video) {
  if (typeof video.requestVideoFrameCallback !== 'function') return;
  const token = ++state.previewFrameToken;
  state.previewFrameReady = false;
  video.requestVideoFrameCallback(() => { if (token === state.previewFrameToken) state.previewFrameReady = true; });
}

function synchronizeMedia(media, targetTime, shouldPlay) {
  media.playbackRate = state.exporting ? 1 : state.previewSpeed;
  if (media.readyState >= 1 && Math.abs(media.currentTime - targetTime) > (shouldPlay ? SEEK_TOLERANCE : 0.0005)) {
    try {
      media.currentTime = targetTime;
      if (media === elements['preview-video']) markPreviewFramePending(media);
    } catch (error) { showToast('Không thể tua tệp media này.'); }
  }
  if (shouldPlay && media.paused && media.readyState >= 2) {
    if (media === elements['preview-video']) markPreviewFramePending(media);
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
      if (state.activeVisualId !== clip.id) { video.src = asset.url; video.load(); markPreviewFramePending(video); }
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
  if(!state.exporting)saveSession();
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
  saveSession();
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

function syncSelection() {
  const { selectedId, selectedIds } = reconcileSelection(state.selectedIds, state.selectedId, state.clips);
  state.selectedId = selectedId;
  state.selectedIds = selectedIds;
}

function selectClips(ids, primaryId) {
  state.selectedIds = new Set(ids);
  state.selectedId = state.selectedIds.has(primaryId) ? primaryId : [...state.selectedIds].at(-1) ?? null;
  // Clip data is unchanged, so this only refreshes the history view: undo after a bulk delete
  // brings back the whole selection, not just the inspected clip.
  recordEdit();
  renderTimeline();
  renderInspector();
}

// Ctrl/⌘+click toggles one clip; Shift+click adds the clips between the inspected clip and this one.
function extendSelection(clip, asRange) {
  syncSelection();
  const anchor = getSelectedClip();
  const ids = new Set(state.selectedIds);
  if (asRange && anchor) {
    for (const id of clipRangeIds(state.clips, anchor, clip)) ids.add(id);
    selectClips(ids, anchor.id);
    return;
  }
  if (ids.has(clip.id)) ids.delete(clip.id); else ids.add(clip.id);
  selectClips(ids, ids.has(clip.id) ? clip.id : state.selectedId);
}

function renderDeleteLabels() {
  const count = state.selectedIds.size;
  const button = elements['delete-button'];
  button.disabled = count === 0;
  button.querySelector('span').textContent = count > 1 ? `Xóa ${count}` : 'Xóa';
  button.title = count > 1 ? `Xóa ${count} clip đã chọn` : 'Xóa clip đã chọn';
  elements['delete-inspector-label'].textContent = count > 1 ? `Xóa ${count} clip đã chọn` : 'Xóa clip khỏi timeline';
}

function releaseAudio(id) {
  const audio = state.audioElements.get(id);
  if (!audio) return;
  audio.pause(); audio.removeAttribute('src'); audio.load();
  // A real-time export routes the element through the audio graph; a connected source node keeps it alive.
  state.audioGraph?.sources.get(audio)?.disconnect();
  state.audioElements.delete(id);
}

// Removes clips only; library media stays, and the whole removal is one undo step.
function deleteClips(shouldDelete, description) {
  if (state.exporting) return;
  if (state.drag) stopClipDrag();
  const removedIds = new Set(state.clips.filter(shouldDelete).map((clip) => clip.id));
  if (!removedIds.size) { showToast('Không có clip nào để xóa.'); return; }
  state.clips = state.clips.filter((clip) => !removedIds.has(clip.id));
  for (const id of removedIds) releaseAudio(id);
  if (removedIds.has(state.loopTextId)) state.loopTextId = null;
  state.selectedIds = new Set([...state.selectedIds].filter((id) => !removedIds.has(id)));
  if (removedIds.has(state.selectedId)) state.selectedId = [...state.selectedIds].at(-1) ?? null;
  state.playhead = Math.min(state.playhead, projectDuration());
  renderAll();
  showToast(`Đã xóa ${removedIds.size} ${description}. Ctrl+Z để hoàn tác.`);
}

function deleteSelectedClip() {
  syncSelection();
  if (!state.selectedIds.size) return;
  const selected = new Set(state.selectedIds);
  deleteClips((clip) => selected.has(clip.id), 'clip đã chọn');
}

function deleteClipsOfKind(kind) {
  if (kind === 'all') { deleteClips(() => true, 'clip, timeline đã trống'); return; }
  if (!CLIP_KINDS.includes(kind)) return;
  deleteClips((clip) => clipKind(clip, state.assets) === kind, CLIP_KIND_NAMES[kind]);
}

function renderBulkMenu() {
  syncSelection();
  const counts = { ...countClipKinds(state.clips, state.assets), selected: state.selectedIds.size, all: state.clips.length };
  for (const button of elements['bulk-delete-menu'].querySelectorAll('[data-delete]')) {
    const count = counts[button.dataset.delete] ?? 0;
    button.querySelector('.bulk-count').textContent = String(count);
    button.disabled = count === 0;
  }
}

// The timeline usually sits at the bottom of the window, so the menu opens upward, right-aligned to
// its button. When the toolbar is near the top (narrow, scrolled layouts) it flips below instead.
const bulkMenuAnchor = () => document.getElementById('bulk-delete-button').getBoundingClientRect();

function placeBulkMenuAbove() {
  const anchor = bulkMenuAnchor();
  const menu = elements['bulk-delete-menu'];
  menu.style.right = `${Math.max(VIEWPORT_MARGIN, window.innerWidth - anchor.right)}px`;
  menu.style.top = 'auto';
  menu.style.bottom = `${Math.max(VIEWPORT_MARGIN, window.innerHeight - anchor.top + BULK_MENU_GAP)}px`;
}

// Runs once the menu is open: a closed popover has no size to measure.
function flipBulkMenuIfClipped() {
  const menu = elements['bulk-delete-menu'];
  if (menu.getBoundingClientRect().top >= VIEWPORT_MARGIN) return;
  menu.style.bottom = 'auto';
  menu.style.top = `${bulkMenuAnchor().bottom + BULK_MENU_GAP}px`;
}

function bindBulkDelete() {
  const menu = elements['bulk-delete-menu'];
  menu.addEventListener('beforetoggle', (event) => {
    if (event.newState !== 'open') return;
    renderBulkMenu();
    placeBulkMenuAbove();
  });
  menu.addEventListener('toggle', (event) => { if (event.newState === 'open') flipBulkMenuIfClipped(); });
  menu.addEventListener('click', (event) => {
    const button = event.target.closest('[data-delete]');
    if (!button || button.disabled) return;
    menu.hidePopover();
    if (button.dataset.delete === 'selected') deleteSelectedClip();
    else deleteClipsOfKind(button.dataset.delete);
  });
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
  if (event.ctrlKey || event.metaKey || event.shiftKey) { extendSelection(clip, event.shiftKey); return; }
  state.selectedId = clip.id;
  state.selectedIds = new Set([clip.id]);
  recordEdit();
  state.drag = { id: clip.id, x: event.clientX, pointerX: event.clientX, start: clip.start,
    sourceStart: clip.sourceStart, duration: clip.duration,
    mode: event.target.dataset.mode || 'move', element: null };
  renderInspector();
  renderTimeline();
  state.drag.element = elements['timeline-canvas'].querySelector(`.clip[data-clip-id="${CSS.escape(clip.id)}"]`);
}

// Pointer events can fire several times per frame; apply only the latest position once per frame.
function moveClipDrag(event) {
  if (!state.drag) return;
  state.drag.pointerX = event.clientX;
  if (!state.dragFrame) state.dragFrame = requestAnimationFrame(applyClipDrag);
}

function updateDraggedClipElement(clip) {
  const element = state.drag?.element;
  if (!element?.isConnected) { renderTimeline(); return; }
  element.style.left = `${clip.start * state.zoom}px`;
  element.style.width = `${Math.max(clip.duration * state.zoom, 12)}px`;
  element.querySelector('.clip-duration').textContent = `${roundTime(clip.duration)}s`;
}

function applyClipDrag() {
  state.dragFrame = 0;
  const drag = state.drag;
  if (!drag) return;
  const clip = state.clips.find((item) => item.id === drag.id);
  if (!clip) { stopClipDrag(); return; }
  const asset = getAsset(clip);
  const delta = roundTime((drag.pointerX - drag.x) / state.zoom);
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
  updateDraggedClipElement(clip);
  renderInspector();
  syncPreview();
}

function stopClipDrag() {
  if (!state.drag) return;
  if (state.dragFrame) { cancelAnimationFrame(state.dragFrame); applyClipDrag(); }
  state.drag = null;
  recordEdit();
  renderTimeline();
  renderInspector();
}

function setExportProgress(progress) {
  const percent = Math.round(clamp(progress, 0, 1) * 100);
  elements['export-progress-bar'].style.width = `${percent}%`;
  elements['export-percent'].textContent = `${percent}%`;
}

const EXPORT_BACKGROUND = '#080a0d';
// MP4 first: Chrome/Edge record H.264 + AAC directly; other browsers fall back to WebM.
const REALTIME_MIME_TYPES = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

function getExportMimeType() {
  return REALTIME_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

const extensionForMime = (mimeType) => mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';

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

// Real-time path: the visual layer is cached separately so a video that is still loading after a
// clip change holds its last frame instead of recording black frames.
function updateExportFrame() {
  if (!state.exportCanvas) return;
  const { width, height } = state.exportCanvas;
  const clip = activeVisualClip();
  const asset = clip ? getAsset(clip) : null;
  const video = asset?.kind === 'video' ? elements['preview-video'] : null;
  if (!video || (video.readyState >= 2 && state.previewFrameReady !== false)) {
    const visual = state.exportVisual.getContext('2d');
    visual.fillStyle = EXPORT_BACKGROUND;
    visual.fillRect(0, 0, width, height);
    if (asset?.kind === 'image') drawContained(visual, asset.image, width, height);
    if (video) drawContained(visual, video, width, height);
  }
  const context = state.exportCanvas.getContext('2d');
  context.drawImage(state.exportVisual, 0, 0);
  drawTextClips(context, state.clips, state.playhead, width, height);
  setExportProgress(state.playhead / projectDuration());
}

function exportFileName(extension) {
  const safeName = elements['project-name'].value.trim().replace(/[\\/:*?"<>|]/g, '-').slice(0, 60) || 'video-studio';
  return `${safeName}-${state.exportSettings.height}p.${extension}`;
}

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function lockExportUi(status) {
  state.exporting = true; state.exportCancelled = false;
  elements['start-export'].disabled = true; elements['export-resolution'].disabled = true;
  if (elements['export-mode']) elements['export-mode'].disabled = true;
  document.querySelector('.app-shell').inert = true;
  elements['cancel-export'].textContent = 'Hủy xuất';
  elements['export-status'].textContent = status;
}

function unlockExportUi() {
  state.exporting = false;
  document.querySelector('.app-shell').inert = false;
  elements['start-export'].disabled = false;
  elements['export-resolution'].disabled = false;
  if (elements['export-mode']) elements['export-mode'].disabled = false;
  elements['cancel-export'].textContent = 'Đóng';
}

function finishExport(chunks, mimeType) {
  if (!state.exportCancelled && chunks.length) {
    downloadBlob(new Blob(chunks, { type: mimeType }), exportFileName(extensionForMime(mimeType)));
    setExportProgress(1);
    elements['export-status'].textContent = 'Hoàn tất';
    showToast('Video đã sẵn sàng để tải xuống.');
  }
  state.exportStream?.getVideoTracks().forEach((track) => track.stop());
  state.exportStream = null;
  state.exportCanvas = null;
  state.exportVisual = null;
  state.recorder = null;
  unlockExportUi();
}

function stopExport(cancelled) {
  if (state.exportAbort) { state.exportAbort.abort(); return; }
  state.exportCancelled = cancelled;
  pausePlayback();
  if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  else if (!state.recorder) { state.exportRun++; finishExport([], 'video/webm'); }
  if (cancelled) elements['export-status'].textContent = 'Đã hủy';
}

// Browsers throttle requestAnimationFrame in background tabs, which would freeze the real-time
// recording while audio keeps going. Pause the recorder until the tab is visible again.
function handleExportVisibility(hidden) {
  const recorder = state.recorder;
  if (!state.exporting || !recorder) return;
  if (hidden && recorder.state === 'recording') {
    pausePlayback(); recorder.pause();
    elements['export-status'].textContent = 'Tạm dừng: quay lại tab này để tiếp tục ghi';
  } else if (!hidden && recorder.state === 'paused') {
    recorder.resume(); startPlayback();
    elements['export-status'].textContent = 'Đang ghi video…';
  }
}

async function waitForPreviewFrame() {
  const clip = activeVisualClip();
  const video = clip && getAsset(clip).kind === 'video' ? elements['preview-video'] : null;
  if (!video) return;
  const deadline = performance.now() + EXPORT_FRAME_WAIT_MS;
  while ((video.readyState < 2 || state.previewFrameReady === false) && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, EXPORT_FRAME_POLL_MS));
  }
}

function exportMode() {
  return elements['export-mode']?.value === 'realtime' || !supportsOfflineExport() ? 'realtime' : 'offline';
}

function updateExportSettings() {
  if (state.exporting) return;
  state.exportSettings = exportPreset(elements['export-resolution'].value);
  const settings = state.exportSettings;
  elements['stage-resolution'].textContent = `Xuất ${settings.width} × ${settings.height}`;
  const offline = typeof supportsOfflineExport === 'function' && exportMode() === 'offline';
  elements['export-message'].textContent = offline
    ? `MP4 ${settings.height}p (${settings.width} × ${settings.height}), ${settings.fps} fps, kèm chữ karaoke. Dựng từng khung hình bằng WebCodecs: nhanh hơn thời gian thực, không mất hình khi chuyển clip hay đổi tab.`
    : `Video ${settings.height}p (${settings.width} × ${settings.height}), ${settings.fps} fps, kèm chữ karaoke. Ghi theo thời gian thực; giữ tab này mở trong lúc xuất.`;
}

async function startExport() {
  if (state.exporting) return;
  if (!projectDuration()) { showToast('Timeline đang trống.'); return; }
  updateExportSettings();
  if (exportMode() === 'offline') await startOfflineExport();
  else await startRealtimeExport();
}

async function pickExportFile(estimatedBytes) {
  if (estimatedBytes < STREAM_EXPORT_BYTES || typeof window.showSaveFilePicker !== 'function') return null;
  const handle = await window.showSaveFilePicker({ suggestedName: exportFileName('mp4'), types: [{ description: 'Video MP4', accept: { 'video/mp4': ['.mp4'] } }] });
  return handle.createWritable();
}

function reportOfflineProgress(fraction, duration, startedAt) {
  setExportProgress(fraction);
  const elapsed = (performance.now() - startedAt) / 1000;
  const speed = elapsed > 0.5 ? ` · ${(fraction * duration / elapsed).toFixed(1)}× thời gian thực` : '';
  elements['export-status'].textContent = `Đang dựng khung hình${speed}`;
}

async function startOfflineExport() {
  const settings = state.exportSettings, duration = projectDuration();
  const controller = new AbortController();
  state.exportAbort = controller;
  lockExportUi('Đang chuẩn bị bộ mã hóa…');
  setExportProgress(0);
  pausePlayback(); state.loopTextId = null;
  const startedAt = performance.now();
  let fallbackReason = null;
  try {
    const writable = await pickExportFile(estimatedExportBytes(duration, settings.bitrate));
    const result = await renderOfflineExport({ clips: structuredClone(state.clips), assets: state.assets, duration, settings,
      globalMute: state.globalMute, drawText: drawTextClips, signal: controller.signal, writable,
      onProgress: (fraction) => reportOfflineProgress(fraction, duration, startedAt) });
    if (result.blob) downloadBlob(result.blob, exportFileName(result.extension));
    setExportProgress(1);
    const streams = result.encoders > 1 ? ` · ${result.encoders} luồng mã hóa` : '';
    elements['export-status'].textContent = `Hoàn tất · ${result.isMp4 ? 'MP4 H.264' : 'WebM'}${streams} · ${Math.round((performance.now() - startedAt) / 1000)} giây`;
    showToast(writable ? 'Đã lưu video vào tệp đã chọn.' : 'Video đã sẵn sàng để tải xuống.');
  } catch (error) {
    if (controller.signal.aborted || error?.name === 'AbortError') elements['export-status'].textContent = 'Đã hủy';
    else if (error instanceof ExportDecodeError) fallbackReason = error.message;
    else { elements['export-status'].textContent = 'Lỗi xuất'; showToast(error instanceof Error ? error.message : 'Xuất video thất bại.'); }
  } finally {
    state.exportAbort = null;
    unlockExportUi();
  }
  if (fallbackReason) {
    showToast(`${fallbackReason} Chuyển sang ghi theo thời gian thực.`);
    await startRealtimeExport();
  }
}

async function startRealtimeExport() {
  if (state.exporting) return;
  if (!projectDuration()) { showToast('Timeline đang trống.'); return; }
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream || !window.AudioContext) {
    showToast('Trình duyệt này chưa hỗ trợ xuất video.');
    return;
  }
  const mimeType = getExportMimeType();
  if (!mimeType) { showToast('Trình duyệt này chưa hỗ trợ ghi MP4/WebM.'); return; }
  updateExportSettings();
  const run = ++state.exportRun;
  lockExportUi('Đang chuẩn bị…');
  try {
    pausePlayback();
    state.loopTextId = null;
    seekTo(0);
    const { width, height, fps, bitrate } = state.exportSettings;
    state.exportCanvas = Object.assign(document.createElement('canvas'), { width, height });
    state.exportVisual = Object.assign(document.createElement('canvas'), { width, height });
    const videoStream = state.exportCanvas.captureStream(fps);
    state.exportStream = new MediaStream(videoStream.getVideoTracks());
    const audioStream = await ensureAudioGraph();
    await waitForPreviewFrame();
    if (run !== state.exportRun || state.exportCancelled) { videoStream.getVideoTracks().forEach(track => track.stop()); return; }
    for (const track of audioStream.getAudioTracks()) state.exportStream.addTrack(track);
    const recorder = new MediaRecorder(state.exportStream, { mimeType, videoBitsPerSecond: bitrate });
    const chunks = [];
    recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
    recorder.onerror = () => { stopExport(true); showToast('Xuất video thất bại.'); };
    recorder.onstop = () => finishExport(chunks, mimeType);
    state.recorder = recorder;
    elements['export-status'].textContent = 'Đang ghi video…';
    setExportProgress(0);
    updateExportFrame();
    recorder.start(1000);
    startPlayback();
  } catch (error) {
    if (run !== state.exportRun) return;
    state.exportCancelled = true;
    if (state.recorder?.state === 'recording') state.recorder.stop();
    else finishExport([], mimeType);
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
  bindBulkDelete();
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
  elements['timeline-scroll'].setAttribute('aria-label', 'Timeline. Ctrl hoặc Shift khi nhấn clip để chọn nhiều, Ctrl A chọn tất cả, Delete xóa clip đã chọn, Ctrl Z hoàn tác, S chia clip, T thêm chữ.');
  const observer = new ResizeObserver(resizeStage); observer.observe(document.querySelector('.stage-wrap'));
  resizeStage();
  elements['export-button'].addEventListener('click', () => {
    if (!projectDuration()) { showToast('Hãy thêm media vào timeline trước.'); return; }
    updateExportSettings();
    elements['export-dialog'].showModal();
    // Warm the encoder library while the user reads the dialog; a failure is reported again on start.
    if (exportMode() === 'offline') loadMediabunny().catch((error) => { elements['export-status'].textContent = error.message; });
  });
  elements['export-mode'].addEventListener('change', updateExportSettings);
  elements['close-export'].addEventListener('click', () => { if (state.exporting) stopExport(true); elements['export-dialog'].close(); });
  elements['cancel-export'].addEventListener('click', () => { if (state.exporting) stopExport(true); else elements['export-dialog'].close(); });
  elements['export-resolution'].addEventListener('change', updateExportSettings);
  setupPrecisionWheel({state, elements, renderTimeline, seekTo, pausePlayback});
  elements['start-export'].addEventListener('click', () => { void startExport(); });
  elements['export-dialog'].addEventListener('cancel', () => { if (state.exporting) stopExport(true); });
  window.addEventListener('beforeunload', event => {
    if (state.drag) stopClipDrag();
    if (sessionAutosaver?.pending || mediaImports || unsavedWithoutStore) {
      void sessionAutosaver?.flush();event.preventDefault();event.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    handleExportVisibility(hidden);
    if (hidden) {saveSession();void sessionAutosaver?.flush();}
  });
  // Capture view changes and unfinished AI drafts, including controls outside renderAll.
  for (const type of ['input','change']) document.addEventListener(type, event => {
    if (event.target.type !== 'password' && event.target.type !== 'file') saveSession();
  });
  let viewTimer;
  const saveView = () => {clearTimeout(viewTimer);viewTimer=setTimeout(saveSession,200);};
  elements['timeline-scroll'].addEventListener('scroll',saveView);
  elements['timeline-scroll'].addEventListener('scroll',onTimelineScroll,{passive:true});
  document.addEventListener('pointerup',saveView);
  document.addEventListener('wheel',saveView,{passive:true});
  document.getElementById('retry-session-save').onclick=()=>{saveSession();void sessionAutosaver?.flush();};
}

const karaokeUI = setupKaraoke({ state, elements, renderAll, renderTimeline, syncPreview, seekTo, startPlayback, pausePlayback, showToast, getSelectedClip, recordEdit, revealClip, duplicateSelectedClip });
const aiLyricsUI = setupAILyrics({ state, elements, getSelectedClip, pausePlayback, renderAll, revealClip, showToast, onSessionChange:saveSession });
bindEvents();
renderAll();
void restoreSession();

function sessionStatus(status,error) {
  const label=document.getElementById('session-status'),retry=document.getElementById('retry-session-save');
  label.dataset.status=status;
  label.textContent=status==='saving'?'● Đang lưu phiên…':status==='saved'?'● Đã lưu trên trình duyệt · F5 để tiếp tục':
    error?.name==='QuotaExceededError'?'Không đủ dung lượng để lưu. Giữ tab này mở và giải phóng dung lượng.':
    (error?.message || 'Không thể tự lưu. Giữ tab này mở và thử lại.');
  retry.hidden=status!=='error'||!sessionAutosaver||error?.name==='SessionConflictError';
}
async function restoreSession() {
  const shell=document.querySelector('.app-shell');shell.inert=true;
  const store=createSessionStore();
  try {
    const loaded=await store.load(),project=loaded.project;
    if(project) {
      const restored=new Map();
      try {
        for(const item of loaded.assets) {
          const file=new File([item.file],item.name,{type:item.type,lastModified:item.lastModified});
          const asset={...item,file,url:URL.createObjectURL(file),image:null};restored.set(asset.id,asset);
          if(asset.kind==='image'){asset.image=new Image();asset.image.src=asset.url;await asset.image.decode();}
        }
        for(const clip of project.clips)if(clip.track!=='text'&&!restored.has(clip.assetId))throw new Error('Thiếu media trong phiên lưu. Bản lưu được giữ nguyên.');
      } catch(error){for(const a of restored.values())URL.revokeObjectURL(a.url);throw error;}
      state.assets=new Map(project.assetIds.map(id=>[id,restored.get(id)]));state.clips=project.clips;
      state.selectedId=project.selectedId;state.playhead=clamp(project.playhead||0,0,projectDuration());
      state.zoom=clamp(project.zoom||52,24,600);state.globalMute=!!project.globalMute;
      state.beats=Array.isArray(project.beats)?project.beats.filter(Number.isFinite):[];
      state.previewSpeed=[.5,.75,1].includes(project.previewSpeed)?project.previewSpeed:1;
      elements['project-name'].value=project.projectName||'Dự án mới';
      elements['zoom-slider'].value=state.zoom;document.getElementById('preview-speed').value=state.previewSpeed;
      elements['export-resolution'].value=project.exportResolution==='720'?'720':'1080';updateExportSettings();
      editHistory=new EditHistory(snapshotProject());
      if(project.history){editHistory.past=project.history.past.slice(-100);editHistory.future=project.history.future.slice(-100);}
      updateGlobalMuteButton();renderAssets();renderAll();
      aiLyricsUI.restore(project.aiDraft);
      elements['timeline-scroll'].scrollLeft=project.scrollLeft||0;elements['timeline-scroll'].scrollTop=project.scrollTop||0;
      showToast('Đã khôi phục phiên: media, timeline, lời và lịch sử chỉnh sửa.');
    }
    sessionAutosaver=new SessionAutosaver({store,revision:loaded.revision,assetIds:project?.assetIds||[],delayMs:AUTOSAVE_DELAY_MS,
      snapshot:()=>projectRecord({state,projectName:elements['project-name'].value,history:editHistory,
        aiDraft:aiLyricsUI.snapshot(),scrollLeft:elements['timeline-scroll'].scrollLeft,scrollTop:elements['timeline-scroll'].scrollTop}),
      assets:()=>[...state.assets.values()],onStatus:sessionStatus});
    restoringSession=false;sessionStatus('saved');
  } catch(error) {
    restoringSession=false;
    sessionStatus('error',new Error('Không khôi phục được phiên: '+error.message+' Không ghi đè bản lưu. Hãy thử mở lại trang.'));
  } finally {shell.inert=false;}
}
