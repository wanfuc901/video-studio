// Offline export: every frame is decoded by timestamp (WebCodecs via Mediabunny), drawn with the same
// karaoke renderer as the preview, then encoded. No real-time clock, so there are no black frames at
// clip boundaries and switching tabs cannot stall or desync the output.
//
// Long exports are split into time slices encoded in parallel. One hardware H.264 encoder in Chrome tops
// out near 175 fps at 1080p; two run at about 300 fps on the same GPU (more add nothing). Each slice
// starts on a key frame and all encoders share one configuration, so the packets are concatenated into
// a single track.
const MEDIABUNNY_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.3/dist/bundles/mediabunny.min.mjs';
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 192000;
const AUDIO_WINDOW_SECONDS = 10;
const KEY_FRAME_INTERVAL_SECONDS = 2;
const BACKGROUND_COLOR = '#080a0d';
const PARALLEL_SLICES = 2;
// Below this a second decoder and encoder cost more to start than they save.
const MIN_PARALLEL_SECONDS = 10;
const ENCODE_QUEUE_LIMIT = 8;
// Encoded packets of the slice being written that may wait for the muxer before rendering pauses.
const MUX_QUEUE_LIMIT = 90;
const CODEC_STRINGS = { avc: ['avc1.640028', 'avc1.4d0028', 'avc1.420028'], vp9: ['vp09.00.40.08', 'vp09.00.31.08'], vp8: ['vp8'] };

let mediabunnyPromise = null;
export function loadMediabunny(importer = url => import(url)) {
  mediabunnyPromise ||= importer(MEDIABUNNY_URL).catch(error => {
    mediabunnyPromise = null;
    throw new Error('Không tải được bộ xuất video. Kiểm tra mạng tới cdn.jsdelivr.net rồi thử lại.', { cause: error });
  });
  return mediabunnyPromise;
}

export const supportsOfflineExport = (scope = globalThis) =>
  ['VideoEncoder', 'AudioEncoder', 'VideoDecoder', 'AudioDecoder', 'OfflineAudioContext'].every(name => typeof scope[name] === 'function');

export class ExportDecodeError extends Error {
  constructor(fileName) {
    super(`${fileName}: trình duyệt không giải mã được tệp này bằng WebCodecs.`);
    this.name = 'ExportDecodeError';
  }
}

export const frameCountFor = (duration, fps) => Math.max(1, Math.ceil(duration * fps - 1e-6));

// Same rule as the preview: among visual clips covering `time`, the latest start is on top.
export function activeVisualAt(clips, time) {
  let active = null;
  for (const clip of clips) {
    if (clip.track !== 'visual' || time < clip.start || time >= clip.start + clip.duration) continue;
    if (!active || clip.start > active.start) active = clip;
  }
  return active;
}

// Groups consecutive frames that show the same visual clip, so each run decodes sequentially.
export function planFrameRuns(clips, duration, fps) {
  const runs = [];
  const total = frameCountFor(duration, fps);
  for (let frame = 0; frame < total; frame++) {
    const clip = activeVisualAt(clips, frame / fps);
    const last = runs.at(-1);
    if (last && last.clip?.id === clip?.id) last.count++;
    else runs.push({ clip, first: frame, count: 1 });
  }
  return runs;
}

// Frame runs clipped to [from, to): each slice decodes only its own part of the timeline.
export function runsBetween(runs, from, to) {
  const sliced = [];
  for (const run of runs) {
    const first = Math.max(run.first, from), end = Math.min(run.first + run.count, to);
    if (end > first) sliced.push({ clip: run.clip, first, count: end - first });
  }
  return sliced;
}

// Slice boundaries fall on key frames, so every slice can start a fresh encoder.
export function planSlices(total, fps, parts = PARALLEL_SLICES) {
  const keyFrameFrames = Math.round(KEY_FRAME_INTERVAL_SECONDS * fps);
  if (parts < 2 || total < MIN_PARALLEL_SECONDS * fps) return [[0, total]];
  const bounds = [0];
  for (let index = 1; index < parts; index++) bounds.push(Math.round(total * index / parts / keyFrameFrames) * keyFrameFrames);
  bounds.push(total);
  return bounds.slice(0, -1).map((from, index) => [from, bounds[index + 1]]).filter(([from, to]) => to > from);
}

