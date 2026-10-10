import { createTextClip, ms, wordsOf, distributeWords } from './karaoke.js';
export const SAMPLE_RATE = 16000;
export const MAX_AI_SECONDS = 600;
export function validateRange(start, end, duration, insertAt) {
  if (![start, end, duration, insertAt].every(Number.isFinite) || start < 0 || end <= start || end > duration + .01 || insertAt < 0 || insertAt > 86400) throw new Error('Kiểm tra lại đoạn âm thanh và vị trí chèn lời.');
  if (end - start > MAX_AI_SECONDS) throw new Error('Mỗi lần nhận diện tối đa 10 phút. Hãy chọn một đoạn ngắn hơn.');
}
export function normalizeWords(chunks, duration) {
  const output = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i], words = wordsOf(String(chunk.text || ''));
    const t = chunk.timestamp;
    if (!words.length || !Array.isArray(t) || typeof t[0] !== 'number' || !Number.isFinite(t[0])) continue;
    const start = Math.max(0, t[0], output.at(-1)?.end || 0);
    const nextStart = chunks[i + 1]?.timestamp?.[0];
    const inferred = typeof t[1] !== 'number' || !Number.isFinite(t[1]);
    const end = Math.min(duration, inferred ? (Number.isFinite(nextStart) && nextStart > start ? nextStart : start + .4) : t[1]);
    if (end - start < .002) continue;
    const portions = distributeWords(words.join(' '), end - start);
    for (let j = 0; j < portions.length; j++) {
      const p = portions[j];
      const a = ms(start + p.start), b = ms(Math.min(end, start + p.end));
      if (b > a) output.push({ word:p.word, start:a, end:b, estimated:inferred || words.length > 1 });
    }
  }
  return output;
}
export function groupWords(words, maxWords = 8) {
  const cues = []; let group = [];
  const flush = () => {
    if (!group.length) return;
    cues.push({ text:group.map(w => w.word).join(' '), start:group[0].start, end:group.at(-1).end, words:group }); group=[];
  };
  for (const word of words) {
    if (group.length && (group.length >= maxWords || word.start - group.at(-1).end > .8 || word.end - group[0].start > 6)) flush();
    group.push({...word}); if (/[.!?…]$/u.test(word.word)) flush();
  }
  flush(); return cues;
}
export function updateCueText(cue, text) {
  const words = wordsOf(text);
  const sameCount = words.length === cue.words.length;
  cue.text = words.join(' ');
  cue.words = sameCount ? cue.words.map((w,i)=>({...w,word:words[i]})) : distributeWords(cue.text, cue.end - cue.start).map(w=>({...w,start:ms(cue.start+w.start),end:ms(cue.start+w.end),estimated:true}));
}
export function cuesToClips(cues, insertAt, makeId, style = null) {
  const activeCues = cues.filter(c => c.text.trim());
  return activeCues.map((cue,index) => {
    const clip = createTextClip(ms(insertAt + cue.start), makeId());
    const next = activeCues[index + 1];
    const end = Math.min(cue.end + .12, next?.start ?? Infinity);
    clip.text = cue.text; clip.duration = ms(Math.max(.2, end - cue.start));
    if (style) clip.style = structuredClone(style);
    clip.karaoke.mode='words'; clip.karaoke.delay=0; clip.karaoke.speed=1;
    clip.karaoke.words=cue.words.map(w=>({word:w.word,start:ms(w.start-cue.start),end:ms(w.end-cue.start)}));
    clip.karaoke.sweepDuration=ms(cue.end-cue.start);
    return clip;
  });
}
export function planWindows(duration, coreLength=20, context=3) {
  const windows=[];
  for(let coreStart=0;coreStart<duration;coreStart+=coreLength) {
    const coreEnd=Math.min(duration,coreStart+coreLength);
    windows.push({coreStart,coreEnd,start:Math.max(0,coreStart-context),end:Math.min(duration,coreEnd+context)});
  }
  return windows;
}
