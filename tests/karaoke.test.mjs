import test from 'node:test';
import assert from 'node:assert/strict';
import { createTextClip, progressFor, progressAt, animationTime, animationEnd, distributeWords, validateWords, validatePoints, drawTextClips } from '../dist/karaoke.js';
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('sweep respects lead-in, speed, completion and backward seeks', () => {
  const c = createTextClip(10, 'a'); c.karaoke.delay = 1; c.karaoke.speed = 2;
  near(progressFor(c, 10.5), 0); near(progressFor(c, 12), 0.5); near(progressFor(c, 13), 1);
  near(progressFor(c, 11.5), 0.25); near(animationEnd(c), 3);
});
test('word mode leaves gaps and gives each Vietnamese syllable its own duration', () => {
  const c = createTextClip(0, 'a'); c.karaoke.mode = 'words'; c.karaoke.delay = 0;
  c.karaoke.words = [{word:'Nắng',start:0,end:1},{word:'về',start:2,end:4}];
  near(progressFor(c, 1.5, 0), 1); near(progressFor(c, 1.5, 1), 0); near(progressFor(c, 3, 1), 0.5);
  near(animationEnd(c), 4);
});
test('custom curve supports a hold, changing slopes and a final 100%', () => {
  const points = [{time:0,progress:0},{time:1,progress:25},{time:3,progress:25},{time:4,progress:100}];
  assert.ok(validatePoints(points)); near(progressAt(points, 2), .25); near(progressAt(points, 3.5), .625); near(progressAt(points, 8), 1);
  near(progressAt(points, -1), 0);
});
test('invalid overlapping words, duplicate times and decreasing color are rejected', () => {
  assert.equal(validateWords([{start:0,end:1},{start:.9,end:2}]), false);
  assert.equal(validateWords([{start:0,end:0}]), false);
  assert.equal(validatePoints([{time:0,progress:0},{time:0,progress:100}]), false);
  assert.equal(validatePoints([{time:0,progress:0},{time:1,progress:70},{time:2,progress:50},{time:3,progress:100}]), false);
});
test('automatic segmentation preserves Vietnamese/newlines and positive word durations', () => {
  const words = distributeWords('Nắng  về\ntrên phố', 4);
  assert.deepEqual(words.map(w => w.word), ['Nắng','về','trên','phố']); assert.ok(validateWords(words)); near(words.at(-1).end,4);
  assert.ok(validateWords(distributeWords('a b c d e f g h i k l m n o p q r s t', .01)));
});
test('trim and split keep original karaoke position; cloned clips edit independently', () => {
  const original = createTextClip(2, 'a');
  const right = {...structuredClone(original), start:4, sourceStart:2, duration:3};
  near(progressFor(original, 4.5), progressFor(right, 4.5));
  near(animationTime(right, 4.5), 2.2);
  right.karaoke.words[0].end = 99; assert.notEqual(original.karaoke.words[0].end, 99);
});
function context() {
  const calls = [];
  return new Proxy({calls, measureText: text => ({width:Array.from(text).length*32})}, {get(target, key) { return key in target ? target[key] : (...args) => calls.push([key,...args]); }});
}
test('text renders only within display bounds, including text-only videos', () => {
  const c = createTextClip(3,'a'), ctx = context();
  drawTextClips(ctx,[c],2,1920,1080); assert.equal(ctx.calls.filter(c => c[0] === 'fillText').length,0);
  drawTextClips(ctx,[c],3,1920,1080); assert.ok(ctx.calls.some(c => c[0] === 'fillText'));
  const after = context(); drawTextClips(after,[c],8,1920,1080); assert.equal(after.calls.filter(c => c[0] === 'fillText').length,0);
});
test('preview and export use identical layout/animation commands with only canvas scale changing', () => {
  const c = createTextClip(0,'a'); c.text = 'Nắng về trên phố\nMình cùng hát nhé'; c.karaoke.mode = 'custom';
  const preview = context(), exported = context();
  drawTextClips(preview,[c],2,1920,1080); drawTextClips(exported,[c],2,1280,720);
  assert.deepEqual(preview.calls.filter(c => c[0] !== 'scale'), exported.calls.filter(c => c[0] !== 'scale'));
  assert.deepEqual(exported.calls.find(c => c[0] === 'scale'), ['scale',2/3,2/3]);
});
test('disabled karaoke draws ordinary text without active-color clipping', () => {
  const c = createTextClip(0,'a'); c.karaoke.enabled = false; const ctx = context();
  drawTextClips(ctx,[c],2,1920,1080); assert.ok(ctx.calls.some(c => c[0] === 'fillText')); assert.equal(ctx.calls.some(c => c[0] === 'clip'), false);
});
test('RTL and multiline text render safely at the edges', () => {
  const c = createTextClip(0,'a'); c.karaoke.direction = 'rtl'; c.text = 'Một câu\nMột câu khác'; c.style.x=0; c.style.y=100;
  const ctx = context(); drawTextClips(ctx,[c],2,1920,1080);
  assert.ok(ctx.calls.filter(c => c[0] === 'fillText').every(c => c[2]>=0 && c[3]<=1080));
  assert.ok(ctx.calls.some(c => c[0] === 'clip'));
});