// Audible timeline ranges. A video clip is heard only while it is the visible clip, like the preview.
export function planAudioSegments({ clips, runs, fps, assets, globalMute }) {
  if (globalMute) return [];
  const audible = clip => clip && !clip.muted && clip.volume > 0;
  const segments = [];
  for (const run of runs) {
    if (!audible(run.clip) || assets.get(run.clip.assetId)?.kind !== 'video') continue;
    const start = run.first / fps, end = (run.first + run.count) / fps;
    const previous = segments.at(-1);
    if (previous && previous.clip.id === run.clip.id && Math.abs(previous.end - start) < 1e-9) previous.end = end;
    else segments.push({ clip: run.clip, start, end });
  }
  for (const clip of clips) {
    if (clip.track === 'audio' && audible(clip) && assets.get(clip.assetId)?.kind === 'audio') {
      segments.push({ clip, start: clip.start, end: clip.start + clip.duration });
    }
  }
  return segments;
}

export function estimatedExportBytes(duration, videoBitrate) {
  return Math.ceil(duration * (videoBitrate + AUDIO_BITRATE) / 8);
}

const bytesOf = (data) => {
  if (!data) return null;
  return ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
};

// Concatenated slices form one track only if every encoder produced the same stream configuration.
export function sameDecoderConfig(first, second) {
  if (!first || !second) return first === second;
  if (first.codec !== second.codec || first.codedWidth !== second.codedWidth || first.codedHeight !== second.codedHeight) return false;
  const a = bytesOf(first.description), b = bytesOf(second.description);
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((byte, index) => byte === b[index]);
}

function drawContained(context, source, width, height) {
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
  if (!sourceWidth || !sourceHeight) return;
  const scale = Math.min(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale, drawHeight = sourceHeight * scale;
  context.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Export cancelled', 'AbortError');
}

// Resolves on the next `type` event; rejects with the abort reason instead of waiting forever.
function nextEvent(target, type, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { target.removeEventListener(type, onEvent); reject(signal.reason); };
    const onEvent = () => { signal.removeEventListener('abort', onAbort); resolve(); };
    target.addEventListener(type, onEvent, { once: true });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function chooseCodecs(mb, { width, height, bitrate }) {
  const videoCodec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'vp8'], { width, height, bitrate });
  if (!videoCodec) throw new Error('Trình duyệt không có bộ mã hóa video WebCodecs phù hợp.');
  const isMp4 = videoCodec === 'avc';
  const audioCodec = await mb.getFirstEncodableAudioCodec(isMp4 ? ['aac', 'opus'] : ['opus', 'vorbis'],
    { numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE, bitrate: AUDIO_BITRATE });
  return { videoCodec, audioCodec, isMp4 };
}

// Every slice encoder gets this exact configuration; 'avc' format keeps SPS/PPS out of band, as MP4 needs.
async function encoderConfigFor(videoCodec, { width, height, fps, bitrate }) {
  for (const codec of CODEC_STRINGS[videoCodec] || []) {
    const config = { codec, width, height, bitrate, framerate: fps, latencyMode: 'quality', ...(videoCodec === 'avc' ? { avc: { format: 'avc' } } : {}) };
    if ((await VideoEncoder.isConfigSupported(config)).supported) return config;
  }
  throw new Error('Trình duyệt không có bộ mã hóa video WebCodecs phù hợp.');
}

class MediaInputs {
  constructor(mb, { width, height }) { Object.assign(this, { mb, width, height }); this.entries = new Map(); }
  async entry(asset) {
    if (this.entries.has(asset.id)) return this.entries.get(asset.id);
    const input = new this.mb.Input({ source: new this.mb.BlobSource(asset.file), formats: this.mb.ALL_FORMATS });
    const entry = { input, videoSink: null, audioSink: null, videoChecked: false, audioChecked: false };
    this.entries.set(asset.id, entry);
    return entry;
  }
  async videoSink(asset) {
    const entry = await this.entry(asset);
    if (entry.videoChecked) return entry.videoSink;
    entry.videoChecked = true;
    const track = await entry.input.getPrimaryVideoTrack();
    if (!track) return null;
    if (!(await track.canDecode())) throw new ExportDecodeError(asset.file.name);
    entry.videoSink = new this.mb.CanvasSink(track, { width: this.width, height: this.height, fit: 'contain', poolSize: 2 });
    return entry.videoSink;
  }
  async audioSink(asset) {
    const entry = await this.entry(asset);
    if (entry.audioChecked) return entry.audioSink;
    entry.audioChecked = true;
    const track = await entry.input.getPrimaryAudioTrack();
    if (!track) return null;
    if (!(await track.canDecode())) throw new ExportDecodeError(asset.file.name);
    entry.audioSink = new this.mb.AudioBufferSink(track);
    return entry.audioSink;
  }
  dispose() { for (const { input } of this.entries.values()) input.dispose(); this.entries.clear(); }
}

