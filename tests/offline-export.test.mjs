import test from 'node:test';
import assert from 'node:assert/strict';
import { activeVisualAt, planFrameRuns, planAudioSegments, renderOfflineExport, frameCountFor, ExportDecodeError, supportsOfflineExport, planSlices, runsBetween, sameDecoderConfig } from '../dist/offline-export.js';

const video = (id, start, duration, extra = {}) => ({ id, track: 'visual', assetId: 'v', start, duration, sourceStart: 0, volume: 1, muted: false, ...extra });
const assets = new Map([
  ['v', { id: 'v', kind: 'video', file: { name: 'clip.mp4' } }],
  ['a', { id: 'a', kind: 'audio', file: { name: 'song.mp3' } }],
  ['i', { id: 'i', kind: 'image', file: { name: 'cover.png' }, image: { naturalWidth: 10, naturalHeight: 10 } }]
]);

test('later visual clip covers earlier one; frame runs are contiguous with no gaps at clip boundaries', () => {
  const clips = [video('a', 0, 2), video('b', 1, 2)];
  assert.equal(activeVisualAt(clips, 1.5).id, 'b');
  assert.equal(activeVisualAt(clips, 0.5).id, 'a');
  const runs = planFrameRuns(clips, 3, 10);
  assert.deepEqual(runs.map(r => [r.clip?.id, r.first, r.count]), [['a', 0, 10], ['b', 10, 20]]);
  assert.equal(runs.reduce((n, r) => n + r.count, 0), frameCountFor(3, 10));
});

test('only the visible video clip is heard; muted, silent and global-muted clips are skipped', () => {
  const clips = [video('a', 0, 2), video('b', 1, 2, { muted: true }), { id: 'm', track: 'audio', assetId: 'a', start: 0, duration: 3, sourceStart: 0, volume: .5, muted: false }];
  const runs = planFrameRuns(clips, 3, 10);
  const segments = planAudioSegments({ clips, runs, fps: 10, assets, globalMute: false });
  assert.deepEqual(segments.map(s => [s.clip.id, s.start, s.end]), [['a', 0, 1], ['m', 0, 3]]);
  assert.deepEqual(planAudioSegments({ clips, runs, fps: 10, assets, globalMute: true }), []);
});

