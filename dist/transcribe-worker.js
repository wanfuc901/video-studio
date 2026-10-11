import { SAMPLE_RATE, planWindows } from './transcript.js';
const MODEL_IDS = { tiny:'Xenova/whisper-tiny', base:'Xenova/whisper-base', small:'Xenova/whisper-small' };
const TRANSFORMERS_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
// WebGPU runs the encoder in fp32 (q8 kernels are WASM-only) and a 4-bit decoder to fit small GPUs.
const DTYPES = { webgpu:{ encoder_model:'fp32', decoder_model_merged:'q4' }, wasm:'q8' };
const SILENCE_RMS = 0.0001;
let transcriber = null, loadedKey = null, running = false;

async function hasWebGPU() {
  if (!self.navigator?.gpu) return false;
  try { return Boolean(await self.navigator.gpu.requestAdapter()); }
  catch { return false; } // An adapter error simply means "no usable GPU": use WASM.
}

// Multi-threaded WASM needs cross-origin isolation (SharedArrayBuffer); static hosts without COOP/COEP get 1 thread.
function wasmThreads() {
  return self.crossOriginIsolated ? Math.max(1, Math.min(4, (self.navigator?.hardwareConcurrency || 2) - 1)) : 1;
}

async function loadTranscriber(library, model, device, send) {
  const key = `${model}:${device}`;
  if (transcriber && loadedKey === key) return transcriber;
  if (transcriber) await transcriber.dispose();
  transcriber = null; loadedKey = null;
  send({type:'status',message:`Đang tải mô hình (${device === 'webgpu' ? 'GPU · WebGPU' : `CPU · ${wasmThreads()} luồng`})…`});
  transcriber = await library.pipeline('automatic-speech-recognition', MODEL_IDS[model], {
    device, dtype:DTYPES[device], progress_callback:p=>{
      if (p.status==='progress') send({type:'download',file:p.file || 'mô hình',loaded:p.loaded,total:p.total,progress:p.progress});
      else if (p.status==='initiate') send({type:'status',message:'Đang tải mô hình: '+p.file});
    }
  });
  loadedKey = key;
  return transcriber;
}

async function transcribeWindows(run, audio, language, send) {
  const duration=audio.length/SAMPLE_RATE, windows=planWindows(duration), chunks=[];
  for (let i=0;i<windows.length;i++) {
    const w=windows[i];
    send({type:'progress',fraction:w.coreStart/duration,message:`Đang nhận diện đoạn ${i+1}/${windows.length}…`});
    const sample=audio.slice(Math.round(w.start*SAMPLE_RATE),Math.round(w.end*SAMPLE_RATE));
    // Ignore digital silence rather than asking Whisper to invent text over it.
    let energy=0;for(let j=0;j<sample.length;j++)energy+=sample[j]*sample[j];
    if (Math.sqrt(energy/sample.length)>SILENCE_RMS) {
      const options={return_timestamps:'word',chunk_length_s:30,stride_length_s:5,task:'transcribe',num_beams:1,do_sample:false};
      if (language!=='auto') options.language=language;
      const output=await run(sample,options);
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
  return chunks.sort((a,b)=>a.timestamp[0]-b.timestamp[0]);
}

self.onmessage = async ({data}) => {
  if (data.type !== 'transcribe' || running) return;
  running=true;
  const {id,audio,model,language}=data;
  const send = payload => self.postMessage({id,...payload});
  try {
    if (!MODEL_IDS[model] || !(audio instanceof Float32Array) || !audio.length || audio.length > SAMPLE_RATE*600) throw new Error('Đoạn âm thanh không hợp lệ.');
    send({type:'status',message:'Đang tải bộ nhận diện AI…'});
    const library = await import(TRANSFORMERS_URL);
    library.env.allowLocalModels=false;
    library.env.backends.onnx.wasm.numThreads=wasmThreads();
    library.env.backends.onnx.wasm.proxy=false;
    let device = await hasWebGPU() ? 'webgpu' : 'wasm', chunks;
    try {
      chunks = await transcribeWindows(await loadTranscriber(library, model, device, send), audio, language, send);
    } catch (error) {
      if (device !== 'webgpu') throw error;
      // Some GPUs/drivers expose WebGPU but fail on Whisper kernels; retry the same audio on CPU.
      send({type:'status',message:`WebGPU lỗi (${error instanceof Error ? error.message : error}). Chuyển sang CPU…`});
      device = 'wasm';
      chunks = await transcribeWindows(await loadTranscriber(library, model, device, send), audio, language, send);
    }
    send({type:'complete',chunks,duration:audio.length/SAMPLE_RATE,device});
  } catch(error) {
    send({type:'error',message:error instanceof Error?error.message:String(error)});
  } finally {running=false;}
};