async function scheduleSegmentAudio(context, segment, from, to, sink) {
  const { clip } = segment;
  const overlapStart = Math.max(from, segment.start), overlapEnd = Math.min(to, segment.end);
  if (overlapEnd <= overlapStart) return;
  const gain = context.createGain();
  gain.gain.value = clip.volume;
  gain.connect(context.destination);
  const sourceFrom = clip.sourceStart + overlapStart - clip.start;
  const sourceTo = clip.sourceStart + overlapEnd - clip.start;
  for await (const { buffer, timestamp } of sink.buffers(sourceFrom, sourceTo)) {
    const bufferAt = clip.start + timestamp - clip.sourceStart;
    const playFrom = Math.max(bufferAt, overlapStart);
    const offset = playFrom - bufferAt;
    const length = Math.min(buffer.duration - offset, overlapEnd - playFrom);
    if (length <= 0) continue;
    const node = context.createBufferSource();
    node.buffer = buffer;
    node.connect(gain);
    node.start(playFrom - from, offset, length);
  }
}

async function renderAudioWindow({ from, to, segments, inputs, assets }) {
  const length = Math.max(1, Math.round((to - from) * AUDIO_SAMPLE_RATE));
  const context = new OfflineAudioContext(AUDIO_CHANNELS, length, AUDIO_SAMPLE_RATE);
  for (const segment of segments) {
    if (segment.end <= from || segment.start >= to) continue;
    const sink = await inputs.audioSink(assets.get(segment.clip.assetId));
    if (sink) await scheduleSegmentAudio(context, segment, from, to, sink);
  }
  return context.startRendering();
}

// Runs beside the video slices with its own decoders; the muxer interleaves the two tracks.
async function addAudioTrack({ audioSource, duration, segments, assets, job }) {
  if (!audioSource) return;
  const inputs = new MediaInputs(job.mb, job.settings);
  try {
    for (let from = 0; from < duration; from += AUDIO_WINDOW_SECONDS) {
      const to = Math.min(duration, from + AUDIO_WINDOW_SECONDS);
      await audioSource.add(await renderAudioWindow({ from, to, segments, inputs, assets }));
      throwIfAborted(job.signal);
    }
    audioSource.close();
  } finally { inputs.dispose(); }
}

async function createOutput(mb, { codecs, settings, writable }) {
  const format = codecs.isMp4
    ? new mb.Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' })
    : new mb.WebMOutputFormat();
  const target = writable ? new mb.StreamTarget(writable, { chunked: true }) : new mb.BufferTarget();
  const output = new mb.Output({ format, target });
  const videoSource = new mb.EncodedVideoPacketSource(codecs.videoCodec);
  output.addVideoTrack(videoSource, { frameRate: settings.fps });
  let audioSource = null;
  if (codecs.audioCodec) {
    audioSource = new mb.AudioBufferSource({ codec: codecs.audioCodec, bitrate: AUDIO_BITRATE });
    output.addAudioTrack(audioSource);
  }
  await output.start();
  return { output, format, target, videoSource, audioSource };
}

// Encoded packets of one time slice, in decode order. Slices are written one after another; only the
// slice being written applies backpressure, later ones buffer until their turn.
class EncodedSlice extends EventTarget {
  constructor(index, from, to, parentSignal) {
    super();
    Object.assign(this, { index, from, to, chunks: [], config: undefined, finished: false, dropped: false, live: index === 0, rendered: 0 });
    this.controller = new AbortController();
    this.signal = AbortSignal.any([parentSignal, this.controller.signal]);
  }
  push(chunk, meta) {
    if (this.config === undefined) this.config = meta?.decoderConfig ?? null;
    this.chunks.push({ chunk, meta });
    this.changed();
  }
  finish() { this.finished = true; this.changed(); }
  fail(error) { this.controller.abort(error); this.changed(); }
  changed() { this.dispatchEvent(new Event('change')); }
  async room() { while (this.live && this.chunks.length >= MUX_QUEUE_LIMIT) await nextEvent(this, 'change', this.signal); }
}

