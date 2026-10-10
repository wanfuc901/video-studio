// Shared deterministic renderer: preview and exported frames use the same clock and layout.
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const ms = n => Math.round(n * 1000) / 1000;
export const wordsOf = text => text.match(/\S+/gu) || [];
export function distributeWords(text, duration = 4) {
  const words = wordsOf(text);
  duration = Math.max(duration, words.length * 0.002);
  const weight = words.reduce((sum, word) => sum + Array.from(word).length, 0) || 1;
  let cursor = 0;
  return words.map(word => {
    const start = cursor;
    cursor += (duration - words.length * 0.001) * Array.from(word).length / weight + 0.001;
    return { word, start: ms(start), end: ms(cursor) };
  });
}
export function createTextClip(start, id) {
  const text = 'Nhập lời bài hát của bạn';
  return { id, track: 'text', start, sourceStart: 0, duration: 5, muted: true, volume: 0, text,
    style: { font: 'Arial', size: 68, bold: true, color: '#ffffff', activeColor: '#b9f665',
      outlineColor: '#10121a', outline: 5, x: 50, y: 82, width: 90, align: 'center', opacity: 100, background: false },
    karaoke: { enabled: true, mode: 'sweep', delay: 0.3, speed: 1, sweepDuration: 4, direction: 'ltr',
      words: distributeWords(text), points: [{ time: 0, progress: 0 }, { time: 4, progress: 100 }] } };
}
export function animationTime(clip, timelineTime) {
  return (timelineTime - clip.start + clip.sourceStart - clip.karaoke.delay) * clip.karaoke.speed;
}
export function progressAt(points, time) {
  if (!points.length || time < points[0].time) return 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    if (time <= b.time) return clamp((a.progress + (b.progress - a.progress) * (time - a.time) / (b.time - a.time)) / 100, 0, 1);
  }
  return clamp(points.at(-1).progress / 100, 0, 1);
}
export function progressFor(clip, timelineTime, wordIndex = null) {
  const k = clip.karaoke;
  if (!k.enabled) return 0;
  const time = animationTime(clip, timelineTime);
  if (time < 0) return 0;
  if (k.mode === 'words') {
    const word = k.words[wordIndex];
    return word ? clamp((time - word.start) / (word.end - word.start), 0, 1) : 0;
  }
  return k.mode === 'custom' ? progressAt(k.points, time) : clamp(time / k.sweepDuration, 0, 1);
}
export function animationEnd(clip) {
  const k = clip.karaoke;
  const end = k.mode === 'words' ? (k.words.at(-1)?.end || 0) : k.mode === 'custom' ? k.points.at(-1).time : k.sweepDuration;
  return k.delay + end / k.speed - clip.sourceStart;
}
export function validateWords(words) {
  return words.every((w, i) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.start >= 0 && w.end > w.start && (!i || w.start >= words[i - 1].end));
}
export function validatePoints(points) {
  return points.length >= 2 && points.every((p, i) => Number.isFinite(p.time) && Number.isFinite(p.progress) && p.time >= 0 && p.progress >= 0 && p.progress <= 100 && (!i || (p.time > points[i - 1].time && p.progress >= points[i - 1].progress))) && points[0].progress === 0 && points.at(-1).progress === 100;
}
function layoutText(ctx, text, maxWidth) {
  const lines = [{ tokens: [], width: 0 }];
  let wordIndex = 0;
  for (const part of text.split(/(\n|[^\S\n]+)/u)) {
    if (!part) continue;
    if (part === '\n') { lines.push({ tokens: [], width: 0 }); continue; }
    const whitespace = /^\s+$/u.test(part);
    const value = whitespace ? ' ' : part;
    const index = whitespace ? null : wordIndex++;
    const width = ctx.measureText(value).width;
    let line = lines.at(-1);
    if (line.width + width > maxWidth && line.tokens.length && !whitespace) {
      lines.push({ tokens: [], width: 0 }); line = lines.at(-1);
    }
    if (whitespace && !line.tokens.length) continue;
    line.tokens.push({ text: value, width, wordIndex: index }); line.width += width;
  }
  return lines;
}
export function drawTextClips(ctx, clips, time, width, height) {
  ctx.save(); ctx.scale(width / 1920, height / 1080);
  for (const clip of clips) {
    if (clip.track !== 'text' || time < clip.start || time >= clip.start + clip.duration || !clip.text.trim()) continue;
    const s = clip.style, k = clip.karaoke;
    const maxWidth = 1920 * s.width / 100;
    let size = s.size;
    ctx.save();
    const setFont = () => { ctx.font = `${s.bold ? 700 : 400} ${size}px ${s.font}, sans-serif`; };
    setFont();
    const longest = Math.max(1, ...wordsOf(clip.text).map(w => ctx.measureText(w).width));
    if (longest > maxWidth) { size *= maxWidth / longest; setFont(); }
    let lines = layoutText(ctx, clip.text, maxWidth);
    if (lines.length * size * 1.35 > 970) { size *= 970 / (lines.length * size * 1.35); setFont(); lines = layoutText(ctx, clip.text, maxWidth); }
    const lineHeight = size * 1.35, blockHeight = lines.length * lineHeight;
    const actualWidth = Math.max(0, ...lines.map(l => l.width));
    const centerX = clamp(s.x * 19.2, actualWidth / 2 + 16, 1904 - actualWidth / 2);
    const top = clamp(s.y * 10.8 - blockHeight / 2, 16, 1064 - blockHeight);
    ctx.globalAlpha = s.opacity / 100; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.lineJoin = 'round';
    ctx.lineWidth = s.outline * 2; ctx.strokeStyle = s.outlineColor;
    if (s.background) { ctx.fillStyle = '#080a0dbb'; ctx.fillRect(centerX - actualWidth / 2 - 20, top - 8, actualWidth + 40, blockHeight + 16); }
    const totalWidth = lines.reduce((sum, line) => sum + line.width, 0);
    const target = totalWidth * progressFor(clip, time);
    let advance = 0;
    for (let row = 0; row < lines.length; row++) {
      const line = lines[row];
      let x = centerX - actualWidth / 2 + (s.align === 'center' ? (actualWidth - line.width) / 2 : s.align === 'right' ? actualWidth - line.width : 0);
      const y = top + row * lineHeight + lineHeight / 2;
      for (const token of line.tokens) {
        ctx.fillStyle = s.color;
        if (s.outline > 0) ctx.strokeText(token.text, x, y);
        ctx.fillText(token.text, x, y);
        let progress = k.mode === 'words' ? progressFor(clip, time, token.wordIndex) : clamp((target - advance) / (token.width || 1), 0, 1);
        if (k.mode !== 'words' && k.direction === 'rtl') progress = clamp((target - (totalWidth - advance - token.width)) / (token.width || 1), 0, 1);
        if (k.enabled && progress > 0) {
          ctx.save(); ctx.beginPath();
          ctx.rect(k.direction === 'rtl' ? x + token.width * (1 - progress) : x, y - lineHeight / 2, token.width * progress, lineHeight);
          ctx.clip(); ctx.fillStyle = s.activeColor; ctx.fillText(token.text, x, y); ctx.restore();
        }
        advance += token.width; x += token.width;
      }
    }
    ctx.restore();
  }
  ctx.restore();
}
