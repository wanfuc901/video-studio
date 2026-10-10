import test from 'node:test';
import assert from 'node:assert/strict';
import {wavBlob,localEndpoint,responseWords,transcribeAPI} from '../dist/ai-providers.js';

test('WAV conversion is mono PCM16 at 16000 Hz and clamps samples',async()=>{
  const data=new DataView(await wavBlob(new Float32Array([-2,0,2])).arrayBuffer());
  assert.equal(data.getUint32(24,true),16000);assert.equal(data.getUint16(22,true),1);
  assert.equal(data.getInt16(44,true),-32768);assert.equal(data.getInt16(48,true),32767);
});
test('local target cannot point credentials at another host or embed URL credentials',()=>{
  assert.equal(localEndpoint('http://127.0.0.1:8766/'),'http://127.0.0.1:8766');
  for(const url of ['https://example.com','http://user:pass@localhost:80','http://localhost.evil.test','file:///tmp/a','http://localhost/?x=1'])assert.throws(()=>localEndpoint(url));
});
test('Groq request sends only selected WAV with word timestamps to the fixed provider',async()=>{
  let sent;
  const words=await transcribeAPI({provider:'groq',model:'whisper-large-v3-turbo',language:'vietnamese',key:'test-key',audio:new Float32Array(16000),fetcher:async(url,options)=>{
    sent={url,options};return {ok:true,json:async()=>({words:[{word:'xin',start:.1,end:.5}]})};
  }});
  assert.equal(sent.url,'https://api.groq.com/openai/v1/audio/transcriptions');
  assert.equal(sent.options.body.get('language'),'vi');assert.equal(sent.options.body.get('timestamp_granularities[]'),'word');
  assert.equal(sent.options.body.get('response_format'),'verbose_json');assert.equal(sent.options.body.get('prompt'),null);
  assert.equal(sent.options.body.get('file').size,32044);assert.equal(words[0].word,'xin');
});
test('local uses loopback and cancellation signal; keys are not included in errors',async()=>{
  const controller=new AbortController();let target;
  await assert.rejects(transcribeAPI({provider:'local',model:'small',language:'auto',key:'secret-value',endpoint:'http://localhost:8766',audio:new Float32Array(2),signal:controller.signal,fetcher:async(url,opts)=>{
    target=url;assert.equal(opts.signal,controller.signal);assert.equal(opts.body.has('language'),false);return {ok:false,status:401};
  }}),e=>!e.message.includes('secret-value')&&/Key/.test(e.message));
  assert.equal(target,'http://localhost:8766/v1/audio/transcriptions');
});
test('missing word timings and rate limits report actionable errors',async()=>{
  assert.throws(()=>responseWords({text:'hello'},2),/mốc từng từ/);
  assert.throws(()=>responseWords({words:[{word:'x',start:null,end:2}]},2),/hợp lệ/);
  await assert.rejects(transcribeAPI({provider:'groq',model:'whisper-large-v3',key:'test',audio:new Float32Array(1),fetcher:async()=>({ok:false,status:429})}),/hạn mức/);
});