// The previous slice takes over the frames of a slice whose encoder could not join the shared stream.
function dropSlice(slices, slice, job) {
  const previous = slices[slice.index - 1];
  if (!previous || previous.finished || previous.dropped) return false;
  slice.dropped = true;
  previous.to = slice.to;
  job.forget(slice);
  slice.controller.abort(new DOMException('Slice merged into the previous one', 'AbortError'));
  slice.changed();
  previous.changed();
  return true;
}

function drawFrame(context, { decoded, asset, width, height }) {
  context.fillStyle = BACKGROUND_COLOR;
  context.fillRect(0, 0, width, height);
  if (decoded) context.drawImage(decoded.canvas, 0, 0, width, height);
  else if (asset?.kind === 'image' && asset.image) drawContained(context, asset.image, width, height);
}

async function encodeCanvas(encoder, canvas, { index, fps, keyFrame, signal }) {
  const frame = new VideoFrame(canvas, { timestamp: Math.round(index * 1e6 / fps), duration: Math.round(1e6 / fps) });
  try { encoder.encode(frame, { keyFrame }); } finally { frame.close(); }
  while (encoder.encodeQueueSize >= ENCODE_QUEUE_LIMIT) await nextEvent(encoder, 'dequeue', signal);
}

async function encodeRun(run, slice, { inputs, context, canvas, encoder }, job) {
  const { width, height, fps } = job.settings;
  const asset = run.clip ? job.assets.get(run.clip.assetId) : null;
  const sink = asset?.kind === 'video' ? await inputs.videoSink(asset) : null;
  const times = Array.from({ length: run.count }, (_, offset) => (run.first + offset) / fps);
  const frames = sink ? sink.canvasesAtTimestamps(times.map(time => run.clip.sourceStart + time - run.clip.start)) : null;
  try {
    for (let offset = 0; offset < run.count; offset++) {
      const index = run.first + offset;
      const decoded = frames ? (await frames.next()).value : null;
      drawFrame(context, { decoded, asset, width, height });
      job.drawText(context, job.clips, times[offset], width, height);
      const keyFrame = index === slice.from || index % job.keyFrameFrames === 0;
      await encodeCanvas(encoder, canvas, { index, fps, keyFrame, signal: slice.signal });
      throwIfAborted(slice.signal);
      job.frameDone(slice);
      await slice.room();
    }
  } finally { await frames?.return?.(); }
  return run.first + run.count;
}

async function renderSlice(slice, job) {
  const { width, height } = job.settings;
  const canvas = job.createCanvas(width, height);
  const tools = { canvas, context: canvas.getContext('2d', { alpha: false }), inputs: new MediaInputs(job.mb, job.settings) };
  tools.encoder = new VideoEncoder({ output: (chunk, meta) => slice.push(chunk, meta), error: (error) => slice.fail(error) });
  try {
    tools.encoder.configure(job.encoderConfig);
    let frame = slice.from;
    // `slice.to` grows when the next slice is dropped, possibly while this one is flushing.
    while (frame < slice.to) {
      for (const run of runsBetween(job.runs, frame, slice.to)) frame = await encodeRun(run, slice, tools, job);
      await tools.encoder.flush();
      throwIfAborted(slice.signal);
    }
    slice.finish();
  } finally {
    if (tools.encoder.state !== 'closed') tools.encoder.close();
    tools.inputs.dispose();
  }
}

async function runSlice(slice, slices, job) {
  try {
    await renderSlice(slice, job);
  } catch (error) {
    if (slice.dropped) return;
    // A second encoder that fails before its first packet (e.g. no free hardware session) is not fatal.
    if (slice.config === undefined && !job.signal.aborted && dropSlice(slices, slice, job)) return;
    throw error;
  }
}

