import test from 'node:test';
import assert from 'node:assert/strict';
import { runKaraokeJob } from '../dist/ai-providers.js';
import { karaokeResultToCues, karaokeSummary, cuesToClips } from '../dist/transcript.js';

const result = {
  device: 'cuda', aligner: 'nguyenvulebinh/wav2vec2-base-vietnamese-250h', separated: true, dereverbed: true,
  duration: 20, tempo: 92.3, beats: [0.5, 1.15], timings: { total: 31.2 },
  lines: [
    { text: 'em oi', start: 1, end: 3.2, echoEnd: 4.1, words: [{ word: 'em', start: 1, end: 1.4 }, { word: 'oi', start: 1.5, end: 3.2, sustain: 1.4 }] },
    { text: 'ha noi', start: 4, end: 5, echoEnd: 6.5, words: [{ word: 'ha', start: 4, end: 4.3, estimated: true }, { word: 'noi', start: 4.4, end: 5 }] }
  ]
};

function fakeRunner(states) {
  const calls = [];
  const fetcher = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body, auth: init.headers?.Authorization });
    const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload });
    if (init.method === 'POST') return json({ id: 'a'.repeat(32), state: 'waiting-upload' }, 201);
    if (init.method === 'PUT') return json({ state: 'queued' }, 202);
    if (init.method === 'DELETE') return json({ state: 'cancelled' });
    return json(states.shift());
  };
  return { calls, fetcher };
}

test('Karaoke Pro job uploads the original file once, reports stages and returns the result', async () => {
  const { calls, fetcher } = fakeRunner([{ state: 'running', stage: 'separate', progress: .1 }, { state: 'running', stage: 'words', progress: .6 }, { state: 'done', result }]);
  const file = new Blob(['media']);
  const stages = [];
  const output = await runKaraokeJob({ endpoint: 'http://127.0.0.1:8766', key: ' code ', file, fetcher, pollMs: 1,
    options: { from: 0, to: 20, lyrics: ['Em ơi'] }, onProgress: (stage) => stages.push(stage) });
  assert.equal(output, result);
  assert.deepEqual(calls.map(c => c.method), ['POST', 'PUT', 'GET', 'GET', 'GET']);
  assert.equal(calls[1].url, 'http://127.0.0.1:8766/v1/karaoke/jobs/' + 'a'.repeat(32) + '/audio');
  assert.equal(calls[1].body, file);
  assert.deepEqual(JSON.parse(calls[0].body).lyrics, ['Em ơi']);
  assert.ok(calls.every(c => c.auth === 'Bearer code'));
  assert.deepEqual(stages, ['upload', 'separate', 'words']);
});

test('cancelling stops polling and cancels the job on the runner; runner errors surface their message', async () => {
  const controller = new AbortController();
  const { calls, fetcher } = fakeRunner(Array.from({ length: 50 }, () => ({ state: 'running', stage: 'separate', progress: .2 })));
  const run = runKaraokeJob({ endpoint: 'http://localhost:8766', key: 'k', file: new Blob(['x']), fetcher, pollMs: 5, signal: controller.signal, options: {},
    onProgress: (stage) => { if (stage === 'separate') controller.abort(); } });
  await assert.rejects(run, { name: 'AbortError' });
  assert.equal(calls.at(-1).method, 'DELETE');

  const failing = fakeRunner([{ state: 'error', error: 'GPU hết bộ nhớ.' }]);
  await assert.rejects(runKaraokeJob({ endpoint: 'http://localhost:8766', key: 'k', file: new Blob(['x']), fetcher: failing.fetcher, pollMs: 1, options: {} }), /GPU hết bộ nhớ/);
  await assert.rejects(runKaraokeJob({ endpoint: 'https://example.com', key: 'k', file: new Blob(['x']), fetcher: failing.fetcher, options: {} }), /localhost/);
});

test('cues keep supplied spelling, held notes and echo tails; clips stay visible through echo but not past the next line', () => {
  const cues = karaokeResultToCues(result, ['Em ơi', 'Hà Nội']);
  assert.deepEqual(cues.map(c => c.text), ['Em ơi', 'Hà Nội']);
  assert.equal(cues[0].words[1].sustain, 1.4);
  assert.equal(cues[0].displayEnd, 4.1);
  assert.equal(cues[1].needsReview, true);
  const clips = cuesToClips(cues, 10, (() => { let n = 0; return () => 'c' + n++; })());
  assert.equal(clips[0].start, 11);
  assert.equal(clips[0].duration, 3);          // echo to 4.1 is capped by the next line at 4.0
  assert.equal(clips[1].duration, 2.5);        // last line keeps its full 1.5 s echo
  assert.deepEqual(clips[0].karaoke.words[1], { word: 'ơi', start: .5, end: 2.2, sustain: 1.4 });
  assert.match(karaokeSummary(result, cues), /1 từ ngân, 2 câu có vang · nhịp 92 BPM/);
});
