import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import {exportPreset} from '../dist/precision-tools.js';
const source=fs.readFileSync(new URL('../dist/app.js',import.meta.url),'utf8');
function harness(resolution='1080',wait=false,fail=false) {
 const state={clips:[],playhead:0,exportRun:0,exportSettings:exportPreset('1080'),exporting:false,recorder:null};
 const elements=Object.fromEntries(['export-resolution','stage-resolution','export-message','start-export','cancel-export','export-status','project-name'].map(k=>[k,{value:k==='export-resolution'?resolution:'demo'}]));
 const video={kind:'video',stop(){this.stopped=true;}},audio={kind:'audio'},shell={};let release,started=0,drawSize;
 class Stream {constructor(tracks){this.tracks=tracks;}getVideoTracks(){return this.tracks.filter(t=>t.kind==='video');}getAudioTracks(){return this.tracks.filter(t=>t.kind==='audio');}addTrack(t){this.tracks.push(t);}}
 class Recorder {static isTypeSupported(){return true;}constructor(stream,opts){this.stream=stream;this.options=opts;this.state='inactive';}start(){if(fail)throw new Error('Encoder unavailable');this.state='recording';}stop(){this.state='inactive';this.onstop();}}
 const audioReady=wait?new Promise(r=>release=()=>r(new Stream([audio]))):Promise.resolve(new Stream([audio]));
 const canvas={getContext:()=>({fillRect(){},drawImage(){}}),captureStream(fps){this.fps=fps;return new Stream([video]);}};
 const context=vm.createContext({state,elements,exportPreset,MediaStream:Stream,MediaRecorder:Recorder,window:{MediaRecorder:Recorder,AudioContext:class{}},HTMLCanvasElement:{prototype:{captureStream(){}}},document:{querySelector:()=>shell,createElement:()=>canvas},projectDuration:()=>5,pausePlayback(){},seekTo(t){state.playhead=t;},startPlayback(){started++;},showToast(){},setExportProgress(){},activeVisualClip:()=>null,drawTextClips:(ctx,clips,t,w,h)=>{drawSize=[w,h];},audioReady});
 vm.runInContext(source.slice(source.indexOf('const EXPORT_BACKGROUND'),source.indexOf('function bindEvents()')),context);
 vm.runInContext('ensureAudioGraph = () => audioReady;',context);
 return {context,state,elements,canvas,video,shell,release,get started(){return started;},get drawSize(){return drawSize;}};
}
test('export pipeline records true 1920x1080 frames, scaled text, 30 fps and 12 Mbps',async()=>{
 const h=harness();await h.context.startRealtimeExport();
 assert.equal(h.canvas.width,1920);assert.equal(h.canvas.height,1080);assert.equal(h.canvas.fps,30);assert.deepEqual(h.drawSize,[1920,1080]);
 assert.equal(h.state.recorder.options.videoBitsPerSecond,12000000);assert.equal(h.state.recorder.stream.getAudioTracks().length,1);assert.ok(h.elements['export-resolution'].disabled);
 h.context.stopExport(true);assert.ok(h.video.stopped);assert.equal(h.state.exporting,false);assert.equal(h.elements['export-resolution'].disabled,false);
});
test('720p option uses matching frame dimensions and bitrate',async()=>{
 const h=harness('720');await h.context.startRealtimeExport();assert.equal(h.canvas.width,1280);assert.equal(h.canvas.height,720);assert.equal(h.state.recorder.options.videoBitsPerSecond,6000000);h.context.stopExport(true);
});
test('cancelling during audio setup cannot later start playback or recording',async()=>{
 const h=harness('1080',true);const pending=h.context.startRealtimeExport();h.context.stopExport(true);h.release();await pending;
 assert.equal(h.started,0);assert.equal(h.state.recorder,null);assert.equal(h.state.exporting,false);assert.ok(h.video.stopped);
});
test('encoder startup error unlocks export and cleans up the stream',async()=>{
 const h=harness('1080',false,true);await h.context.startRealtimeExport();assert.equal(h.state.recorder,null);assert.equal(h.state.exportStream,null);assert.equal(h.state.exporting,false);assert.ok(h.video.stopped);assert.equal(h.shell.inert,false);
});
