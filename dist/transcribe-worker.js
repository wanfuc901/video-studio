import { SAMPLE_RATE, planWindows } from './transcript.js';
const MODEL_IDS = { tiny:'Xenova/whisper-tiny', base:'Xenova/whisper-base', small:'Xenova/whisper-small' };
let transcriber = null, currentModel = null, running = false;
self.onmessage = async ({data}) => {
  if (data.type !== 'transcribe' || running) return;
  running=true;
  const {id,audio,model,language}=data;
  const send = payload => self.postMessage({id,...payload});
  try {
    if (!MODEL_IDS[model] || !(audio instanceof Float32Array) || !audio.length || audio.length > SAMPLE_RATE*600) throw new Error('Đoạn âm thanh không hợp lệ.');
    send({type:'status',message:'Đang tải bộ nhận diện AI…'});
    const {pipeline,env} = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1');
    env.allowLocalModels=false;
    env.backends.onnx.wasm.numThreads=1;
    env.backends.onnx.wasm.proxy=false;
    if (!transcriber || currentModel !== model) {
      if (transcriber) await transcriber.dispose();
      transcriber=null; currentModel=null;
      transcriber=await pipeline('automatic-speech-recognition', MODEL_IDS[model], {
        device:'wasm',dtype:'q8',progress_callback:p=>{
          if (p.status==='progress') send({type:'download',file:p.file || 'mô hình',loaded:p.loaded,total:p.total,progress:p.progress});
          else if (p.status==='initiate') send({type:'status',message:'Đang tải mô hình: '+p.file});
        }
      });
      currentModel=model;
    }
    const duration=audio.length/SAMPLE_RATE, windows=planWindows(duration), chunks=[];
    for (let i=0;i<windows.length;i++) {
      const w=windows[i];
      send({type:'progress',fraction:w.coreStart/duration,message:`Đang nhận diện đoạn ${i+1}/${windows.length}…`});
      const sample=audio.slice(Math.round(w.start*SAMPLE_RATE),Math.round(w.end*SAMPLE_RATE));
      // Ignore digital silence rather than asking Whisper to invent text over it.
      let energy=0;for(let j=0;j<sample.length;j++)energy+=sample[j]*sample[j];
      if (Math.sqrt(energy/sample.length)>0.0001) {
        const options={return_timestamps:'word',chunk_length_s:30,stride_length_s:5,task:'transcribe',num_beams:1,do_sample:false};
        if (language!=='auto') options.language=language;
        const output=await transcriber(sample,options);
        if (!Array.isArray(output.chunks)) throw new Error('Mô hình chưa trả về mốc từ. Hãy thử mô hình khác.');
        for(const chunk of output.chunks) {
          if (!Array.isArray(chunk.timestamp) || !Number.isFinite(chunk.timestamp[0])) continue;
          const a=w.start+chunk.timestamp[0];
          const b=Number.isFinite(chunk.timestamp[1])?Math.min(duration,w.start+chunk.timestamp[1]):null;
          const mid=b===null?a:(a+b)/2;
          if (mid>=w.coreStart && (mid<w.coreEnd || i===windows.length-1)) chunks.push({text:chunk.text,timestamp:[a,b]});
        }
      }
      send({type:'progress',fraction:w.coreEnd/duration,message:`Đã nhận diện ${i+1}/${windows.length} đoạn`});
    }
    chunks.sort((a,b)=>a.timestamp[0]-b.timestamp[0]);
    send({type:'complete',chunks,duration});
  } catch(error) {
    send({type:'error',message:error instanceof Error?error.message:String(error)});
  } finally {running=false;}
};
