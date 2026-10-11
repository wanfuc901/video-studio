import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {SessionAutosaver,projectRecord} from '../dist/session-store.js';
import {EditHistory} from '../dist/editor-tools.js';
const app=await readFile(new URL('../dist/app.js',import.meta.url),'utf8');
const restoreCode=app.slice(app.indexOf('async function restoreSession()'));
function harness(loaded) {
  const elements=Object.fromEntries(['project-name','zoom-slider','export-resolution','timeline-scroll'].map(id=>[id,{}]));
  const shell={},state={assets:new Map(),clips:[]},statuses=[],calls=[];
  const store={async load(){return structuredClone(loaded);},async write(){calls.push('write');return 'new';}};
  const context=vm.createContext({state,elements,File,URL,Map,Image:class{async decode(){}},SessionAutosaver,projectRecord,EditHistory,
    sessionAutosaver:null,restoringSession:true,AUTOSAVE_DELAY_MS:0,document:{querySelector:()=>shell,getElementById:()=>({})},
    createSessionStore:()=>store,clamp:(n,a,b)=>Math.max(a,Math.min(n,b)),projectDuration:()=>state.clips.reduce((n,c)=>Math.max(n,c.start+c.duration),0),
    snapshotProject:()=>({data:{clips:state.clips,projectName:elements['project-name'].value,globalMute:state.globalMute},view:{playhead:state.playhead,selectedId:state.selectedId}}),
    updateExportSettings(){calls.push('export-settings');},updateGlobalMuteButton(){},renderAssets(){calls.push('assets');},renderAll(){calls.push('render');},
    aiLyricsUI:{restore(d){calls.push(d.fields['ai-supplied-lyrics']);},snapshot(){return {};}},showToast(){},sessionStatus:(...args)=>statuses.push(args)});
  vm.runInContext(restoreCode,context);return {context,state,elements,statuses,calls,shell};
}
test('app startup restores playable blob URLs, timeline selection, zoom, export and lyrics without overwriting first',async()=>{
  const project={assetIds:['a'],clips:[{id:'c',assetId:'a',track:'visual',start:2,duration:4}],selectedId:'c',playhead:3,zoom:150,previewSpeed:.5,globalMute:true,projectName:'Bài hát',exportResolution:'720',scrollLeft:200,scrollTop:40,aiDraft:{fields:{'ai-supplied-lyrics':'Lời chuẩn'}},history:{past:[],future:[]}};
  const h=harness({project,assets:[{id:'a',name:'song.mp4',file:new Blob(['bytes']),type:'video/mp4',duration:7,kind:'video'}],revision:'r1'});
  await h.context.restoreSession();
  assert.equal(h.state.playhead,3);assert.equal(h.state.selectedId,'c');assert.equal(h.state.previewSpeed,.5);assert.equal(h.state.zoom,150);
  assert.equal(h.elements['export-resolution'].value,'720');assert.equal(h.elements['timeline-scroll'].scrollLeft,200);
  const media=h.state.assets.get('a');assert.equal(media.file.name,'song.mp4');assert.equal(await media.file.text(),'bytes');assert.match(media.url,/^blob:/);URL.revokeObjectURL(media.url);
  assert.equal(h.context.sessionAutosaver.pending,false);assert.equal(h.context.sessionAutosaver.revision,'r1');assert.equal(h.calls.includes('write'),false);assert.equal(h.calls.includes('Lời chuẩn'),true);assert.equal(h.shell.inert,false);assert.equal(h.statuses.at(-1)[0],'saved');
});
test('broken stored media fails closed for autosave instead of replacing the saved project with empty state',async()=>{
  const h=harness({project:{assetIds:[],clips:[{id:'c',assetId:'missing',track:'visual'}]},assets:[]});
  await h.context.restoreSession();assert.equal(h.context.sessionAutosaver,null);assert.equal(h.calls.includes('write'),false);assert.equal(h.statuses.at(-1)[0],'error');assert.match(h.statuses.at(-1)[1].message,/Không ghi đè/);
});
