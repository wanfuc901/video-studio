import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLyrics,timedLyricsInRange,alignLyrics} from '../dist/lyrics-import.js';
import {normalizeWords,cuesToClips} from '../dist/transcript.js';
import {validateWords} from '../dist/karaoke.js';
const recognized=(text)=>text.split(' ').map((word,i)=>({word,start:i*.5+1,end:i*.5+1.4}));

test('supplied Vietnamese spelling and line boundaries survive recognition errors',()=>{
  const result=alignLyrics(['Xin chào em','Hôm nay trời đẹp'],recognized('xin chao em hôm nay chời đẹp'),5);
  assert.deepEqual(result.cues.map(c=>c.text),['Xin chào em','Hôm nay trời đẹp']);
  assert.equal(result.matched,6);assert.ok(result.cues[1].needsReview);
  assert.ok(validateWords(result.cues.flatMap(c=>c.words)));
});
test('repeated chorus follows the full sequence instead of matching the first occurrence twice',()=>{
  const result=alignLyrics(['Em yêu anh','Ngày bên nhau','Em yêu anh'],recognized('em yêu anh ngày bên nhau em yêu anh'),7);
  assert.equal(result.matched,9);assert.ok(result.cues[2].start>result.cues[1].end);
});
test('missing words have estimated timing and preserve the complete supplied lyrics',()=>{
  const result=alignLyrics(['Xin chào người bạn của tôi'],recognized('xin chào của tôi'),5);
  assert.equal(result.cues[0].words.length,6);
  assert.ok(result.cues[0].words.some(w=>w.estimated));
  assert.ok(validateWords(result.cues[0].words));
});
test('no matching lyrics fails explicitly instead of claiming accurate timing',()=>{
  assert.throws(()=>alignLyrics(['hoàn toàn khác'],recognized('hello world'),4),/chưa khớp/);
});
test('SRT imports source timestamps exactly once into a trimmed timeline clip',()=>{
  const parsed=parseLyrics('1\n00:00:12,100 --> 00:00:14,500\nXin chào\n\n2\n00:00:16,000 --> 00:00:18,000\nBạn tôi');
  const cues=timedLyricsInRange(parsed,10,20);const clips=cuesToClips(cues,50,()=> 'id');
  assert.equal(clips[0].start,52.1);assert.equal(clips[0].duration,2.4);assert.equal(cues[0].end,4.5);assert.ok(cues[0].words.every(w=>w.estimated));
});
test('LRC repeat tags, offsets, end markers and final duration are handled',()=>{
  const p=parseLyrics('[offset:500]\n[00:01.00][00:05.00]Xin chào\n[00:08.00]\n[ar:Singer]');
  const cues=timedLyricsInRange(p,0,10);
  assert.deepEqual(cues.map(c=>[c.start,c.end]),[[1.5,5.5],[5.5,8.5]]);
  assert.equal(timedLyricsInRange(parseLyrics('[00:01]last'),0,4)[0].end,4);
});
test('overlap and malformed subtitle timestamps are rejected',()=>{
  assert.throws(()=>parseLyrics('1\n00:00:01,000 --> 00:00:04,000\na\n\n2\n00:00:03,000 --> 00:00:05,000\nb'),/chồng/);
  assert.throws(()=>parseLyrics('1\nbad --> bad\nhello'),/không hợp lệ/);
});
test('the normalization pipeline produces ordered finite karaoke clips for unmatched prefixes',()=>{
  const words=normalizeWords([{text:'em',timestamp:[0,.2]},{text:'yêu',timestamp:[.2,.5]},{text:'anh',timestamp:[.5,1]}],1.5);
  const r=alignLyrics(['Vì em yêu anh mãi'],words,1.5);
  assert.ok(validateWords(r.cues[0].words));
  assert.ok(r.cues[0].words.every(w=>Number.isFinite(w.start)&&w.end<=1.5));
});
