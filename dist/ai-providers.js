import { SAMPLE_RATE, normalizeWords } from './transcript.js';
export const PROVIDERS={
  browser:[['base','Base · cân bằng'],['tiny','Tiny · nhẹ, thử nhanh'],['small','Small · lớn hơn, chậm hơn']],
  groq:[['whisper-large-v3-turbo','Whisper Large V3 Turbo · nhanh'],['whisper-large-v3','Whisper Large V3 · ưu tiên chất lượng']],
  local:[['large-v3','Large V3 · chính xác nhất, nên có GPU'],['turbo','Turbo · nhanh, nên có GPU'],['medium','Medium · nhiều RAM hơn'],['small','Small · CPU/GPU'],['base','Base · nhẹ'],['tiny','Tiny · thử nhanh']]
};
const languages={vietnamese:'vi',english:'en',chinese:'zh',korean:'ko',japanese:'ja'};
export function localEndpoint(value) {
  let u;try{u=new URL(value);}catch{throw new Error('Địa chỉ local không hợp lệ. Ví dụ http://127.0.0.1:8766');}
  if(!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash)throw new Error('Model local phải dùng localhost hoặc 127.0.0.1 trên máy của bạn.');
  return u.origin;
}
export function wavBlob(audio) {
  const buffer=new ArrayBuffer(44+audio.length*2),v=new DataView(buffer);
  const put=(at,s)=>{for(let i=0;i<s.length;i++)v.setUint8(at+i,s.charCodeAt(i));};
  put(0,'RIFF');v.setUint32(4,36+audio.length*2,true);put(8,'WAVE');put(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,SAMPLE_RATE,true);v.setUint32(28,SAMPLE_RATE*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);put(36,'data');v.setUint32(40,audio.length*2,true);
  for(let i=0;i<audio.length;i++){const s=Math.max(-1,Math.min(1,audio[i]));v.setInt16(44+i*2,Math.round(s*(s<0?32768:32767)),true);}
  return new Blob([buffer],{type:'audio/wav'});
}
export function responseWords(data,duration) {
  const raw=Array.isArray(data.words)?data.words:Array.isArray(data.segments)?data.segments.flatMap(s=>s.words||[]):[];
  if(!raw.length)throw new Error('Model không trả mốc từng từ. Chọn model Whisper có hỗ trợ word timestamps.');
  const words=normalizeWords(raw.map(w=>({text:w.word??w.text,timestamp:[w.start,w.end]})),duration);
  if(!words.length)throw new Error('Không nhận được mốc từ hợp lệ.');
  return words;
}
export async function transcribeAPI({provider,model,key,endpoint,audio,language,signal,fetcher=fetch}) {
  if(!['groq','local'].includes(provider)||!PROVIDERS[provider].some(([id])=>id===model))throw new Error('Nhà cung cấp hoặc model không hợp lệ.');
  if(!key.trim())throw new Error(provider==='groq'?'Hãy nhập Groq API key của bạn.':'Hãy nhập mã kết nối do bộ chạy local hiển thị.');
  const url=provider==='groq'?'https://api.groq.com/openai/v1/audio/transcriptions':localEndpoint(endpoint)+'/v1/audio/transcriptions';
  const form=new FormData();form.append('file',wavBlob(audio),'selected-audio.wav');form.append('model',model);form.append('response_format','verbose_json');form.append('timestamp_granularities[]','word');form.append('temperature','0');
  if(languages[language])form.append('language',languages[language]);
  let response;
  try{response=await fetcher(url,{method:'POST',headers:{Authorization:'Bearer '+key.trim()},body:form,signal,credentials:'omit',redirect:'error'});}
  catch(e){if(e.name==='AbortError')throw e;throw new Error(provider==='local'?'Chưa kết nối được model local. Chạy start-windows.cmd, kiểm tra địa chỉ và quyền truy cập mạng cục bộ của trình duyệt.':'Không kết nối được Groq. Kiểm tra mạng và thử lại.');}
  if(!response.ok) {
    if(response.status===401||response.status===403)throw new Error('Key/mã kết nối không đúng hoặc chưa có quyền dùng model.');
    if(response.status===429)throw new Error('Đã chạm hạn mức hoặc local đang bận. Chờ rồi thử lại; xem Limits trên tài khoản Groq nếu dùng API.');
    if(response.status===413)throw new Error('Đoạn âm thanh quá lớn. Hãy chọn đoạn ngắn hơn.');
    throw new Error(`Nhận diện chưa hoàn tất (HTTP ${response.status}). ${provider==='local'?'Xem cửa sổ bộ chạy local để biết lỗi model/CPU/GPU.':'Thử lại sau hoặc chọn model khác.'}`);
  }
  let data;try{data=await response.json();}catch{throw new Error('Máy chủ không trả kết quả JSON hợp lệ.');}
  return responseWords(data,audio.length/SAMPLE_RATE);
}
export async function checkLocal(endpoint,key,fetcher=fetch) {
  const response=await fetcher(localEndpoint(endpoint)+'/health',{headers:{Authorization:'Bearer '+key.trim()},credentials:'omit',redirect:'error',signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw new Error('Không kết nối được hoặc mã local chưa đúng.');
  const data=await response.json();if(data.service!=='video-studio-local')throw new Error('Địa chỉ này không phải bộ chạy local của Video Studio.');
  return data;
}

export const KARAOKE_POLL_MS = 1000;
export const KARAOKE_STAGES = {
  queued:'Đang chờ GPU…', decode:'Đang giải mã đoạn âm thanh…', separate:'Đang tách giọng hát khỏi nhạc nền…',
  dereverb:'Đang khử vang để bắt đúng điểm dứt giọng…', words:'Đang căn từng từ theo giọng hát…',
  refine:'Đang dò điểm vào từ, đoạn ngân và tiếng vang…', beats:'Đang dò nhịp bài hát…'
};
const abortReason = signal => signal.reason ?? new DOMException('Aborted', 'AbortError');
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(abortReason(signal)); return; }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(abortReason(signal)); }, { once:true });
});
async function localJson(fetcher, url, key, init = {}) {
  let response;
  try { response = await fetcher(url, { ...init, headers:{ Authorization:'Bearer '+key.trim(), ...init.headers }, credentials:'omit', redirect:'error' }); }
  catch (error) { if (error.name === 'AbortError') throw error; throw new Error('Mất kết nối tới bộ chạy local. Kiểm tra cửa sổ start-windows.cmd còn mở.'); }
  let data = {};
  try { data = await response.json(); }
  catch { if (response.ok) throw new Error('Bộ chạy local trả dữ liệu không hợp lệ.'); }
  if (!response.ok) throw new Error(data.error || `Bộ chạy local báo lỗi HTTP ${response.status}.`);
  return data;
}
/**
 * Karaoke Pro on the local runner: uploads the original media file once (decoded in range on the PC,
 * not in the browser), then polls until separation, alignment, sustain/echo and beat analysis finish.
 */
