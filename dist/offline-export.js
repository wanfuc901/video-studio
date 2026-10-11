// Offline export: every frame is decoded by timestamp (WebCodecs via Mediabunny), drawn with the same
// karaoke renderer as the preview, then encoded. No real-time clock, so there are no black frames at
// clip boundaries and switching tabs cannot stall or desync the output.
const MEDIABUNNY_URL = 'https://cdn.jsdelivr.net/npm/mediabunny@1.61.3/dist/bundles/mediabunny.min.mjs';
const AUDIO_SAMPLE_RATE = 48000;
const AUDIO_CHANNELS = 2;
const AUDIO_BITRATE = 192000;
const AUDIO_WINDOW_SECONDS = 10;
const KEY_FRAME_INTERVAL_SECONDS = 2;
const BACKGROUND_COLOR = '#080a0d';

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

async function chooseCodecs(mb, { width, height, bitrate }) {
  const videoCodec = await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'vp8'], { width, height, bitrate });
  if (!videoCodec) throw new Error('Trình duyệt không có bộ mã hóa video WebCodecs phù hợp.');
  const isMp4 = videoCodec === 'avc';
  const audioCodec = await mb.getFirstEncodableAudioCodec(isMp4 ? ['aac', 'opus'] : ['opus', 'vorbis'],
    { numberOfChannels: AUDIO_CHANNELS, sampleRate: AUDIO_SAMPLE_RATE, bitrate: AUDIO_BITRATE });
  return { videoCodec, audioCodec, isMp4 };
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

async function createOutput(mb, { codecs, canvas, settings, writable }) {
  const format = codecs.isMp4
    ? new mb.Mp4OutputFormat({ fastStart: writable ? false : 'in-memory' })
    : new mb.WebMOutputFormat();
  const target = writable ? new mb.StreamTarget(writable, { chunked: true }) : new mb.BufferTarget();
  const output = new mb.Output({ format, target });
  const videoSource = new mb.CanvasSource(canvas, { codec: codecs.videoCodec, bitrate: settings.bitrate, keyFrameInterval: KEY_FRAME_INTERVAL_SECONDS });
  output.addVideoTrack(videoSource, { frameRate: settings.fps });
  let audioSource = null;
  if (codecs.audioCodec) {
    audioSource = new mb.AudioBufferSource({ codec: codecs.audioCodec, bitrate: AUDIO_BITRATE });
    output.addAudioTrack(audioSource);
  }
  await output.start();
  return { output, format, target, videoSource, audioSource };
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
  const { width, height, fps } = settings;
  const codecs = await chooseCodecs(mb, settings);
  const canvas = createCanvas ? createCanvas(width, height) : Object.assign(document.createElement('canvas'), { width, height });
  const context = canvas.getContext('2d', { alpha: false });
  const runs = planFrameRuns(clips, duration, fps);
  const segments = planAudioSegments({ clips, runs, fps, assets, globalMute });
  const inputs = new MediaInputs(mb, { width, height });
  const total = runs.reduce((sum, run) => sum + run.count, 0);
  const media = await createOutput(mb, { codecs, canvas, settings, writable });
  let audioCursor = 0, encoded = 0;
  const addAudioUntil = async time => {
    if (!media.audioSource) return;
    while (audioCursor < duration && audioCursor <= time) {
      const to = Math.min(duration, audioCursor + AUDIO_WINDOW_SECONDS);
      await media.audioSource.add(await renderAudioWindow({ from: audioCursor, to, segments, inputs, assets }));
      audioCursor = to;
      throwIfAborted(signal);
    }
  };
  try {
    for (const run of runs) {
      const asset = run.clip ? assets.get(run.clip.assetId) : null;
      const sink = asset?.kind === 'video' ? await inputs.videoSink(asset) : null;
      const times = Array.from({ length: run.count }, (_, index) => (run.first + index) / fps);
      const frames = sink ? sink.canvasesAtTimestamps(times.map(time => run.clip.sourceStart + time - run.clip.start)) : null;
      try {
        for (const time of times) {
          await addAudioUntil(time + AUDIO_WINDOW_SECONDS / 2);
          context.fillStyle = BACKGROUND_COLOR;
          context.fillRect(0, 0, width, height);
          if (frames) {
            const { value } = await frames.next();
            if (value) context.drawImage(value.canvas, 0, 0, width, height);
          } else if (asset?.kind === 'image' && asset.image) drawContained(context, asset.image, width, height);
          drawText(context, clips, time, width, height);
          await media.videoSource.add(time, 1 / fps);
          throwIfAborted(signal);
          onProgress(++encoded / total);
        }
      } finally { await frames?.return?.(); }
    }
    await addAudioUntil(duration);
    media.videoSource.close();
    media.audioSource?.close();
    await media.output.finalize();
    const blob = writable ? null : new Blob([media.target.buffer], { type: media.format.mimeType });
    return { blob, extension: media.format.fileExtension.replace(/^\./, ''), mimeType: media.format.mimeType, ...codecs };
  } catch (error) {
    if (media.output.state !== 'finalized' && media.output.state !== 'canceled') {
      // The original error explains the failure; a cancel error here only means the encoder already closed.
      try { await media.output.cancel(); } catch (cancelError) { error.cleanupError = cancelError; }
    }
    throw error;
  } finally { inputs.dispose(); }
}