async function settleDecoderConfigs(slices, job) {
  for (const slice of slices) {
    while (slice.config === undefined && !slice.dropped && !slice.finished) await nextEvent(slice, 'change', job.signal);
  }
  for (const slice of slices.slice(1)) {
    if (!slice.dropped && !sameDecoderConfig(slices[0].config, slice.config)) dropSlice(slices, slice, job);
  }
}

async function muxSlices(slices, videoSource, job) {
  await settleDecoderConfigs(slices, job);
  let first = true;
  for (const slice of slices) {
    if (slice.dropped) continue;
    slice.live = true;
    slice.changed();
    for (;;) {
      if (slice.chunks.length) {
        const { chunk, meta } = slice.chunks.shift();
        slice.changed();
        await videoSource.add(job.mb.EncodedPacket.fromEncodedChunk(chunk), first ? meta : undefined);
        first = false;
      } else if (slice.finished) break;
      else await nextEvent(slice, 'change', job.signal);
    }
  }
  videoSource.close();
}

// The first failure stops every other task; its reason (e.g. the user's cancel) is the one reported.
function runTogether(tasks, controller) {
  return Promise.all(tasks.map(task => task.catch(error => {
    if (!controller.signal.aborted) controller.abort(error);
    throw controller.signal.reason;
  })));
}

/**
 * Renders the project to MP4 (H.264 + AAC/Opus) or WebM when H.264 is unavailable.
 * @param {object} options
 * @param {Array} options.clips Immutable copy of the timeline clips.
 * @param {Map} options.assets Asset library (file, kind, decoded image).
 * @param {number} options.duration Project duration in seconds.
 * @param {{width:number,height:number,fps:number,bitrate:number}} options.settings
 * @param {(ctx:CanvasRenderingContext2D, clips:Array, time:number, w:number, h:number)=>void} options.drawText
 * @param {WritableStream} [options.writable] File stream for large exports; otherwise kept in memory.
 */
export async function renderOfflineExport({ clips, assets, duration, settings, globalMute, drawText, signal, onProgress = () => {}, writable = null, createCanvas, mediabunny }) {
  const mb = mediabunny || await loadMediabunny();
  throwIfAborted(signal);
  const codecs = await chooseCodecs(mb, settings);
  const encoderConfig = await encoderConfigFor(codecs.videoCodec, settings);
  const runs = planFrameRuns(clips, duration, settings.fps);
  const total = runs.reduce((sum, run) => sum + run.count, 0);
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', forwardAbort, { once: true });
  let encoded = 0;
  const job = { mb, settings, runs, assets, clips, drawText, encoderConfig, signal: controller.signal,
    keyFrameFrames: Math.round(KEY_FRAME_INTERVAL_SECONDS * settings.fps),
    createCanvas: createCanvas || ((width, height) => Object.assign(document.createElement('canvas'), { width, height })),
    frameDone: (slice) => { slice.rendered++; onProgress(Math.min(1, ++encoded / total)); },
    forget: (slice) => { encoded -= slice.rendered; } };
  const slices = planSlices(total, settings.fps).map(([from, to], index) => new EncodedSlice(index, from, to, controller.signal));
  const segments = planAudioSegments({ clips, runs, fps: settings.fps, assets, globalMute });
  const media = await createOutput(mb, { codecs, settings, writable });
  try {
    await runTogether([...slices.map(slice => runSlice(slice, slices, job)), muxSlices(slices, media.videoSource, job),
      addAudioTrack({ audioSource: media.audioSource, duration, segments, assets, job })], controller);
    await media.output.finalize();
    const blob = writable ? null : new Blob([media.target.buffer], { type: media.format.mimeType });
    const encoders = slices.filter(slice => !slice.dropped).length;
    return { blob, extension: media.format.fileExtension.replace(/^\./, ''), mimeType: media.format.mimeType, encoders, ...codecs };
  } catch (error) {
    if (!controller.signal.aborted) controller.abort(error);
    if (media.output.state !== 'finalized' && media.output.state !== 'canceled') {
      // The original error explains the failure; a cancel error here only means the encoder already closed.
      try { await media.output.cancel(); } catch (cancelError) { error.cleanupError = cancelError; }
    }
    throw error;
  } finally { signal?.removeEventListener('abort', forwardAbort); }
}
