import test from 'node:test';
import assert from 'node:assert/strict';
import {createSessionStore, SessionAutosaver, SessionConflictError, projectRecord, assetRecord} from '../dist/session-store.js';
import {EditHistory} from '../dist/editor-tools.js';

// Transaction test double: writes become visible only on complete; abort discards them.
function memoryIndexedDB() {
  const data=new Map();let fail=false;
  const db={objectStoreNames:{contains:n=>data.has(n)},createObjectStore:n=>data.set(n,new Map()),close(){},
    transaction(names,mode){
      const shadow=structuredClone(data);let pending=0,ended=false;
      const tx={error:null,abort(){if(ended)return;ended=true;setImmediate(()=>tx.onabort?.());},
        objectStore(name){return {
          get(key){const r={};pending++;setImmediate(()=>{if(ended)return;r.result=structuredClone(shadow.get(name).get(key));r.onsuccess?.();pending--;finish();});return r;},
          put(value,key){if(fail)throw Object.assign(new Error('disk full'),{name:'QuotaExceededError'});shadow.get(name).set(key??value.id,structuredClone(value));}
        };}
      };
      function finish(){setImmediate(()=>{if(pending||ended)return;ended=true;if(mode==='readwrite'){for(const n of names)data.set(n,shadow.get(n));}tx.oncomplete?.();});}
      finish();return tx;
    }};
  return {open(){const r={};setImmediate(()=>{r.result=db;if(!data.size)r.onupgradeneeded?.();r.onsuccess?.();});return r;},setFail:v=>fail=v,data};
}
const media=()=>({id:'media-1',file:new File(['media bytes'],'bài hát.mp4',{type:'video/mp4',lastModified:123}),kind:'video',duration:10,url:'blob:old',image:{decoded:true}});
const project=(assetIds=['media-1'])=>({version:1,clips:[{id:'clip-1',assetId:'media-1',track:'visual',start:2,sourceStart:1,duration:3}],assetIds,projectName:'Karaoke'});

test('new store instance restores project and exact media bytes; no ephemeral URLs stored',async()=>{
  const idb=memoryIndexedDB(),store=createSessionStore(idb),asset=assetRecord(media());
  const revision=await store.write(project(),[asset],null);
  const loaded=await createSessionStore(idb).load();
  assert.equal(loaded.revision,revision);assert.deepEqual(loaded.project.clips,project().clips);
  assert.equal(await loaded.assets[0].file.text(),'media bytes');assert.equal(loaded.assets[0].name,'bài hát.mp4');
  assert.equal(loaded.assets[0].url,undefined);assert.equal(loaded.assets[0].image,undefined);
});
test('quota failure aborts media and metadata together, retaining the previous session',async()=>{
  const idb=memoryIndexedDB(),store=createSessionStore(idb);
  const revision=await store.write(project(),[assetRecord(media())],null);
  idb.setFail(true);
  await assert.rejects(store.write({...project(),projectName:'unsaved'},[{...assetRecord(media()),id:'new'}],revision),{name:'QuotaExceededError'});
  const loaded=await store.load();assert.equal(loaded.revision,revision);assert.equal(loaded.project.projectName,'Karaoke');assert.equal(idb.data.get('assets').has('new'),false);
});
test('stale tab cannot overwrite a newer session and missing blobs fail restoration',async()=>{
  const idb=memoryIndexedDB(),store=createSessionStore(idb);
  await store.write(project(),[assetRecord(media())],null);
  await assert.rejects(store.write({...project(),projectName:'stale'},[],null),SessionConflictError);
  assert.equal((await store.load()).project.projectName,'Karaoke');
  idb.data.get('assets').clear();await assert.rejects(store.load(),/Thiếu tệp/);
});
test('autosave serializes edits arriving during a write, saves newest data and writes each blob once',async()=>{
  const writes=[],statuses=[];let release,content='first';
  const saver=new SessionAutosaver({store:{async write(p,a,revision){writes.push({p,a,revision});if(writes.length===1)await new Promise(r=>release=r);return 'rev-'+writes.length;}},snapshot:()=>({content}),assets:()=>[media()],onStatus:s=>statuses.push(s)});
  saver.schedule();await new Promise(r=>setImmediate(r));assert.equal(saver.pending,true);
  content='latest';saver.schedule();release();await saver.flush();
  assert.equal(writes.length,2);assert.equal(writes[1].p.content,'latest');assert.equal(writes[1].a.length,0);assert.equal(writes[1].revision,'rev-1');assert.equal(saver.pending,false);assert.equal(statuses.at(-1),'saved');
});
test('failed saves remain dirty and can retry with their blobs; conflicts never retry overwrites',async()=>{
  let fail=true,calls=0;const statuses=[];
  const saver=new SessionAutosaver({store:{async write(p,a){calls++;assert.equal(a.length,1);if(fail)throw new Error('disk full');return 'ok';}},snapshot:project,assets:()=>[media()],onStatus:s=>statuses.push(s)});
  saver.schedule();await saver.flush();assert.equal(saver.pending,true);assert.equal(statuses.at(-1),'error');
  fail=false;await saver.flush();assert.equal(saver.pending,false);assert.equal(calls,2);
  const conflict=new SessionAutosaver({store:{async write(){throw new SessionConflictError();}},snapshot:project,assets:()=>[]});
  conflict.schedule();assert.equal(await conflict.flush(),false);assert.equal(await conflict.flush(),false);assert.equal(conflict.pending,true);
});
test('snapshot keeps text, settings and undo/redo independent of live state',()=>{
  const state={clips:[],assets:new Map([['media-1',media()]]),exportSettings:{height:1080},playhead:3,zoom:90,previewSpeed:.75,selectedId:'text',globalMute:true};
  const history=new EditHistory({data:{clips:[],projectName:'Karaoke'},view:{}});
  state.clips=[{id:'text',track:'text',text:'Xin chào',style:{color:'#fff'},karaoke:{speed:.5}}];
  history.record({data:{clips:state.clips,projectName:'Karaoke'},view:{playhead:3}});
  const saved=projectRecord({state,projectName:'Karaoke',history,aiDraft:{fields:{'ai-supplied-lyrics':'Xin chào'}}});
  state.clips[0].text='changed';assert.equal(saved.clips[0].text,'Xin chào');assert.equal(saved.exportResolution,'1080');
  const resumed=new EditHistory(saved.history.current);resumed.past=saved.history.past;resumed.future=saved.history.future;
  assert.equal(resumed.undo().data.clips.length,0);assert.equal(resumed.redo().data.clips[0].text,'Xin chào');
  assert.equal(saved.assets,undefined);assert.deepEqual(saved.assetIds,['media-1']);
});
test('unsupported storage reports failure instead of treating it as an empty session',async()=>{
  await assert.rejects(createSessionStore(null).load(),/không cho phép/);
});
test('delayed autosave coalesces a burst of edits into one write and flush writes immediately',async()=>{
  const writes=[];let content=0;
  const saver=new SessionAutosaver({store:{async write(p){writes.push(p.content);return 'r'+writes.length;}},snapshot:()=>({content}),assets:()=>[],delayMs:30});
  for(let i=1;i<=20;i++){content=i;saver.schedule();}
  await new Promise(r=>setTimeout(r,80));
  assert.deepEqual(writes,[20]);
  content=21;saver.schedule();await saver.flush();
  assert.deepEqual(writes,[20,21]);assert.equal(saver.pending,false);
  await new Promise(r=>setTimeout(r,60));assert.equal(writes.length,2);
});
