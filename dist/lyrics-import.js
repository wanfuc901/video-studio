import { distributeWords, wordsOf, ms } from './karaoke.js';

const clean = s => s.normalize('NFC').toLocaleLowerCase('vi').replace(/[^\p{L}\p{N}]/gu,'');
const loose = s => clean(s).normalize('NFD').replace(/\p{M}/gu,'').replace(/đ/g,'d');
const clock = s => s.replace(',', '.').split(':').reduce((a,n)=>a*60+Number(n),0);
function estimatedCue(text,start,end) {
  return {text,start:ms(start),end:ms(end),words:distributeWords(text,end-start).map(w=>({...w,start:ms(start+w.start),end:ms(start+w.end),estimated:true})),timingSource:'subtitle'};
}
export function parseLyrics(text, format='auto') {
  text=text.replace(/^\uFEFF/,'').replace(/\r/g,'').trim();
  if(!text)throw new Error('Hãy dán lời hoặc chọn file TXT, SRT, LRC.');
  if(text.length>30000)throw new Error('Lời quá dài. Chọn tối đa 2.000 từ cho đoạn đang căn.');
  const lines=text.split('\n').map(s=>s.trim()).filter(Boolean);
  if(format==='auto')format=text.includes('-->')?'srt':lines.some(s=>/^\[\d+:\d+(?:\.\d+)?\]/.test(s))?'lrc':'txt';
  if(format==='txt') {
    if(wordsOf(lines.join(' ')).length>2000)throw new Error('Tối đa 2.000 từ mỗi lần căn lời.');
    return {format,lines,cues:[]};
  }
  const cues=[];
  if(format==='srt') {
    for(const block of text.split(/\n\s*\n/)) {
      const rows=block.split('\n'),i=rows.findIndex(l=>l.includes('-->'));
      if(i<0)continue;
      const times=rows[i].match(/(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/);
      if(!times)throw new Error('Mốc SRT không hợp lệ. Dùng định dạng 00:00:01,000 --> 00:00:03,000.');
      const lyric=rows.slice(i+1).join(' ').replace(/<[^>]*>/g,'').trim();
      if(lyric)cues.push({text:lyric,start:clock(times[1]),end:clock(times[2])});
    }
  } else if(format==='lrc') {
    const offset=Number(text.match(/\[offset:([+-]?\d+)\]/i)?.[1]||0)/1000;
    for(const line of lines) {
      const tags=[...line.matchAll(/\[(\d+:\d{2}(?:\.\d{1,3})?)\]/g)];
      const lyric=line.replace(/\[[^\]]*\]/g,'').trim();
      for(const tag of tags)cues.push({text:lyric,start:Math.max(0,clock(tag[1])+offset),end:null});
    }
    cues.sort((a,b)=>a.start-b.start);
    for(let i=0;i<cues.length;i++)cues[i].end=cues[i+1]?.start??null;
  } else throw new Error('Chỉ hỗ trợ TXT, SRT và LRC.');
  if(!cues.some(c=>c.text))throw new Error('Không tìm thấy câu có mốc thời gian trong file.');
  cues.sort((a,b)=>a.start-b.start);
  for(let i=0;i<cues.length;i++) {
    const c=cues[i];
    if(c.end!==null && c.end<=c.start)throw new Error('Có mốc lời trùng hoặc ngược thời gian. Hãy sửa file trước khi nhập.');
    if(i && cues[i-1].end>c.start+.001)throw new Error('Các câu phụ đề đang chồng nhau. Hãy tách hoặc sửa mốc trước khi nhập.');
  }
  return {format,lines:cues.filter(c=>c.text).map(c=>c.text),cues};
}
export function timedLyricsInRange(parsed,from,to) {
  return parsed.cues.filter(c=>c.text && c.start<to && (c.end??to)>from).map(c=>estimatedCue(c.text,Math.max(0,c.start-from),Math.min(to,c.end??to)-from));
}
// Sequence alignment uses recognised words as timing anchors, never invents an AI confidence score.
// Unknown/replaced words are explicitly estimated; line boundaries and supplied spelling are retained.
export function alignLyrics(lines,recognized,duration) {
  const tokens=lines.flatMap((line,row)=>wordsOf(line).map(word=>({word,row})));
  const n=tokens.length,m=recognized.length;
  if(!n || n>2000 || !m || m>5000 || !Number.isFinite(duration) || duration<=0)throw new Error('Không đủ mốc âm thanh để căn lời, hoặc đoạn lời quá dài. Hãy chọn đoạn ngắn hơn.');
  const keys=tokens.map(t=>clean(t.word)),rkeys=recognized.map(w=>clean(w.word));
  const alt=tokens.map(t=>loose(t.word)),ralt=recognized.map(w=>loose(w.word));
  const trace=new Uint8Array((n+1)*(m+1));let prev=new Float32Array(m+1),curr=new Float32Array(m+1);
  for(let j=1;j<=m;j++){prev[j]=-j;trace[j]=2;}
  for(let i=1;i<=n;i++) {
    curr[0]=-i;trace[i*(m+1)]=1;
    for(let j=1;j<=m;j++) {
      const same=keys[i-1] && keys[i-1]===rkeys[j-1],near=alt[i-1] && alt[i-1]===ralt[j-1];
      const diag=prev[j-1]+(same?3:near?2:-1.5),up=prev[j]-1,left=curr[j-1]-1;
      curr[j]=Math.max(diag,up,left);trace[i*(m+1)+j]=diag>=up && diag>=left?0:up>=left?1:2;
    }
    [prev,curr]=[curr,prev];
  }
  const map=Array(n).fill(-1);let i=n,j=m;
  while(i||j){const d=trace[i*(m+1)+j];if(i&&j&&d===0){map[--i]=--j;}else if(i&&(d===1||!j))i--;else j--;}
  let matched=0;
  const words=tokens.map((t,k)=>{
    const r=recognized[map[k]];
    const same=r && alt[k] && alt[k]===ralt[map[k]];
    if(same)matched++;
    return {...t,start:r?.start,end:r?.end,estimated:!same || !!r?.estimated};
  });
  if(!matched)throw new Error('Lời nhập chưa khớp âm thanh. Hãy chỉ nhập lời thuộc đúng đoạn đang chọn, hoặc dùng file SRT/LRC có mốc.');
  for(let k=0;k<n;) {
    if(Number.isFinite(words[k].start)){k++;continue;}
    const a=k;while(k<n&&!Number.isFinite(words[k].start))k++;
    let lo=a,hi=k,start=a?words[a-1].end:0,end=k<n?words[k].start:duration;
    // Borrow the adjacent anchor intervals when a missed syllable has no silent gap.
    if(end-start<(hi-lo)*.02){if(a){lo=a-1;start=words[lo].start;}if(k<n){hi=k+1;end=words[k].end;}}
    const parts=distributeWords(words.slice(lo,hi).map(w=>w.word).join(' '),Math.max(.002*(hi-lo),end-start));
    for(let x=lo;x<hi;x++)Object.assign(words[x],{start:ms(start+parts[x-lo].start),end:ms(Math.min(duration,start+parts[x-lo].end)),estimated:true});
  }
  const cues=lines.map((text,row)=>{
    const part=words.filter(w=>w.row===row);
    return {text:wordsOf(text).join(' '),start:part[0].start,end:part.at(-1).end,words:part,needsReview:part.some(w=>w.estimated),timingSource:'aligned'};
  }).filter(c=>c.words.length);
  return {cues,matched,total:n};
}
