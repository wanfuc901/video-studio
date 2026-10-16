import test from 'node:test';
import assert from 'node:assert/strict';
import { EditHistory, fitStage, revealTimeline, shortcutFor, clipKind, countClipKinds, clipRangeIds, reconcileSelection } from '../dist/editor-tools.js';
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

test('undo history shares unchanged clips so stored sessions do not grow with every step', async () => {
  const { serialize } = await import('node:v8');
  const clips = Array.from({ length: 300 }, (_, i) => createTextClip(i * 4, `line-${i}`));
  const h = new EditHistory(snapshot(clips));
  for (let step = 0; step < 100; step++) { clips[step % 300].start += .01; h.record(snapshot(clips)); }
  const stored = serialize({ current: h.current, past: h.past });
  const single = serialize(h.current);
  // Without sharing this would be ~100x one snapshot; with sharing only the edited clips are new.
  assert.ok(stored.length < single.length * 3, `history ${stored.length} bytes vs snapshot ${single.length}`);
  const restored = structuredClone({ past: h.past });
  assert.equal(restored.past[1].data.clips[200], restored.past[2].data.clips[200]);
  assert.equal(h.undo().data.clips[99].start, 99 * 4);
});

test('timeline virtualization keeps one screen of overscan and filters clips by time', async () => {
  const { visibleTimeRange, clipInRange } = await import('../dist/editor-tools.js');
  const range = visibleTimeRange({ scrollLeft: 146 + 100 * 50, viewportWidth: 1000, zoom: 50 });
  assert.deepEqual(range, { start: 80, end: 140 });
  assert.equal(clipInRange({ start: 70, duration: 11 }, range), true);
  assert.equal(clipInRange({ start: 140, duration: 3 }, range), false);
  assert.equal(visibleTimeRange({ scrollLeft: 0, viewportWidth: 1000, zoom: 50 }).start, 0);
});

test('multi-select shortcuts: Ctrl+A selects all, Esc clears, both stay off while typing', () => {
  assert.equal(shortcutFor(event('a',{ctrlKey:true})),'select-all');
  assert.equal(shortcutFor(event('A',{metaKey:true})),'select-all');
  assert.equal(shortcutFor(event('a',{ctrlKey:true}),{editing:true}),null);
  assert.equal(shortcutFor(event('Escape')),'deselect');
  assert.equal(shortcutFor(event('Escape'),{editing:true}),null);
});
test('bulk delete counts clips by what the timeline shows, text clips included', () => {
  const assets = new Map([['v',{kind:'video'}],['i',{kind:'image'}],['m',{kind:'audio'}]]);
  const clips = [{id:1,track:'visual',assetId:'v'},{id:2,track:'visual',assetId:'v'},{id:3,track:'visual',assetId:'i'},
    {id:4,track:'audio',assetId:'m'},{id:5,track:'text'},{id:6,track:'text'},{id:7,track:'visual',assetId:'gone'}];
  assert.equal(clipKind(clips[2],assets),'image');
  assert.equal(clipKind(clips[4],assets),'text');
  assert.equal(clipKind(clips[6],assets),null);
  assert.deepEqual(countClipKinds(clips,assets),{video:2,image:1,audio:1,text:2});
});
test('Shift+click range stays on the clicked track and works in both directions', () => {
  const clips = [{id:'a',track:'text',start:1},{id:'b',track:'text',start:2},{id:'c',track:'text',start:3},
    {id:'d',track:'text',start:4},{id:'x',track:'audio',start:2.5}];
  assert.deepEqual(clipRangeIds(clips,clips[0],clips[2]),['a','b','c']);
  assert.deepEqual(clipRangeIds(clips,clips[3],clips[1]),['b','c','d']);
  // Anchor on another track: the range is the time span on the clicked track.
  assert.deepEqual(clipRangeIds(clips,clips[4],clips[2]),['c']);
});
test('selection follows primary clip assignments made outside the timeline', () => {
  const clips = [{id:'a'},{id:'b'},{id:'c'}];
  const kept = reconcileSelection(new Set(['a','b']),'b',clips);
  assert.deepEqual([...kept.selectedIds],['a','b']);
  assert.equal(kept.selectedId,'b');
  // Lyrics list or AI insert picked one clip: collapse to it.
  assert.deepEqual([...reconcileSelection(new Set(['a','b']),'c',clips).selectedIds],['c']);
  // Undo removed some selected clips: keep the rest.
  assert.deepEqual([...reconcileSelection(new Set(['a','b','z']),'a',clips).selectedIds],['a','b']);
  const cleared = reconcileSelection(new Set(['a']),'z',clips);
  assert.equal(cleared.selectedId,null);
  assert.equal(cleared.selectedIds.size,0);
});
