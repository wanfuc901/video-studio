import test from 'node:test';
import assert from 'node:assert/strict';
import { activeVisualAt, planFrameRuns, planAudioSegments, renderOfflineExport, frameCountFor, ExportDecodeError, supportsOfflineExport } from '../dist/offline-export.js';

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

// Minimal stand-in for Mediabunny and Web Audio: records which frames, timestamps and audio windows are produced.
function fakeEnvironment({ decodable = true } = {}) {
  const log = { frames: [], audio: [], requested: [], finalized: false, cancelled: false, disposed: 0 };
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
    CanvasSource: class { async add(t) { log.frames.push(Math.round(t * 1000) / 1000); } close() {} },
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
  assert.equal(env.log.disposed, 1);
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
