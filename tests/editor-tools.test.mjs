import test from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory, fitStage, revealTimeline, shortcutFor } from '../dist/editor-tools.js';
import { createTextClip } from '../dist/karaoke.js';
const snapshot = (clips = [], selectedId = null, playhead = 0) => ({ data:{clips,projectName:'Test',globalMute:false},view:{selectedId,playhead} });
const event = (key, extra = {}) => ({key,...extra});

test('text addition, editing, deletion all undo and redo with independent nested karaoke settings', () => {
  const history = new EditHistory(snapshot());
  const text = createTextClip(393.107, 'text'); history.record(snapshot([text],text.id,text.start));
  text.karaoke.words[0].end = .777; history.record(snapshot([text],text.id,text.start));
  history.record(snapshot());
  const restored = history.undo(); assert.equal(restored.data.clips[0].karaoke.words[0].end,.777);
  restored.data.clips[0].text='outside mutation';
  assert.notEqual(history.current.data.clips[0].text,'outside mutation');
  const original = history.undo(); assert.notEqual(original.data.clips[0].karaoke.words[0].end,.777);
  assert.equal(history.undo().data.clips.length,0);
  assert.equal(history.redo().data.clips[0].start,393.107);
  assert.equal(history.redo().data.clips[0].karaoke.words[0].end,.777);
  assert.equal(history.redo().data.clips.length,0);
});
test('media edits and deletion restore asset references without cloning a media element', () => {
  const media={id:'video',assetId:'upload-1',track:'visual',start:0,duration:100,sourceStart:0,volume:1,muted:false};
  const h=new EditHistory(snapshot([media]));
  media.start=12; media.duration=50; media.volume=.5; h.record(snapshot([media]));
  h.record(snapshot()); assert.equal(h.undo().data.clips[0].assetId,'upload-1');
  assert.equal(h.undo().data.clips[0].duration,100);
});
test('typing merges into one edit; an idle gap or blur starts a fresh undo step', () => {
  const c=createTextClip(0,'a'), h=new EditHistory(snapshot([c]));
  const original=c.text;
  c.text='x';h.record(snapshot([c]),'text:a',1000);
  c.text='xy';h.record(snapshot([c]),'text:a',1200);
  assert.equal(h.past.length,1);
  c.text='xyz';h.record(snapshot([c]),'text:a',2200);assert.equal(h.past.length,2);
  assert.equal(h.undo().data.clips[0].text,'xy');assert.equal(h.undo().data.clips[0].text,original);
  h.redo();h.endGroup();c.text='new';h.record(snapshot([c]),'text:a',2250);assert.equal(h.canRedo,false);
});
test('selection and navigation do not fill undo history or discard redo', () => {
  const c=createTextClip(0,'a'), h=new EditHistory(snapshot());
  h.record(snapshot([c]));h.record(snapshot([c],'a',3));assert.equal(h.past.length,1);
  h.undo();h.record(snapshot([],null,8));assert.equal(h.canRedo,true);
  assert.equal(h.redo().view.selectedId,'a');
});
test('drag commits once at the end and bounded history keeps the newest operations', () => {
  const c=createTextClip(0,'a'), h=new EditHistory(snapshot([c]),3);
  for(let i=0;i<50;i++) c.start=i/10;
  h.record(snapshot([c]));assert.equal(h.past.length,1);assert.equal(h.undo().data.clips[0].start,0);
  for(let i=1;i<=6;i++){c.start=i;h.record(snapshot([c]));}
  assert.equal(h.past.length,3);assert.equal(h.undo().data.clips[0].start,5);
});
test('stage fits both width and height of the screenshot layout without reaching transport', () => {
  for(const [w,h] of [[1200,280],[900,300],[320,180],[280,120],[1200,0]]) {
    const s=fitStage(w,h);assert.ok(s.width<=w && s.height<=h);assert.equal(s.height,s.width*9/16);
  }
  assert.equal(fitStage(1200,280).height,280);
});
test('adding text at 06:33 reveals its start and the third track immediately', () => {
  const args={start:393.107,duration:5,zoom:52,scrollLeft:0,viewportWidth:1900,trackTop:186,trackHeight:75,scrollTop:0,viewportHeight:240};
  const p=revealTimeline(args),x=146+args.start*args.zoom;
  assert.ok(x>=p.left+146 && x+5*52<=p.left+1900);
  assert.equal(p.top,21);
});
test('visible clips do not jump; earlier clips and long media clips reveal their start', () => {
  const a={start:10,duration:3,zoom:52,scrollLeft:400,viewportWidth:1000,trackTop:36,trackHeight:75,scrollTop:0,viewportHeight:270};
  assert.deepEqual(revealTimeline(a),{left:400,top:0});
  assert.equal(revealTimeline({...a,start:0}).left,0);
  const p=revealTimeline({...a,start:100,duration:500});assert.equal(p.left,100*52-24);
});
test('shortcuts work after button focus but protect typing, IME and modal dialogs', () => {
  assert.equal(shortcutFor(event('z',{ctrlKey:true})),'undo');
  assert.equal(shortcutFor(event('Z',{metaKey:true,shiftKey:true})),'redo');
  assert.equal(shortcutFor(event('y',{ctrlKey:true})),'redo');
  assert.equal(shortcutFor(event('Delete')),'delete');
  assert.equal(shortcutFor(event('Delete'),{editing:true}),null);
  assert.equal(shortcutFor(event('z',{ctrlKey:true}),{editing:true}),null);
  assert.equal(shortcutFor(event('z',{ctrlKey:true}),{editing:true,managedText:true}),'undo');
  assert.equal(shortcutFor(event('t',{isComposing:true})),null);
  assert.equal(shortcutFor(event('Delete'),{dialogOpen:true}),null);
  assert.equal(shortcutFor(event('t',{ctrlKey:true})),null);
  assert.equal(shortcutFor(event('d',{ctrlKey:true})),'duplicate');
  assert.equal(shortcutFor(event('ArrowRight',{shiftKey:true})),'next-second');
});