// Minimal stand-in for Mediabunny, WebCodecs and Web Audio: records which frames, packets and audio windows are produced.
// `descriptions[i]` is the avcC byte encoder i reports; `brokenEncoders` lists encoders whose configure() throws.
function fakeEnvironment({ decodable = true, descriptions = [1, 1, 1], brokenEncoders = [] } = {}) {
  const log = { frames: [], packetMeta: [], keyFrames: [], encoders: 0, closedEncoders: 0, audio: [], requested: [], finalized: false, cancelled: false, disposed: 0 };
  class FakeVideoEncoder extends EventTarget {
    static async isConfigSupported(config) { return { supported: config.codec === 'avc1.640028', config }; }
    constructor({ output }) { super(); this.id = log.encoders++; this.output = output; this.encodeQueueSize = 0; this.state = 'unconfigured'; this.sent = 0; }
    configure(config) { if (brokenEncoders.includes(this.id)) throw new Error('no hardware session'); this.config = config; this.state = 'configured'; }
    encode(frame, { keyFrame }) {
      if (keyFrame) log.keyFrames.push(frame.timestamp);
      const meta = this.sent++ ? undefined : { decoderConfig: { codec: this.config.codec, codedWidth: 1, codedHeight: 1, description: new Uint8Array([descriptions[this.id]]) } };
      const chunk = { timestamp: frame.timestamp, type: keyFrame ? 'key' : 'delta' };
      queueMicrotask(() => this.output(chunk, meta));
    }
    async flush() { await new Promise(resolve => setTimeout(resolve)); }
    close() { this.state = 'closed'; log.closedEncoders++; }
  }
  globalThis.VideoEncoder = FakeVideoEncoder;
  globalThis.VideoFrame = class { constructor(canvas, { timestamp }) { this.timestamp = timestamp; } close() {} };
  class Output {
    constructor({ format, target }) { Object.assign(this, { format, target, state: 'pending' }); }
    addVideoTrack(source, meta) { log.frameRate = meta.frameRate; this.video = source; }
    addAudioTrack(source) { this.audio = source; }
    async start() { this.state = 'started'; }
    async finalize() { this.state = 'finalized'; log.finalized = true; this.target.buffer = new ArrayBuffer(8); }
    async cancel() { this.state = 'canceled'; log.cancelled = true; }
  }
  const track = { canDecode: async () => decodable };
  const mb = {
    ALL_FORMATS: [], BlobSource: class {},
    Input: class { getPrimaryVideoTrack() { return track; } getPrimaryAudioTrack() { return track; } dispose() { log.disposed++; } },
    CanvasSink: class {
      async *canvasesAtTimestamps(times) { for (const t of times) { log.requested.push(Math.round(t * 1000) / 1000); yield { canvas: { t }, timestamp: t }; } }
    },
    AudioBufferSink: class { async *buffers(from, to) { yield { buffer: { duration: to - from }, timestamp: from }; } },
    Output, BufferTarget: class { buffer = null; }, StreamTarget: class {},
    Mp4OutputFormat: class { mimeType = 'video/mp4'; fileExtension = '.mp4'; }, WebMOutputFormat: class {},
    EncodedPacket: { fromEncodedChunk: chunk => ({ timestamp: chunk.timestamp / 1e6, type: chunk.type }) },
    EncodedVideoPacketSource: class { async add(packet, meta) { log.frames.push(Math.round(packet.timestamp * 1000) / 1000); if (meta) log.packetMeta.push(meta); } close() {} },
    AudioBufferSource: class { async add(buffer) { log.audio.push(buffer.length); } close() {} },
    getFirstEncodableVideoCodec: async () => 'avc', getFirstEncodableAudioCodec: async () => 'aac'
  };
  globalThis.OfflineAudioContext = class {
    constructor(channels, length) { this.length = length; this.destination = {}; }
    createGain() { return { gain: {}, connect() {} }; }
    createBufferSource() { return { connect() {}, start(when, offset, length) { log.scheduled = [when, offset, length]; } }; }
    async startRendering() { return { length: this.length }; }
  };
  const drawn = [];
  const context = { fillRect() {}, drawImage(source) { drawn.push(source); } };
  return { mb, log, drawn, createCanvas: () => ({ getContext: () => context }) };
}

test('offline export encodes every frame by timestamp, mixes audio in windows and returns an MP4 blob', async () => {
  const env = fakeEnvironment();
  const clips = [video('a', 0, 1, { sourceStart: 5 }), { id: 't', track: 'text' }];
  const texts = [];
  const progress = [];
  const result = await renderOfflineExport({ clips, assets, duration: 1, settings: { width: 1280, height: 720, fps: 10, bitrate: 6e6 },
    globalMute: false, drawText: (ctx, list, time) => texts.push(time), onProgress: p => progress.push(p), mediabunny: env.mb, createCanvas: env.createCanvas });
  assert.deepEqual(env.log.frames, [0, .1, .2, .3, .4, .5, .6, .7, .8, .9]);
  assert.deepEqual(env.log.requested, [5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9]);
  assert.equal(texts.length, 10);
  assert.deepEqual(env.log.audio, [48000]);
  assert.equal(env.log.frameRate, 10);
  assert.equal(progress.at(-1), 1);
  assert.equal(result.extension, 'mp4');
  assert.equal(result.blob.type, 'video/mp4');
  assert.ok(env.log.finalized);
  // One Input for the video slice and one for the audio mix, both released.
  assert.equal(env.log.disposed, 2);
  assert.equal(env.log.packetMeta.length, 1);
  assert.equal(result.encoders, 1);
});

test('cancelling stops encoding and cancels the output; undecodable media raises a fallback error', async () => {
  const env = fakeEnvironment();
  const controller = new AbortController();
  const run = renderOfflineExport({ clips: [video('a', 0, 2)], assets, duration: 2, settings: { width: 10, height: 10, fps: 10, bitrate: 1 },
    drawText() {}, onProgress: p => { if (p > .2) controller.abort(); }, signal: controller.signal, mediabunny: env.mb, createCanvas: env.createCanvas });
  await assert.rejects(run, { name: 'AbortError' });
  assert.ok(env.log.cancelled);
  assert.ok(env.log.frames.length < 20);

  const broken = fakeEnvironment({ decodable: false });
  await assert.rejects(renderOfflineExport({ clips: [video('a', 0, 1)], assets, duration: 1, settings: { width: 10, height: 10, fps: 10, bitrate: 1 },
    drawText() {}, mediabunny: broken.mb, createCanvas: broken.createCanvas }), ExportDecodeError);
});