export async function runKaraokeJob({ endpoint, key, file, options, signal, onProgress = () => {}, fetcher = fetch, pollMs = KARAOKE_POLL_MS }) {
  const base = localEndpoint(endpoint) + '/v1/karaoke/jobs';
  const job = await localJson(fetcher, base, key, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(options), signal });
  const jobUrl = `${base}/${job.id}`;
  try {
    onProgress('upload', 0);
    await localJson(fetcher, jobUrl + '/audio', key, { method:'PUT', headers:{ 'Content-Type':'application/octet-stream' }, body:file, signal });
    for (;;) {
      const status = await localJson(fetcher, jobUrl, key, { signal });
      if (status.state === 'done') return status.result;
      if (status.state === 'error') throw new Error(status.error || 'Karaoke Pro chưa hoàn tất.');
      if (status.state === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
      onProgress(status.stage, status.progress);
      await wait(pollMs, signal);
    }
  } catch (error) {
    if (signal?.aborted) await cancelKaraokeJob(fetcher, jobUrl, key);
    throw error;
  }
}
// Best effort: if the runner is unreachable the job finishes on its own and its result is never read.
async function cancelKaraokeJob(fetcher, jobUrl, key) {
  try { await localJson(fetcher, jobUrl, key, { method:'DELETE' }); return true; }
  catch { return false; }
}
