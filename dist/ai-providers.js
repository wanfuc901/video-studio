import { SAMPLE_RATE, normalizeWords } from './transcript.js';
export const PROVIDERS={
  browser:[['base','Base · cân bằng'],['tiny','Tiny · nhẹ, thử nhanh'],['small','Small · lớn hơn, chậm hơn']],
  groq:[['whisper-large-v3-turbo','Whisper Large V3 Turbo · nhanh'],['whisper-large-v3','Whisper Large V3 · ưu tiên chất lượng']],
  local:[['small','Small · CPU/GPU'],['medium','Medium · nhiều RAM hơn'],['large-v3','Large V3 · nên có GPU'],['turbo','Turbo · nên có GPU'],['base','Base · nhẹ'],['tiny','Tiny · thử nhanh']]
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
