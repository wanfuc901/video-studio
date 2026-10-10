import { SAMPLE_RATE, validateRange, normalizeWords, groupWords, updateCueText, cuesToClips } from './transcript.js';

import { parseLyrics, timedLyricsInRange, alignLyrics } from './lyrics-import.js';
import { PROVIDERS, transcribeAPI, checkLocal, localEndpoint } from './ai-providers.js';

export function setupAILyrics({state,elements,getSelectedClip,pausePlayback,renderAll,revealClip,showToast}) {
  const $=id=>document.getElementById(id);
  $('add-karaoke').insertAdjacentHTML('afterend','<button id="ai-lyrics-button" class="karaoke-add ai-lyrics-button"><span class="ai-star">✦</span><span><strong>Tạo lời bằng AI</strong><small>Nghe âm thanh · tự căn mốc lời</small></span></button>');
  document.body.insertAdjacentHTML('beforeend',`<dialog id="ai-lyrics-dialog" class="ai-dialog">
    <div class="ai-heading"><div><span class="eyebrow">AI • NHẬN DIỆN LỜI</span><h2>Lời chuẩn, nhịp theo video</h2></div><button id="ai-close" class="icon-button" aria-label="Đóng tạo lời AI">×</button></div>
    <p class="ai-intro">Chọn video hoặc âm thanh <strong>còn giọng hát / lời nói</strong>. AI tạo lời và mốc từng từ để bạn sửa trước khi thêm vào timeline.</p>
    <fieldset id="ai-options">
    <label>Cách tạo lời<select id="ai-mode"><option value="auto">AI tự nghe và tạo lời</option><option value="align">Đã có lyrics · AI căn theo lời của tôi</option><option value="timed">Nhập SRT / LRC có mốc · không cần AI</option></select></label>
    <section id="ai-lyrics-input" hidden><div class="ai-import-row"><label class="ai-file-label">Nhập TXT / SRT / LRC<input id="ai-lyrics-file" type="file" accept=".txt,.srt,.lrc,text/plain"></label><span id="ai-lyrics-file-name" class="input-hint"></span></div>
    <label>Lời của đoạn đang chọn<textarea id="ai-supplied-lyrics" rows="6" maxlength="30000" placeholder="Dán lời ở đây, mỗi câu một dòng…"></textarea></label>
    <p class="input-hint" id="ai-lyrics-hint">Chỉ dán lời thuộc đoạn âm thanh đã chọn, đúng thứ tự kể cả điệp khúc lặp. AI lấy mốc từ âm thanh rồi khớp với lời này. Các từ chưa khớp sẽ có mốc ước lượng. Sửa lời và bấm lại sẽ dùng kết quả nghe đã có, không cần chạy model lại.</p></section>
    <label>Nguồn âm thanh<select id="ai-source"></select></label><p id="ai-source-note" class="input-hint"></p>
    <div class="ai-grid"><label>Từ giây trong tệp<input id="ai-from" type="number" min="0" step="0.001"></label><label>Đến giây trong tệp<input id="ai-to" type="number" min="0" step="0.001"></label><label>Chèn tại giây trên timeline<input id="ai-insert" type="number" min="0" step="0.001"></label></div>
    <div id="ai-engine-settings"><label>Nơi chạy AI<select id="ai-provider"><option value="browser">Trên trình duyệt · miễn phí, không key</option><option value="groq">Groq API · key riêng, có free tier</option><option value="local">Trên máy · Faster Whisper CPU / GPU</option></select></label>
    <div id="ai-groq-settings" hidden><label>Groq API key<input id="ai-api-key" type="password" autocomplete="off" spellcheck="false" placeholder="Dán key từ tài khoản Groq của bạn"></label><p class="input-hint">Key chỉ giữ trong tab này, không lưu vào dự án. Âm thanh của đoạn chọn được gửi trực tiếp tới Groq khi bấm nhận diện. <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer">Tạo key</a> · <a href="https://console.groq.com/settings/limits" target="_blank" rel="noopener noreferrer">Xem hạn mức</a></p></div>
    <div id="ai-local-settings" hidden><div class="ai-grid ai-two"><label>Địa chỉ bộ chạy local<input id="ai-local-url" value="http://127.0.0.1:8766" autocomplete="off"></label><label>Mã kết nối local<input id="ai-local-key" type="password" autocomplete="off" spellcheck="false" placeholder="Mã hiện trong cửa sổ chạy local"></label></div><div class="ai-import-row"><button id="ai-local-test" class="button button-ghost" type="button">Kiểm tra kết nối</button><a href="https://github.com/wanfuc901/video-studio/tree/main/tools/local-ai" target="_blank" rel="noopener noreferrer">Cài bộ chạy trên Windows / CPU / GPU ↗</a></div><p id="ai-local-status" class="input-hint" role="status"></p></div>
    <div class="ai-grid"><label>Ngôn ngữ<select id="ai-language"><option value="vietnamese">Tiếng Việt</option><option value="english">Tiếng Anh</option><option value="auto">Tự nhận diện</option><option value="chinese">Tiếng Trung</option><option value="korean">Tiếng Hàn</option><option value="japanese">Tiếng Nhật</option></select></label><label>Mô hình<select id="ai-model"><option value="base">Base · cân bằng</option><option value="tiny">Tiny · nhẹ, thử nhanh</option><option value="small">Small · lớn hơn, chậm hơn</option></select></label><label>Tối đa từ / câu<select id="ai-line-length"><option value="6">6 từ</option><option value="8" selected>8 từ</option><option value="10">10 từ</option><option value="12">12 từ</option></select></label></div></div>
    </fieldset>
    <div class="ai-note"><strong id="ai-provider-title"></strong><p id="ai-provider-note"></p><p id="ai-quality-note">Lời có sẵn giúp giảm sửa nội dung; thời gian nghe của model vẫn phụ thuộc thiết bị. Mốc karaoke cần kiểm tra lại, nhất là nhạc nền lớn hoặc đoạn ngân. Tối đa 10 phút / lần, tệp nguồn 300 MB.</p></div>
    <div id="ai-progress-panel" hidden><div class="ai-progress"><progress id="ai-progress" max="1"></progress><span id="ai-progress-label" role="status" aria-live="polite"></span></div><p id="ai-elapsed" class="input-hint"></p></div>
    <p id="ai-error" class="ai-error" role="alert" hidden></p>
    <section id="ai-review" hidden><div class="ai-review-heading"><h3>Xem và sửa lời</h3><span id="ai-result-count"></span></div><p class="input-hint">Mốc bên dưới là giây trên timeline. Sửa nội dung tại đây; chỉnh nhịp từng từ sau khi chèn. Nếu đổi số từ trong câu, mốc từ của câu đó được chia lại.</p><div id="ai-cue-list"></div><p id="ai-result-note" class="input-hint"></p></section>
    <div class="ai-actions"><button id="ai-cancel" class="button button-ghost" hidden>Dừng nhận diện</button><button id="ai-start" class="button button-ghost">✦ Nhận diện lời</button><button id="ai-insert-button" class="button button-primary" disabled>Thêm lời vào timeline</button></div>
  </dialog>`);
  const dialog=$('ai-lyrics-dialog');
  let sources=new Map(),worker=null,jobId=0,busy=false,cues=[],resultOffset=0,timer=null,startedAt=0,request=null,lastResult=null,activeLyrics=null,activeSignature="",summary="";
  function clearResult() { cues=[];$('ai-review').hidden=true;$('ai-insert-button').disabled=true;$('ai-cue-list').replaceChildren();summary=''; }
  function message(text,progress=null) {
    $('ai-progress-panel').hidden=false;$('ai-progress-label').textContent=text;
    if(progress===null)$('ai-progress').removeAttribute('value');else $('ai-progress').value=progress;
  }
  function error(text) {$('ai-error').textContent=text;$('ai-error').hidden=false;}
  function setBusy(value) {
    busy=value;$('ai-options').disabled=value;$('ai-start').disabled=value || !sources.size;$('ai-cancel').hidden=!value;
    clearInterval(timer);timer=null;
    if(value){startedAt=Date.now();timer=setInterval(()=>{$('ai-elapsed').textContent=`Đã chạy ${Math.floor((Date.now()-startedAt)/1000)} giây. Bạn có thể dừng bất cứ lúc nào.`;},1000);}
  }
  function cancel() {
    if(!busy)return;
    jobId++;request?.abort();request=null;worker?.terminate();worker=null;setBusy(false);clearResult();message('Đã dừng chờ kết quả. Timeline chưa thay đổi; tác vụ đã gửi tới API/local có thể vẫn xử lý.',0);
  }
  function sourceChanged() {
    clearResult();$('ai-error').hidden=true;
    const source=sources.get($('ai-source').value);if(!source)return;
    $('ai-from').value=source.sourceStart.toFixed(3);$('ai-to').value=Math.min(source.asset.duration,source.sourceStart+Math.min(source.duration,600)).toFixed(3);$('ai-insert').value=source.start.toFixed(3);
    $('ai-source-note').textContent=source.clipId?'Dùng âm thanh gốc của clip này, kể cả khi clip đang tắt tiếng. Không trộn các track khác.':'Dùng âm thanh của tệp gốc. Vị trí chèn mặc định là con trỏ hiện tại.';
  }
  function open() {
    if(state.exporting)return;
    pausePlayback();sources=new Map();$('ai-source').replaceChildren();clearResult();$('ai-error').hidden=true;$('ai-progress-panel').hidden=true;
    const selected=getSelectedClip();let preferred=null;
    for(const clip of state.clips){const asset=state.assets.get(clip.assetId);if(!asset||!['video','audio'].includes(asset.kind))continue;
      const key='clip:'+clip.id;sources.set(key,{asset,clipId:clip.id,sourceStart:clip.sourceStart,duration:clip.duration,start:clip.start});
      const option=document.createElement('option');option.value=key;option.textContent=`Clip ${clip.start.toFixed(2)}s · ${asset.file.name}`;$('ai-source').append(option);
      if(clip.id===selected?.id)preferred=key;
    }
    for(const asset of state.assets.values()){if(!['video','audio'].includes(asset.kind))continue;
      const key='asset:'+asset.id;sources.set(key,{asset,sourceStart:0,duration:asset.duration,start:state.playhead});
      const option=document.createElement('option');option.value=key;option.textContent='Tệp gốc · '+asset.file.name;$('ai-source').append(option);
    }
    if(!preferred)preferred=[...sources].find(([,s])=>s.asset.kind==='video')?.[0] || sources.keys().next().value;
    if(preferred){$('ai-source').value=preferred;sourceChanged();}
    else error('Hãy thêm video hoặc file âm thanh vào thư viện trước.');
    setBusy(false);refreshControls();dialog.showModal();
  }
  async function extractAudio(file,from,to,id) {
    if(file.size>300*1024*1024)throw new Error('Tệp lớn hơn 300 MB. Hãy dùng bản MP3/WAV có giọng hát hoặc video đã cắt ngắn.');
    const OfflineContext=window.OfflineAudioContext||window.webkitOfflineAudioContext;
    if(!OfflineContext)throw new Error('Trình duyệt này không hỗ trợ đọc âm thanh. Hãy thử Chrome hoặc Edge trên máy tính.');
    message('Đang đọc âm thanh từ tệp…');
    const bytes=await file.arrayBuffer();if(id!==jobId)throw new Error('cancelled');
    let buffer;
    try {buffer=await new OfflineContext(1,1,SAMPLE_RATE).decodeAudioData(bytes);}
    catch {throw new Error('Không đọc được âm thanh của tệp này. Hãy tải thêm bản MP3/WAV có giọng hát rồi chọn làm nguồn AI.');}
    if(id!==jobId)throw new Error('cancelled');
    const begin=Math.round(from*buffer.sampleRate),end=Math.min(buffer.length,Math.round(to*buffer.sampleRate));
    if(end<=begin)throw new Error('Đoạn đã chọn không có âm thanh.');
    const samples=new Float32Array(end-begin);
    // decodeAudioData resamples to the 16 kHz context rate before mixing channels.
    for(let channel=0;channel<buffer.numberOfChannels;channel++) {
      const values=buffer.getChannelData(channel);
      for(let i=0;i<samples.length;i++)samples[i]+=values[begin+i]/buffer.numberOfChannels;
    }
    let peak=0;for(let i=0;i<samples.length;i++)peak=Math.max(peak,Math.abs(samples[i]));
    if(peak<0.0001)throw new Error('Đoạn này im lặng hoặc không có tín hiệu âm thanh.');
    return samples;
  }
  function renderReview() {
    $('ai-cue-list').replaceChildren();$('ai-review').hidden=false;
    cues.forEach((cue,index)=>{
      const row=document.createElement('div');row.className='ai-cue';if(cue.words.some(w=>w.estimated))row.classList.add('ai-cue-warning');
      const time=document.createElement('span');time.textContent=`${index+1} · ${(resultOffset+cue.start).toFixed(3)} → ${(resultOffset+cue.end).toFixed(3)}s`;
      const input=document.createElement('textarea');input.rows=2;input.value=cue.text;input.maxLength=2000;input.ariaLabel=`Nội dung câu ${index+1}`;
      input.addEventListener('input',()=>{updateCueText(cue,input.value);$('ai-insert-button').disabled=!cues.some(c=>c.text.trim());});
      if(cue.words.some(w=>w.estimated)){const badge=document.createElement('small');badge.className='ai-review-badge';badge.textContent='Mốc ước lượng · cần nghe lại';row.append(badge);}row.append(time,input);$('ai-cue-list').append(row);
    });
    $('ai-result-count').textContent=`${cues.length} câu`;
    $('ai-result-note').textContent=summary+' '+(cues.some(c=>c.words.some(w=>w.estimated))?'Các mốc từ được đánh dấu là ước lượng. Bạn có thể chỉnh lại sau khi chèn.':'Mốc từ do AI dự đoán. Hãy kiểm tra lại nhịp khi nghe thử.');
    $('ai-insert-button').disabled=!cues.length;
  }
  function ensureWorker() {
    if(worker)return worker;
    worker=new Worker(new URL('./transcribe-worker.js',import.meta.url),{type:'module'});
    worker.onmessage=({data})=>{
      if(data.id!==jobId || !busy)return;
      if(data.type==='status')message(data.message);
      if(data.type==='download') {
        const loaded=Number.isFinite(data.loaded)?` · ${(data.loaded/1048576).toFixed(1)} MB`:'';
        message(`Tải ${data.file}${loaded}`,Number.isFinite(data.progress)?data.progress/100:null);
      }
      if(data.type==='progress')message(data.message,data.fraction);
      if(data.type==='error') {
        setBusy(false);worker?.terminate();worker=null;
        error('AI chưa hoàn tất: '+data.message+'. Kiểm tra mạng tới Hugging Face / jsDelivr, hoặc thử Tiny với đoạn ngắn hơn.');
        message('Chưa tạo được lời. Timeline chưa thay đổi.',0);
      }
      if(data.type==='complete') {
        try { complete(normalizeWords(data.chunks,data.duration),data.duration); }
        catch(e){setBusy(false);error(e.message);message('Chưa căn được lời.',0);}
      }
    };
    worker.onerror=()=>{if(!busy)return;setBusy(false);worker?.terminate();worker=null;error('Không khởi chạy được AI. Kiểm tra kết nối mạng và thử lại bằng mô hình Tiny.');message('AI chưa sẵn sàng.',0);};
    return worker;
  }
  function complete(words,duration) {
    setBusy(false);
    lastResult={signature:activeSignature,words,duration};
    if(!words.length)throw new Error('Không nhận diện được lời. Hãy chọn nguồn còn giọng hát hoặc đoạn khác.');
    if(activeLyrics) {
      const aligned=alignLyrics(activeLyrics.lines,words,duration);cues=aligned.cues;
      summary=`Khớp nội dung ${aligned.matched}/${aligned.total} từ. Giữ lời và xuống dòng bạn nhập; đây là khớp theo bản nhận diện, không đảm bảo nhịp hát tuyệt đối.`;
    } else cues=groupWords(words,Number($('ai-line-length').value));
    renderReview();message('Đã có lời và mốc. Kiểm tra trước khi chèn.',1);
  }
  function refreshControls(resetModel=false) {
    const provider=$('ai-provider').value,mode=$('ai-mode').value;
    $('ai-line-length').disabled=mode!=='auto';$('ai-lyrics-input').hidden=mode==='auto';$('ai-engine-settings').hidden=mode==='timed';
    $('ai-groq-settings').hidden=provider!=='groq';$('ai-local-settings').hidden=provider!=='local';
    if(resetModel || !PROVIDERS[provider].some(([id])=>id===$('ai-model').value)) {
      $('ai-model').replaceChildren(...PROVIDERS[provider].map(([id,label])=>{const o=document.createElement('option');o.value=id;o.textContent=label;return o;}));
    }
    $('ai-start').textContent=mode==='timed'?'Đọc mốc lời':mode==='align'?'✦ Căn theo lyrics':'✦ Nhận diện lời';
    $('ai-lyrics-hint').textContent=mode==='timed'?'Mốc SRT/LRC tính từ đầu tệp nguồn. Chỉ lấy câu trong khoảng Từ–Đến; chuyển sang vị trí Chèn trên timeline. Mốc từng từ trong câu được chia đều để bạn chỉnh tiếp.':'Chỉ dán lời của đúng đoạn đang chọn, mỗi câu một dòng, đúng thứ tự kể cả điệp khúc lặp. Các từ chưa khớp sẽ có mốc ước lượng. Sau khi sửa lời, bấm lại để dùng kết quả nghe đã có mà không chạy model lại.';
    const notes={browser:['Không cần key · âm thanh ở trên thiết bị','Whisper chạy trên trình duyệt. Lần đầu tải model từ Hugging Face, có thể hàng trăm MB. Tiny nhẹ hơn; Small chậm hơn.'],groq:['Groq · có gói miễn phí theo hạn mức','Dùng key do bạn tự tạo. Free tier có hạn mức; kiểm tra gói và Limits của tài khoản. Nếu tài khoản đã bật thanh toán, phí phụ thuộc gói của bạn. Chỉ gửi đoạn âm thanh đã chọn, không gửi file video gốc hoặc lyrics.'],local:['Faster Whisper · chạy trên máy của bạn','Tải repo và chạy tools/local-ai/start-windows.cmd trước. Chỉ gửi âm thanh tới localhost. CPU dùng int8; GPU NVIDIA cần CUDA/cuDNN phù hợp. Lần đầu tải model, lần sau dùng bản cache.']};
    $('ai-provider-title').textContent=mode==='timed'?'Nhập lời có mốc · không chạy AI':notes[provider][0];
    $('ai-provider-note').textContent=mode==='timed'?'SRT/LRC có thể dùng với beat đã bỏ giọng hát. Giữ mốc câu từ file; các mốc từ là ước lượng, không phải kết quả AI.':notes[provider][1];
  }
  $('ai-lyrics-button').onclick=open;$('ai-source').onchange=sourceChanged;
  $('ai-provider').onchange=()=>{clearResult();refreshControls(true);};
  $('ai-mode').onchange=()=>{clearResult();refreshControls();};
  for(const id of ['ai-from','ai-to','ai-insert','ai-language','ai-model','ai-line-length','ai-supplied-lyrics','ai-local-url'])$(id).addEventListener('input',clearResult);
  $('ai-lyrics-file').onchange=async()=>{
    const file=$('ai-lyrics-file').files[0];if(!file)return;
    try {
      if(file.size>120000)throw new Error('File lời quá lớn. Chọn đoạn tối đa 2.000 từ.');
      const text=await file.text();if(busy)return;
      const parsed=parseLyrics(text);$('ai-supplied-lyrics').value=text;$('ai-lyrics-file-name').textContent=file.name;
      $('ai-mode').value=parsed.format==='txt'?'align':'timed';clearResult();refreshControls();$('ai-error').hidden=true;
    }catch(e){error(e.message);}finally{$('ai-lyrics-file').value='';}
  };
  $('ai-local-test').onclick=async()=>{
    const button=$('ai-local-test');button.disabled=true;$('ai-local-status').textContent='Đang kết nối…';
    try{const result=await checkLocal($('ai-local-url').value,$('ai-local-key').value);$('ai-local-status').textContent=`Đã kết nối · ${result.device} / ${result.compute_type}. Model tải khi bắt đầu nhận diện.`;}
    catch{$('ai-local-status').textContent='Chưa kết nối. Chạy bộ local, nhập đúng mã và cho phép truy cập mạng cục bộ nếu trình duyệt hỏi.';}
    finally{button.disabled=false;}
  };
  $('ai-start').onclick=async()=>{
    if(busy)return;
    const source=sources.get($('ai-source').value);if(!source)return;
    clearResult();$('ai-error').hidden=true;
    const from=Number($('ai-from').value),to=Number($('ai-to').value),insertAt=Number($('ai-insert').value);
    const provider=$('ai-provider').value,mode=$('ai-mode').value,model=$('ai-model').value,language=$('ai-language').value;
    const id=++jobId;
    try {
      if(['ai-from','ai-to','ai-insert'].some(id=>!$(id).value.trim()))throw new Error('Hãy nhập đủ mốc thời gian.');
      validateRange(from,to,source.asset.duration,insertAt);resultOffset=insertAt;
      activeLyrics=mode==='auto'?null:parseLyrics($('ai-supplied-lyrics').value);
      if(mode==='timed') {
        if(activeLyrics.format==='txt')throw new Error('Lời này chưa có mốc. Chọn “Đã có lyrics” để AI căn hoặc nhập SRT/LRC.');
        cues=timedLyricsInRange(activeLyrics,from,to);
        if(!cues.length)throw new Error('Không có câu trong đoạn đã chọn. Mốc file lời phải tính từ đầu tệp nguồn.');
        summary='Giữ mốc câu của file. Mốc từng từ được chia đều, hãy căn lại theo nhịp.';renderReview();message('Đã đọc mốc lời, không cần chạy AI.',1);return;
      }
      if(activeLyrics && activeLyrics.format!=='txt')throw new Error('File này đã có mốc. Chọn “Nhập SRT / LRC” để giữ đúng mốc, hoặc dán lời thuần văn bản để AI căn lại.');
      activeSignature=JSON.stringify([source.asset.id,from,to,provider,model,language,provider==='local'?$('ai-local-url').value:'']);
      if(lastResult?.signature===activeSignature){complete(lastResult.words,lastResult.duration);message('Đã căn lại từ kết quả nghe có sẵn, không chạy model lại.',1);return;}
      if(provider==='groq'&&!$('ai-api-key').value.trim())throw new Error('Hãy nhập Groq API key của bạn.');
      if(provider==='local'){localEndpoint($('ai-local-url').value);if(!$('ai-local-key').value.trim())throw new Error('Hãy nhập mã kết nối local.');}
      setBusy(true);
      const audio=await extractAudio(source.asset.file,from,to,id);if(id!==jobId)return;
      if(provider==='browser') {
        message('Đang chuẩn bị AI. Lần đầu cần tải mô hình…');
        ensureWorker().postMessage({type:'transcribe',id,audio,model,language},[audio.buffer]);
      } else {
        request=new AbortController();message(provider==='groq'?'Đang gửi đoạn âm thanh tới Groq và nhận diện…':'Đang nhận diện trên máy. Lần đầu có thể cần tải model…');
        const words=await transcribeAPI({provider,model,language,audio,key:$(provider==='groq'?'ai-api-key':'ai-local-key').value,endpoint:$('ai-local-url').value,signal:request.signal});
        if(id!==jobId)return;request=null;complete(words,audio.length/SAMPLE_RATE);
      }
    }catch(e){if(id!==jobId)return;setBusy(false);request=null;error(e.message||'Không đọc được âm thanh.');message('Chưa tạo được lời.',0);}
  };
  refreshControls(true);
  $('ai-insert-button').onclick=()=>{
    if(busy || !cues.length)return;
    const selected=getSelectedClip();
    const clips=cuesToClips(cues,resultOffset,()=>crypto.randomUUID(),selected?.track==='text'?selected.style:null);
    if(!clips.length)return;
    pausePlayback();state.clips.push(...clips);state.selectedId=clips[0].id;state.playhead=clips[0].start;
    renderAll();revealClip(clips[0]);elements['timeline-scroll'].scrollIntoView({block:'nearest'});
    clearResult();dialog.close();elements['timeline-scroll'].focus({preventScroll:true});
    showToast(`Đã thêm ${clips.length} câu AI. Ctrl+Z để hoàn tác toàn bộ lần chèn.`);
  };
  $('ai-cancel').onclick=cancel;$('ai-close').onclick=()=>{cancel();dialog.close();};dialog.addEventListener('cancel',cancel);
  // Once the dialog closes, release model memory; browser cache can reuse its downloaded files.
  dialog.addEventListener('close',()=>{cancel();worker?.terminate();worker=null;});
  return {open};
}
