import { createTextClip, distributeWords, wordsOf, animationTime, animationEnd, validateWords, validatePoints, ms, clamp } from './karaoke.js';

export function setupKaraoke({ state, elements, renderAll, renderTimeline, syncPreview, seekTo, startPlayback, pausePlayback, showToast, getSelectedClip, recordEdit, revealClip, duplicateSelectedClip }) {
  const $ = id => document.getElementById(id);
  const field = (id, label, min, max, step, value = '') => `<label>${label}<input id="${id}" type="number" min="${min}" max="${max}" step="${step}" value="${value}"></label>`;
  document.querySelector('.edit-actions').insertAdjacentHTML('afterbegin', '<button id="add-text" class="toolbar-button text-action" title="Thêm chữ tại con trỏ">T+ <span>Thêm chữ</span></button>');
  document.querySelector('.library-title').insertAdjacentHTML('beforebegin', '<button id="add-karaoke" class="karaoke-add"><span class="text-glyph">T</span><span><strong>Chữ & lời karaoke</strong><small>Thêm lời · căn nhịp · chạy màu</small></span><b>+</b></button>');
  $('add-karaoke').insertAdjacentHTML('afterend', '<div id="lyrics-list" class="lyrics-list" aria-label="Các câu chữ trong dự án"></div>');
  $('audio-track').insertAdjacentHTML('afterend', '<div id="text-track" class="track"><div class="track-label"><b class="text-glyph">T</b><span>Chữ / karaoke</span></div><div class="track-content" data-track="text"></div></div>');
  elements['text-track'] = $('text-track');
  $('stage').insertAdjacentHTML('beforeend', '<canvas id="text-overlay" width="1920" height="1080" aria-label="Lớp chữ karaoke xem trước"></canvas>');
  elements['text-overlay'] = $('text-overlay');
  document.querySelector('.transport').insertAdjacentHTML('afterend', `<div class="precise-transport"><span>Căn lời</span><button id="frame-back" title="Lùi 10 ms">−10 ms</button><input id="precise-time" type="number" aria-label="Vị trí con trỏ (giây)" min="0" step="0.001" value="0.000"><span>s</span><button id="frame-next" title="Tiến 10 ms">+10 ms</button><select id="preview-speed" aria-label="Tốc độ nghe thử"><option value="1">Nghe 1×</option><option value="0.75">Nghe 0.75×</option><option value="0.5">Nghe 0.5×</option></select></div>`);
  const panel = document.createElement('div'); panel.id = 'text-properties'; panel.hidden = true; panel.className = 'text-properties';
  panel.innerHTML = `<p class="property-wheel-tip">Cuộn để di chuyển bảng · Alt + cuộn ô số để chỉnh. Chọn độ nhạy trên timeline; Rất thấp = 1 ms với mốc thời gian.</p><section class="text-section"><div class="property-heading"><span>CHỮ & LỜI KARAOKE</span><span class="karaoke-badge">NÂNG CAO</span></div>
    <label>Nội dung<textarea id="text-content" rows="3" maxlength="2000" placeholder="Nhập lời bài hát…"></textarea></label>
    <div class="text-buttons"><button id="duplicate-text">Nhân đôi câu</button><button id="preview-text">▶ Nghe thử câu</button><label class="check-inline"><input type="checkbox" id="loop-text"> Lặp</label></div>
    <div class="input-grid">${field('text-start','Hiện từ (giây)',0,86400,0.001)}${field('text-end','Ẩn tại (giây)',0,86400,0.001)}</div>
    ${field('text-duration','Thời lượng hiển thị (giây)',0.2,7200,0.001)}
    <p id="text-source-note" class="input-hint"></p>
  </section>
  <section class="text-section"><div class="property-heading"><span>Màu chạy theo lời</span><label class="check-inline"><input id="karaoke-enabled" type="checkbox"> Bật</label></div>
    <div id="karaoke-settings"><label>Cách chạy màu<select id="karaoke-mode"><option value="sweep">Chạy đều cả câu</option><option value="words">Căn từng từ / tiếng</option><option value="custom">Mốc tốc độ tùy chỉnh</option></select></label>
    <div class="input-grid">${field('karaoke-delay','Bắt đầu chạy sau (s)',0,7200,0.001)}${field('karaoke-speed','Tốc độ màu (×)',0.05,10,0.01)}</div>
    <div id="sweep-settings">${field('sweep-duration','Thời gian chạy ở 1× (s)',0.01,7200,0.001)}<div class="preset-buttons"><button data-speed="0.5">0.5×</button><button data-speed="1">1×</button><button data-speed="1.5">1.5×</button><button data-speed="2">2×</button></div></div>
    <label>Hướng tô màu<select id="karaoke-direction"><option value="ltr">Trái → phải</option><option value="rtl">Phải → trái</option></select></label>
    <p id="karaoke-summary" class="timing-summary"></p><p id="karaoke-warning" class="timing-warning" role="status"></p>
    <div id="word-settings" hidden><div class="section-subtitle"><strong>Mốc từng từ / tiếng</strong><button id="distribute-words">Chia tự động</button></div><p class="input-hint">Mốc giây ở tốc độ 1×, tính từ lúc bắt đầu chạy màu. Có thể để khoảng nghỉ giữa các từ. Nút ◎ lấy thời gian tại con trỏ, có tính tốc độ màu.</p><div class="timing-table-head"><span>Từ</span><span>Bắt đầu</span><span>Kết thúc</span></div><div id="word-rows" class="timing-rows"></div></div>
    <div id="point-settings" hidden><div class="section-subtitle"><strong>Đường chạy màu</strong><button id="add-point">+ Mốc</button></div><p class="input-hint">Thời gian ở 1× · % chữ đã tô. Hai mốc cùng % tạo đoạn dừng/ngân. Các mốc tăng từ 0% tới 100%.</p><svg id="curve-preview" viewBox="0 0 280 88" role="img" aria-label="Đường tiến độ màu theo thời gian"></svg><div class="timing-table-head points-head"><span>Giây</span><span>% đã tô</span><span></span></div><div id="point-rows" class="timing-rows"></div></div>
    </div>
  </section>
  <details class="text-section" open><summary>Kiểu chữ & vị trí</summary>
    <div class="input-grid"><label>Màu chữ<input type="color" id="text-color"></label><label>Màu karaoke<input type="color" id="text-active-color"></label></div>
    <div class="input-grid"><label>Phông chữ<select id="text-font"><option value="Arial">Arial</option><option value="Verdana">Verdana</option><option value="Georgia">Georgia</option><option value="Tahoma">Tahoma</option></select></label>${field('text-size','Cỡ chữ (khung 1080p)',18,180,1)}</div>
    <div class="input-grid"><label>Màu viền<input type="color" id="text-outline-color"></label>${field('text-outline','Độ dày viền',0,16,0.5)}</div>
    <div class="input-grid">${field('text-x','Vị trí ngang (%)',0,100,0.1)}${field('text-y','Vị trí dọc (%)',0,100,0.1)}</div>
    <div class="input-grid">${field('text-width','Rộng tối đa (%)',20,95,1)}${field('text-opacity','Độ hiện rõ (%)',0,100,1)}</div>
    <label>Căn chữ<select id="text-align"><option value="left">Trái</option><option value="center">Giữa</option><option value="right">Phải</option></select></label>
    <div class="text-buttons"><label class="check-inline"><input id="text-bold" type="checkbox"> In đậm</label><label class="check-inline"><input id="text-background" type="checkbox"> Nền tối</label></div>
  </details><p class="input-hint">Màu bám theo thời gian video khi phát, tua và xuất. Tốc độ nghe thử chỉ giúp căn lời, không đổi video xuất. Lời đang lưu trong phiên này.</p>`;
  $('delete-inspector').before(panel);
  elements['text-properties'] = panel;
  const mediaTiming = $('clip-start').closest('.property-section');
  state.previewSpeed = 1; state.loopTextId = null;
  const selected = () => { const c = getSelectedClip(); return c?.track === 'text' ? c : null; };
  function addText() {
    if (state.exporting) return;
    pausePlayback();
    const clip = createTextClip(ms(state.playhead), crypto.randomUUID());
    state.clips.push(clip); state.selectedId = clip.id; renderAll();
    revealClip(clip);
    elements['timeline-scroll'].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    $('text-content').focus({ preventScroll: true }); $('text-content').select();
    showToast('Đã thêm chữ tại ' + clip.start.toFixed(3) + 's — clip xanh trên track Chữ / karaoke.');
  }
  $('add-text').onclick = addText; $('add-karaoke').onclick = addText;
  $('frame-back').onclick = () => seekTo(state.playhead - 0.01);
  $('frame-next').onclick = () => seekTo(state.playhead + 0.01);
  $('precise-time').onchange = e => { const n = Number(e.target.value); if (Number.isFinite(n)) seekTo(n); };
  $('preview-speed').onchange = e => { state.previewSpeed = Number(e.target.value); syncPreview(); };
  $('duplicate-text').onclick = duplicateSelectedClip;
  $('preview-text').onclick = () => {
    const c = selected(); if (!c) return;
    pausePlayback(); seekTo(c.start); state.loopTextId = $('loop-text').checked ? c.id : null; startPlayback();
  };
  $('loop-text').onchange = e => { state.loopTextId = e.target.checked ? selected()?.id : null; };
  $('text-content').oninput = e => {
    const c = selected(); if (!c) return;
    c.text = e.target.value;
    const words = wordsOf(c.text);
    if (words.join('\u0000') !== c.karaoke.words.map(w => w.word).join('\u0000')) {
      // Preserve edited timestamps when only a word is corrected; redistribute only when count changes.
      c.karaoke.words = words.length === c.karaoke.words.length ? c.karaoke.words.map((w, i) => ({ ...w, word: words[i] })) : distributeWords(c.text, c.karaoke.sweepDuration);
    }
    recordEdit(`text:${c.id}`);
    elements['selected-name'].textContent = c.text || 'Chữ trống'; renderTimeline(); syncPreview(); renderRows(c); renderSummary(c);
  };
  for (const id of ['text-start', 'text-end', 'text-duration']) $(id).onchange = e => {
    const c = selected(); if (!c) return;
    const value = Number(e.target.value);
    const duration = id === 'text-end' ? value - c.start : id === 'text-duration' ? value : c.duration;
    if (!e.target.value.trim() || !Number.isFinite(value) || value < 0 || duration < 0.2 || duration + c.sourceStart > 7200 || (id === 'text-start' && value > 86400)) { showToast('Thời lượng phải từ 0.2 giây và nằm trong giới hạn 2 giờ.'); renderAll(); return; }
    if (id === 'text-start') c.start = ms(value); else c.duration = ms(duration);
    renderAll(); revealClip(c);
  };
  const properties = {
    'karaoke-enabled': ['karaoke','enabled'], 'karaoke-mode': ['karaoke','mode'], 'karaoke-delay': ['karaoke','delay'],
    'karaoke-speed': ['karaoke','speed'], 'sweep-duration': ['karaoke','sweepDuration'], 'karaoke-direction': ['karaoke','direction'],
    'text-color': ['style','color'], 'text-active-color': ['style','activeColor'], 'text-outline-color': ['style','outlineColor'],
    'text-font': ['style','font'], 'text-size': ['style','size'], 'text-outline': ['style','outline'], 'text-x': ['style','x'],
    'text-y': ['style','y'], 'text-width': ['style','width'], 'text-opacity': ['style','opacity'], 'text-align': ['style','align'],
    'text-bold': ['style','bold'], 'text-background': ['style','background']
  };
  for (const [id, [group, key]] of Object.entries(properties)) $(id).addEventListener('change', e => {
    const c = selected(); if (!c) return;
    const el = e.target;
    if (el.type === 'number' && (!el.value.trim() || !Number.isFinite(Number(el.value)) || !el.checkValidity())) { showToast('Giá trị chưa hợp lệ. Hãy kiểm tra giới hạn của ô nhập.'); renderAll(); return; }
    c[group][key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    renderAll();
  });
  panel.querySelectorAll('[data-speed]').forEach(b => b.onclick = () => { const c = selected(); if (c) { c.karaoke.speed = Number(b.dataset.speed); renderAll(); } });
  $('distribute-words').onclick = () => { const c = selected(); if (c) { c.karaoke.words = distributeWords(c.text, c.karaoke.sweepDuration); renderAll(); } };
  $('add-point').onclick = () => {
    const c = selected(); if (!c) return;
    const points = c.karaoke.points;
    let time = ms(animationTime(c, state.playhead));
    let i = points.findIndex((p, n) => n > 0 && p.time > time && points[n - 1].time < time);
    if (i < 1) { i = points.length - 1; time = ms((points[i - 1].time + points[i].time) / 2); }
    if (time <= points[i - 1].time || time >= points[i].time) { showToast('Các mốc quá sát nhau; hãy tăng khoảng thời gian.'); return; }
    const a = points[i - 1], b = points[i];
    points.splice(i, 0, { time, progress: ms(a.progress + (b.progress - a.progress) * (time - a.time) / (b.time - a.time)) });
    renderAll();
  };
  function numberCell(value, label, onChange, { min = 0, max = 7200, step = 0.001 } = {}) {
    const input = document.createElement('input'); input.type = 'number'; input.value = String(value); input.min = String(min); input.max = String(max); input.step = String(step); input.ariaLabel = label;
    input.onchange = () => { if (input.value.trim() && input.checkValidity()) onChange(Number(input.value)); else { showToast('Mốc thời gian không hợp lệ.'); renderAll(); } };
    return input;
  }
  function renderRows(c) {
    $('word-settings').hidden = c.karaoke.mode !== 'words'; $('point-settings').hidden = c.karaoke.mode !== 'custom'; $('sweep-settings').hidden = c.karaoke.mode !== 'sweep';
    $('word-rows').replaceChildren(); $('point-rows').replaceChildren();
    if (c.karaoke.mode === 'words') c.karaoke.words.forEach((word, index) => {
      const row = document.createElement('div'); row.className = 'word-row';
      const label = document.createElement('span'); label.textContent = `${index + 1}. ${word.word}`; label.title = word.word; row.append(label);
      for (const key of ['start', 'end']) {
        const update = value => {
          const next = structuredClone(c.karaoke.words); next[index][key] = ms(value);
          if (!validateWords(next)) { showToast('Mốc từ phải tăng dần, không chồng nhau; kết thúc phải sau bắt đầu.'); renderAll(); return; }
          c.karaoke.words = next; renderAll();
        };
        const cell = document.createElement('div'); cell.className = 'timing-cell';
        const input = numberCell(word[key], `${word.word}: ${key === 'start' ? 'bắt đầu' : 'kết thúc'}`, update);
        input.dataset.wheelKey = `word:${index}:${key}`;
        const stamp = document.createElement('button'); stamp.textContent = '◎'; stamp.title = 'Lấy mốc tại con trỏ'; stamp.ariaLabel = `Lấy mốc ${key === 'start' ? 'bắt đầu' : 'kết thúc'} cho ${word.word}`;
        stamp.onclick = () => update(Math.max(0, animationTime(c, state.playhead)));
        cell.append(input, stamp); row.append(cell);
      }
      $('word-rows').append(row);
    });
    if (c.karaoke.mode === 'custom') {
      c.karaoke.points.forEach((point, index) => {
        const row = document.createElement('div'); row.className = 'point-row';
        for (const key of ['time', 'progress']) {
          const update = value => {
            const next = structuredClone(c.karaoke.points); next[index][key] = ms(value);
            if (!validatePoints(next)) { showToast('Thời gian phải tăng dần; % không giảm, bắt đầu 0% và kết thúc 100%.'); renderAll(); return; }
            c.karaoke.points = next; renderAll();
          };
          const input = numberCell(point[key], `Mốc ${index + 1}: ${key === 'time' ? 'giây' : '% màu'}`, update, { max: key === 'time' ? 7200 : 100, step: 0.001 });
          input.dataset.wheelKey = `point:${index}:${key}`;
          if (key === 'progress' && (index === 0 || index === c.karaoke.points.length - 1)) input.disabled = true;
          row.append(input);
        }
        const remove = document.createElement('button'); remove.textContent = '×'; remove.ariaLabel = `Xóa mốc ${index + 1}`; remove.disabled = index === 0 || index === c.karaoke.points.length - 1;
        remove.onclick = () => { c.karaoke.points.splice(index, 1); renderAll(); }; row.append(remove); $('point-rows').append(row);
      });
      const end = c.karaoke.points.at(-1).time || 1;
      const coords = c.karaoke.points.map(p => `${8 + p.time / end * 264},${80 - p.progress * 0.72}`).join(' ');
      $('curve-preview').innerHTML = `<path d="M8 8V80H272" fill="none" stroke="#454b58"/><path d="M8 44H272" stroke="#303641" stroke-dasharray="3 5"/><polyline points="${coords}" fill="none" stroke="#b9f665" stroke-width="2"/>`;
    }
  }
  function renderSummary(c) {
    const end = animationEnd(c), absoluteEnd = c.start + end;
    $('karaoke-summary').textContent = `Tô xong tại ${Math.max(0, absoluteEnd).toFixed(3)}s trên video · ${c.karaoke.speed}× · hiển thị ${c.duration.toFixed(3)}s`;
    const warning = end > c.duration + 0.001 ? `Câu bị ẩn trước khi tô xong ${ms(end - c.duration)}s. Tăng thời lượng hiển thị hoặc tốc độ màu.` : end <= 0 ? 'Đoạn này nằm sau thời điểm tô xong nên chữ đã được tô toàn bộ.' : '';
    $('karaoke-warning').textContent = warning; $('karaoke-warning').hidden = !warning;
  }
  return {
    addText,
    renderList() {
      const list = $('lyrics-list'); list.replaceChildren();
      for (const c of state.clips.filter(c => c.track === 'text').sort((a, b) => a.start - b.start)) {
        const button = document.createElement('button'); button.className = c.id === state.selectedId ? 'active' : '';
        const title = document.createElement('strong'); title.textContent = c.text || 'Chữ trống';
        const timing = document.createElement('small'); timing.textContent = `${c.start.toFixed(3)} → ${(c.start + c.duration).toFixed(3)}s`;
        button.append(title, timing); button.onclick = () => { state.selectedId = c.id; seekTo(c.start); renderAll(); revealClip(c); elements['timeline-scroll'].focus({ preventScroll: true }); };
        list.append(button);
      }
    },
    render(clip) {
      const isText = clip?.track === 'text'; panel.hidden = !isText; mediaTiming.hidden = isText;
      if (!isText) return;
      elements['audio-property'].hidden = true;
      $('text-content').value = clip.text; $('text-start').value = clip.start.toFixed(3); $('text-end').value = ms(clip.start + clip.duration).toFixed(3); $('text-duration').value = clip.duration.toFixed(3);
      $('text-source-note').textContent = clip.sourceStart ? `Đã cắt ${clip.sourceStart.toFixed(3)}s đầu câu. Mốc màu bên dưới vẫn tính từ câu gốc để giữ đồng bộ.` : 'Hiện / ẩn chữ độc lập với thời gian chạy màu. Các mốc nhập chính xác tới 1 ms.';
      $('loop-text').checked = state.loopTextId === clip.id;
      for (const [id, [group, key]] of Object.entries(properties)) { if ($(id).type === 'checkbox') $(id).checked = clip[group][key]; else $(id).value = clip[group][key]; }
      $('karaoke-settings').hidden = !clip.karaoke.enabled; renderRows(clip); renderSummary(clip);
    },
    renderClock() { if (document.activeElement !== $('precise-time')) $('precise-time').value = state.playhead.toFixed(3); },
    loop() {
      const clip = state.clips.find(c => c.id === state.loopTextId);
      if (!state.exporting && clip && state.playhead >= clip.start + clip.duration) { state.playhead = clip.start; return true; }
      return false;
    }
  };
}
