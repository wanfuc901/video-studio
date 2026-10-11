import test from 'node:test';
import assert from 'node:assert/strict';
import {setupAILyrics} from '../dist/ai-lyrics-ui.js';
class Element {
  constructor(tag='div'){this.tag=tag;this.children=[];this._value='';this.handlers={};this.classList={add(){}};}
  get value(){return this._value;}
  set value(v){this._value=String(v);}
  insertAdjacentHTML(){}
  replaceChildren(...nodes){this.children=[];this._value='';this.append(...nodes);}
  append(...nodes){this.children.push(...nodes);if(this.tag==='select'&&!this._value)this._value=nodes[0]?.value||'';}
  addEventListener(t,fn){this.handlers[t]=fn;}
  showModal(){this.open=true;}
  close(){this.open=false;this.handlers.close?.();}
}
test('lyrics draft and cached recognition survive reopen/reload, keep supplied spelling and insert correct offset without key',async()=>{
  const nodes=new Map();const $=id=>{if(!nodes.has(id))nodes.set(id,new Element(['ai-source','ai-model'].includes(id)?'select':'div'));return nodes.get(id);};
  const prior=globalThis.document;
  globalThis.document={getElementById:$,body:new Element(),createElement:tag=>new Element(tag)};
  try {
    $('ai-provider').value='groq';$('ai-mode').value='align';$('ai-language').value='vietnamese';$('ai-line-length').value='8';
    const state={assets:new Map([['a',{id:'a',kind:'video',duration:6,file:{name:'song.mp4'}}]]),clips:[],playhead:10};
    const api=setupAILyrics({state,elements:{'timeline-scroll':{scrollIntoView(){},focus(){}}},getSelectedClip:()=>null,pausePlayback(){},renderAll(){},revealClip(){},showToast(){}});
    const draft={fields:{'ai-mode':'align','ai-source':'asset:a','ai-from':'0','ai-to':'6','ai-insert':'10','ai-provider':'groq','ai-model':'whisper-large-v3-turbo','ai-language':'vietnamese','ai-line-length':'8','ai-supplied-lyrics':'Xin chào bạn\nHẹn gặp lại','ai-local-url':'http://127.0.0.1:8766'},lastResult:{signature:JSON.stringify(['a',0,6,'groq','whisper-large-v3-turbo','vietnamese','']),duration:6,words:['xin','chao','ban','hen','gap','lai'].map((word,i)=>({word,start:i,end:i+.8}))}};
    api.restore(draft);api.open('align');
    assert.equal($('ai-insert').value,'10');assert.equal($('ai-supplied-lyrics').value,draft.fields['ai-supplied-lyrics']);
    await $('ai-start').onclick();
    assert.equal(api.snapshot().cues.length,2);assert.equal(api.snapshot().cues[0].text,'Xin chào bạn');assert.equal($('ai-insert-button').disabled,false);
    $('ai-api-key').value='private-api-key';$('ai-local-key').value='private-local-key';
    const saved=api.snapshot();assert.equal(JSON.stringify(saved).includes('private-'),false);
    // Simulate a fresh dialog from persisted metadata, including a user's review correction.
    saved.cues[0].text='Xin chào bạn!';api.restore(saved);api.open();assert.equal(api.snapshot().cues[0].text,'Xin chào bạn!');
    $('ai-insert-button').onclick();assert.equal(state.clips.length,2);assert.equal(state.clips[0].start,10);assert.equal(state.clips[0].text,'Xin chào bạn!');
    assert.equal(api.snapshot().cues.length,0);assert.equal(api.snapshot().fields['ai-supplied-lyrics'],draft.fields['ai-supplied-lyrics']);
  } finally {globalThis.document=prior;}
});
