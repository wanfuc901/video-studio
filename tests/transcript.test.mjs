import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeWords,groupWords,updateCueText,cuesToClips,planWindows,validateRange} from '../dist/transcript.js';
import {progressFor,validateWords} from '../dist/karaoke.js';
import {EditHistory} from '../dist/editor-tools.js';

test('AI range rejects invalid, reversed and overly long input',()=>{
  assert.throws(()=>validateRange(NaN,5,10,0));assert.throws(()=>validateRange(5,3,10,0));
  assert.throws(()=>validateRange(0,601,700,0));assert.throws(()=>validateRange(0,8,5,0));
  assert.doesNotThrow(()=>validateRange(120,180,400,393.107));
});
test('word timestamps preserve pauses and split combined Vietnamese tokens',()=>{
  const words=normalizeWords([{text:' Xin chào',timestamp:[1,2]},{text:' bạn',timestamp:[3,4]}],5);
  assert.deepEqual(words.map(w=>w.word),['Xin','chào','bạn']);assert.equal(words[0].start,1);assert.equal(words[2].start,3);
  assert.ok(validateWords(words));assert.equal(words[0].estimated,true);
});
test('missing and overlapping word timings stay finite, ordered and bounded',()=>{
  const words=normalizeWords([{text:'a',timestamp:[null,1]},{text:'b',timestamp:[.5,1]},{text:'c',timestamp:[.8,1.5]},{text:'d',timestamp:[1.5,null]}],2);
  assert.deepEqual(words.map(w=>w.word),['b','c','d']);assert.ok(validateWords(words));assert.ok(words.at(-1).end<=2);
});
test('line grouping respects punctuation, pauses, maximum length and long sentences',()=>{
  const words=normalizeWords([{text:'Một hai ba bốn',timestamp:[0,2]},{text:'Năm.',timestamp:[3,3.5]},{text:'Sáu',timestamp:[3.5,4]}],5);
  const cues=groupWords(words,2);assert.deepEqual(cues.map(c=>c.text),['Một hai','ba bốn','Năm.','Sáu']);
});
test('manual correction retains timing with same word count and marks redistributed timing',()=>{
  const cue=groupWords(normalizeWords([{text:'xin',timestamp:[0,1]},{text:'chao',timestamp:[1,2]}],2))[0];
  updateCueText(cue,'xin chào');assert.equal(cue.words[1].start,1);assert.equal(cue.words[1].word,'chào');
  updateCueText(cue,'xin chào bạn');assert.ok(cue.words.every(w=>w.estimated));assert.ok(validateWords(cue.words));
});
test('source audio crop maps once to the timeline offset and karaoke progress',()=>{
  const cues=groupWords(normalizeWords([{text:'Xin',timestamp:[1,2]},{text:'chào',timestamp:[2,3]}],4));
  const [clip]=cuesToClips(cues,393.107,()=> 'ai-1');
  assert.equal(clip.start,394.107);assert.equal(clip.sourceStart,0);assert.equal(clip.karaoke.words[0].start,0);
  assert.ok(Math.abs(progressFor(clip,394.607,0)-.5)<1e-8);assert.ok(validateWords(clip.karaoke.words));
});
test('removing a reviewed line does not truncate the remaining previous sentence',()=>{
  const cues=groupWords(normalizeWords([{text:'first.',timestamp:[0,2]},{text:'deleted.',timestamp:[2,3]},{text:'last.',timestamp:[3,5]}],5));
  updateCueText(cues[1],'');let n=0;
  const clips=cuesToClips(cues,0,()=>String(++n));assert.equal(clips.length,2);assert.ok(clips[1].duration>=2);
});
test('all generated lines form one reversible edit and style is independently cloned',()=>{
  const cues=groupWords(normalizeWords([{text:'one.',timestamp:[0,1]},{text:'two.',timestamp:[2,3]}],4));
  const h=new EditHistory({data:{clips:[]},view:{}});let n=0;
  const clips=cuesToClips(cues,10,()=>String(++n),{color:'#abc'});
  h.record({data:{clips},view:{}});assert.equal(h.undo().data.clips.length,0);assert.equal(h.redo().data.clips.length,2);
  clips[0].style.color='#def';assert.equal(clips[1].style.color,'#abc');
});
test('window plan covers long audio exactly with bounded context for boundary words',()=>{
  const windows=planWindows(65);assert.equal(windows.length,4);assert.equal(windows[0].start,0);assert.equal(windows.at(-1).end,65);
  assert.ok(windows.every((w,i)=>w.end-w.start<=26 && (!i || windows[i-1].coreEnd===w.coreStart)));
});