test('feature detection requires both WebCodecs encoders and decoders', () => {
  const fn = function () {};
  assert.equal(supportsOfflineExport({}), false);
  assert.equal(supportsOfflineExport({ VideoEncoder: fn, AudioEncoder: fn, VideoDecoder: fn, AudioDecoder: fn, OfflineAudioContext: fn }), true);
});

const longExport = (env, extra = {}) => {
  const progress = [];
  const run = renderOfflineExport({ clips: [video('a', 0, 12)], assets, duration: 12, settings: { width: 10, height: 10, fps: 10, bitrate: 1 },
    drawText() {}, onProgress: p => progress.push(p), mediabunny: env.mb, createCanvas: env.createCanvas, ...extra });
  return { run, progress };
};
const allFrames = Array.from({ length: 120 }, (_, i) => Math.round(i * 100) / 1000);

test('slices split long exports on key frames; short exports stay in one slice', () => {
  assert.deepEqual(planSlices(120, 10), [[0, 60], [60, 120]]);
  assert.deepEqual(planSlices(1800, 30), [[0, 900], [900, 1800]]);
  assert.deepEqual(planSlices(99, 10), [[0, 99]]);
  assert.deepEqual(planSlices(130, 10), [[0, 60], [60, 130]]);
  const runs = [{ clip: { id: 'a' }, first: 0, count: 50 }, { clip: { id: 'b' }, first: 50, count: 70 }];
  assert.deepEqual(runsBetween(runs, 40, 60).map(r => [r.clip.id, r.first, r.count]), [['a', 40, 10], ['b', 50, 10]]);
});

test('decoder configs must match byte for byte before slices are concatenated', () => {
  const config = (bytes, extra = {}) => ({ codec: 'avc1.640028', codedWidth: 1920, codedHeight: 1080, description: new Uint8Array(bytes), ...extra });
  assert.ok(sameDecoderConfig(config([1, 2, 3]), config([1, 2, 3])));
  assert.ok(sameDecoderConfig(config([1, 2, 3]), { ...config([]), description: new Uint8Array([9, 1, 2, 3]).subarray(1) }));
  assert.ok(!sameDecoderConfig(config([1, 2, 3]), config([1, 2, 4])));
  assert.ok(!sameDecoderConfig(config([1]), config([1], { codedWidth: 1280 })));
  assert.ok(sameDecoderConfig({ codec: 'vp09.00.40.08' }, { codec: 'vp09.00.40.08' }));
});

test('two encoders run in parallel and their packets are muxed as one ordered track', async () => {
  const env = fakeEnvironment();
  const { run, progress } = longExport(env);
  const result = await run;
  assert.equal(result.encoders, 2);
  assert.equal(env.log.encoders, 2);
  assert.deepEqual(env.log.frames, allFrames);
  assert.equal(env.log.packetMeta.length, 1);
  assert.ok(env.log.keyFrames.includes(6e6), 'second slice starts on a key frame');
  assert.equal(progress.at(-1), 1);
  assert.equal(env.log.closedEncoders, 2);
  assert.equal(env.log.requested.length, 120, 'each frame decoded once');
});

test('a slice whose stream config differs is re-rendered by the first slice, still one ordered track', async () => {
  const env = fakeEnvironment({ descriptions: [1, 2] });
  const { run, progress } = longExport(env);
  const result = await run;
  assert.equal(result.encoders, 1);
  assert.deepEqual(env.log.frames, allFrames);
  assert.equal(progress.at(-1), 1);
  assert.ok(progress.every(p => p <= 1));
});

test('a second encoder that cannot start is not fatal', async () => {
  const env = fakeEnvironment({ brokenEncoders: [1] });
  const { run } = longExport(env);
  const result = await run;
  assert.equal(result.encoders, 1);
  assert.deepEqual(env.log.frames, allFrames);
});

test('a failing first encoder fails the export and cancels the output', async () => {
  const env = fakeEnvironment({ brokenEncoders: [0] });
  await assert.rejects(longExport(env).run, /no hardware session/);
  assert.ok(env.log.cancelled);
});
