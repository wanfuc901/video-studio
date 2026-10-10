import { SAMPLE_RATE, validateRange, normalizeWords, groupWords, updateCueText, cuesToClips } from './transcript.js';

export function setupAILyrics({state,elements,getSelectedClip,pausePlayback,renderAll,revealClip,showToast}) {
  const $=id=>document.getElementById(id);
  $('add-karaoke').insertAdjacentHTML('afterend','<button id="ai-lyrics-button" class="karaoke-add ai-lyrics-button"><span class="ai-star">✦</span><span><strong>Tạo lời bằng AI</strong><small>Nghe âm thanh · tự căn mốc lời</small></span></button>');
  document.body.insertAdjacentHTML('beforeend',`<dialog id="ai-lyrics-dialog" class="ai-dialog">
    <div class="ai-heading"><div><span class="eyebrow">AI • NHẬN DIỆN LỜI</span><h2>Từ âm thanh thành lời karaoke</h2></div><button id="ai-close" class="icon-button" aria-label="Đóng tạo lời AI">×</button></div>
    <p class="ai-intro">Chọn video hoặc âm thanh <strong>còn giọng hát / lời nói</strong>. AI tạo lời và mốc từng từ để bạn sửa trước khi thêm vào timeline.</p>
    <fieldset id="ai-options"><label>Nguồn âm thanh<select id="ai-source"></select></label><p id="ai-source-note" class="input-hint"></p>
    <div class="ai-grid"><label>Từ giây trong tệp<input id="ai-from" type="number" min="0" step="0.001"></label><label>Đến giây trong tệp<input id="ai-to" type="number" min="0" step="0.001"></label><label>Chèn tại giây trên timeline<input id="ai-insert" type="number" min="0" step="0.001"></label></div>
    <div class="ai-grid"><label>Ngôn ngữ<select id="ai-language"><option value="vietnamese">Tiếng Việt</option><option value="english">Tiếng Anh</option><option value="auto">Tự nhận diện</option><option value="chinese">Tiếng Trung</option><option value="korean">Tiếng Hàn</option><option value="japanese">Tiếng Nhật</option></select></label><label>Mô hình<select id="ai-model"><option value="base">Base · cân bằng</option><option value="tiny">Tiny · nhẹ, thử nhanh</option><option value="small">Small · lớn hơn, chậm hơn</option></select></label><label>Tối đa từ / câu<select id="ai-line-length"><option value="6">6 từ</option><option value="8" selected>8 từ</option><option value="10">10 từ</option><option value="12">12 từ</option></select></label></div>
    </fieldset>
    <div class="ai-note"><strong>Không cần API key · xử lý trên thiết bị</strong><p>Lần đầu cần mạng để tải mô hình từ Hugging Face (có thể hàng trăm MB). File âm thanh không được tải lên máy chủ. Nhận diện có thể mất nhiều phút; bắt đầu bằng đoạn 20–30 giây. Tối đa 10 phút / lần và tệp 300 MB.</p><p>Với bài hát, AI có thể nghe sai từ hoặc lệch nhịp. Beat đã bỏ giọng hát không thể dùng để lấy lời. Hãy nghe và sửa lại kết quả.</p></div>
    <div id="ai-progress-panel" hidden><div class="ai-progress"><progress id="ai-progress" max="1"></progress><span id="ai-progress-label" role="status" aria-live="polite"></span></div><p id="ai-elapsed" class="input-hint"></p></div>
    <p id="ai-error" class="ai-error" role="alert" hidden></p>
    <section id="ai-review" hidden><div class="ai-review-heading"><h3>Xem và sửa lời</h3><span id="ai-result-count"></span></div><p class="input-hint">Mốc bên dưới là giây trên timeline. Sửa nội dung tại đây; chỉnh nhịp từng từ sau khi chèn. Nếu đổi số từ trong câu, mốc từ của câu đó được chia lại.</p><div id="ai-cue-list"></div><p id="ai-result-note" class="input-hint"></p></section>
    <div class="ai-actions"><button id="ai-cancel" class="button button-ghost" hidden>Dừng nhận diện</button><button id="ai-start" class="button button-ghost">✦ Nhận diện lời</button><button id="ai-insert-button" class="button button-primary" disabled>Thêm lời vào timeline</button></div>
  </dialog>`);
  const dialog=$('ai-lyrics-dialog');
  let sources=new Map(),worker=null,jobId=0,busy=false,cues=[],resultOffset=0,timer=null,startedAt=0;
  function clearResult() { cues=[];$('ai-review').hidden=true;$('ai-insert-button').disabled=true;$('ai-cue-list').replaceChildren(); }
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
    jobId++;worker?.terminate();worker=null;setBusy(false);clearResult();message('Đã dừng. Timeline chưa được thay đổi.',0);
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
    setBusy(false);dialog.showModal();
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
      const row=document.createElement('div');row.className='ai-cue';
      const time=document.createElement('span');time.textContent=`${index+1} · ${(resultOffset+cue.start).toFixed(3)} → ${(resultOffset+cue.end).toFixed(3)}s`;
      const input=document.createElement('textarea');input.rows=2;input.value=cue.text;input.maxLength=2000;input.ariaLabel=`Nội dung câu ${index+1}`;
      input.addEventListener('input',()=>{updateCueText(cue,input.value);$('ai-insert-button').disabled=!cues.some(c=>c.text.trim());});
      row.append(time,input);$('ai-cue-list').append(row);
    });
    $('ai-result-count').textContent=`${cues.length} câu`;
    $('ai-result-note').textContent=cues.some(c=>c.words.some(w=>w.estimated))?'Một số mốc từ đã được ước lượng từ kết quả AI. Bạn có thể chỉnh lại sau khi chèn.':'Mốc từ do AI dự đoán. Hãy kiểm tra lại nhịp khi nghe thử.';
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
        setBusy(false);const words=normalizeWords(data.chunks,data.duration);cues=groupWords(words,Number($('ai-line-length').value));
        if(!cues.length){error('Không nhận diện được lời trong đoạn này. Hãy chọn nguồn còn giọng hát hoặc thử đoạn khác.');message('Không có lời để chèn.',0);return;}
        renderReview();message('Đã tạo lời. Kiểm tra nội dung trước khi chèn.',1);
      }
    };
    worker.onerror=()=>{if(!busy)return;setBusy(false);worker?.terminate();worker=null;error('Không khởi chạy được AI. Kiểm tra kết nối mạng và thử lại bằng mô hình Tiny.');message('AI chưa sẵn sàng.',0);};
    return worker;
  }
  $('ai-lyrics-button').onclick=open;$('ai-source').onchange=sourceChanged;
  for(const id of ['ai-from','ai-to','ai-insert','ai-language','ai-model','ai-line-length'])$(id).addEventListener('change',clearResult);
  $('ai-start').onclick=async()=>{
    if(busy)return;
    const source=sources.get($('ai-source').value);if(!source)return;
    clearResult();$('ai-error').hidden=true;
    const from=Number($('ai-from').value),to=Number($('ai-to').value),insertAt=Number($('ai-insert').value);
    const id=++jobId;
    try {
      if(['ai-from','ai-to','ai-insert'].some(id=>!$(id).value.trim()))throw new Error('Hãy nhập đủ mốc thời gian.');
      validateRange(from,to,source.asset.duration,insertAt);
      setBusy(true);resultOffset=insertAt;
      const audio=await extractAudio(source.asset.file,from,to,id);if(id!==jobId)return;
      message('Đang chuẩn bị AI. Lần đầu cần tải mô hình…');
      ensureWorker().postMessage({type:'transcribe',id,audio,model:$('ai-model').value,language:$('ai-language').value},[audio.buffer]);
    }catch(e){if(id!==jobId)return;setBusy(false);error(e.message||'Không đọc được âm thanh.');message('Chưa tạo được lời.',0);}
  };
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
