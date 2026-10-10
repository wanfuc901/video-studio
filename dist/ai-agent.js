// AI Agent for Frameflow: proposed edits require explicit approval.
// No API keys or media bytes are persisted or included in project snapshots.
export const AGENT_PROVIDERS = Object.freeze({
  groq: { label: 'Groq · GPT-OSS 120B', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'openai/gpt-oss-120b', key: 'groq' },
  'groq-fast': { label: 'Groq · Llama 8B Instant', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.1-8b-instant', key: 'groq' },
  openrouter: { label: 'OpenRouter · Free', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'openrouter/free', key: 'openrouter' },
  nvidia: { label: 'NVIDIA · Nemotron 3 Super', url: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'nvidia/nemotron-3-super-120b-a12b', key: 'nvidia' }
});
const MAX_ACTIONS = 16;
const TYPES = new Set(['seek', 'add_text', 'move_selected', 'rename_project']);
export function normalizeAgentPlan(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('AI chưa tạo được kế hoạch hợp lệ.');
  const summary = String(raw.summary || raw.explanation || '').slice(0, 1200);
  if (!Array.isArray(raw.actions)) return { summary, actions: [] };
  if (raw.actions.length > MAX_ACTIONS) throw new Error('Kế hoạch quá dài; hãy chia yêu cầu thành các phần nhỏ.');
  const actions = raw.actions.map((action) => {
    if (!action || !TYPES.has(action.type)) throw new Error('AI đề xuất thao tác chưa được hỗ trợ.');
    const type = action.type;
    if (type === 'seek' || type === 'move_selected') {
      const seconds = Number(action.seconds);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86400) throw new Error('Thời điểm không hợp lệ.');
      return { type, seconds: Math.round(seconds * 1000) / 1000 };
    }
    if (type === 'rename_project') {
      const title = String(action.title || '').trim();
      if (!title || title.length > 60) throw new Error('Tên dự án không hợp lệ.');
      return { type, title };
    }
    const text = String(action.text || '').trim();
    const start = Number(action.start), duration = Number(action.duration);
    if (!text || text.length > 2000 || !Number.isFinite(start) || start < 0 || start > 86400 ||
        !Number.isFinite(duration) || duration < 0.2 || duration > 120) throw new Error('Nội dung hoặc mốc của chữ không hợp lệ.');
    return { type, text, start: Math.round(start * 1000) / 1000, duration: Math.round(duration * 1000) / 1000 };
  });
  return { summary, actions };
}
const TOOLS = [{
  type: 'function', function: {
    name: 'propose_timeline_edits',
    description: 'Propose a safe, reviewable sequence of supported Video Studio actions. Do not execute anything; user approves first.',
    parameters: {
      type: 'object', properties: {
        summary: { type: 'string', description: 'Short Vietnamese explanation of planned changes.' },
        actions: { type: 'array', maxItems: MAX_ACTIONS, items: {
          type: 'object', properties: {
            type: { type: 'string', enum: [...TYPES] },
            seconds: { type: 'number' }, start: { type: 'number' },
            duration: { type: 'number' }, text: { type: 'string' }, title: { type: 'string' }
          }, required: ['type']
        }}
      }, required: ['summary', 'actions']
    }
  }
}];
const SYSTEM = `Bạn là AI Agent tích hợp trong ứng dụng dựng video Frameflow Video Studio.
Bạn chỉ được ĐỀ XUẤT những thao tác: seek (tua con trỏ, seconds), add_text (thêm một clip chữ, start/duration/text),
move_selected (dời clip hiện đang chọn đến seconds), rename_project (đổi tên dự án, title).
Dùng công cụ propose_timeline_edits; ứng dụng sẽ bắt người dùng duyệt trước khi áp dụng.
Mốc thời gian là giây tuyệt đối trên timeline. Không suy đoán thời điểm lời hát; nếu chưa có mốc từ audio, hướng dẫn dùng tính năng "Tạo lời bằng AI" để nhận diện rồi căn lời.
Không giả vờ đã nghe video, đã chạy mô hình Whisper hay đã xuất video. Không nhận lệnh xóa media, truy cập Internet, shell hoặc ghi API key.
Không tạo các câu phụ đề khi thiếu nội dung cụ thể. Nếu chỉ hỏi về tính năng, trả lời ngắn gọn bằng tiếng Việt mà không cần gọi công cụ.
Nếu yêu cầu có thao tác hợp lệ, gọi công cụ với mảng actions. Giới hạn 16 thao tác một lượt.`;
function parseMessage(message) {
  const call = message?.tool_calls?.find((item) => item.function?.name === 'propose_timeline_edits');
  if (call) return normalizeAgentPlan(JSON.parse(call.function.arguments));
  const content = typeof message?.content === 'string' ? message.content : '';
  // Models that do not support tools still provide useful advice; never execute unverified JSON.
  return { summary: content.trim().slice(0, 1200) || 'Model chưa tạo được kế hoạch. Hãy diễn đạt yêu cầu cụ thể hơn.', actions: [] };
}
export async function requestAgent({ selection = 'auto', keys, context, instruction, signal, fetcher = fetch }) {
  const order = selection === 'auto' ? ['groq', 'openrouter', 'nvidia'] : [selection];
  const providers = order.filter((id) => AGENT_PROVIDERS[id] && String(keys?.[AGENT_PROVIDERS[id].key] || '').trim());
  if (!providers.length) throw new Error('Hãy nhập API key cho nhà cung cấp đã chọn.');
  const errors = [];
  for (const id of providers) {
    const provider = AGENT_PROVIDERS[id];
    try {
      const response = await fetcher(provider.url, {
        method: 'POST', credentials: 'omit', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + keys[provider.key].trim() },
        body: JSON.stringify({
          model: provider.model, temperature: 0.2, max_tokens: 1600,
          messages: [{ role: 'system', content: SYSTEM },
            { role: 'user', content: JSON.stringify({ request: instruction.slice(0, 3000), project: context }) }],
          tools: TOOLS, tool_choice: 'auto'
        })
      });
      if (!response.ok) {
        const reason = response.status === 429 ? 'hết hạn mức' : response.status === 401 || response.status === 403
          ? 'key không hợp lệ/không có quyền' : 'HTTP ' + response.status;
        throw new Error(reason);
      }
      const data = await response.json();
      const message = data?.choices?.[0]?.message;
      if (!message) throw new Error('API không trả lời đúng định dạng.');
      return { ...parseMessage(message), provider: id };
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw error;
      errors.push(provider.label + ': ' + (error?.message || 'không kết nối được'));
    }
  }
  throw new Error('Không thể dùng API đã chọn. ' + errors.join('; '));
}
export function describeAgentAction(action) {
  if (action.type === 'seek') return 'Tua con trỏ đến ' + action.seconds.toFixed(3) + 's';
  if (action.type === 'move_selected') return 'Dời clip đang chọn đến ' + action.seconds.toFixed(3) + 's';
  if (action.type === 'rename_project') return 'Đổi tên dự án: ' + action.title;
  return 'Thêm chữ tại ' + action.start.toFixed(3) + 's (' + action.duration.toFixed(3) + 's): ' + action.text;
}
export function setupAIAgent({ getContext, applyActions }) {
  const button = document.createElement('button');
  button.className = 'button button-light'; button.type = 'button'; button.textContent = '✦ AI Agent';
  document.querySelector('.top-actions').insertBefore(button, document.getElementById('export-button'));
  const dialog = document.createElement('dialog'); dialog.className = 'agent-dialog';
  dialog.setAttribute('aria-label', 'AI Agent');
  dialog.innerHTML = `<form method="dialog" class="agent-heading"><h2>✦ AI Agent</h2><button aria-label="Đóng" class="icon-button">×</button></form>
    <p>Groq ưu tiên tốc độ · OpenRouter và NVIDIA dự phòng. Chỉ gửi yêu cầu và thông tin clip, không gửi video hoặc âm thanh.</p>
    <label>Model / nhà cung cấp<select id="agent-provider"><option value="auto">Tự động · Groq → OpenRouter → NVIDIA</option>
      <option value="groq">Groq · GPT-OSS 120B</option><option value="groq-fast">Groq · Llama 8B Instant</option>
      <option value="openrouter">OpenRouter · Free</option><option value="nvidia">NVIDIA · Nemotron 3 Super</option></select></label>
    <div class="agent-keys"><label>Groq key<input type="password" id="agent-key-groq" autocomplete="off" placeholder="gsk_..."></label>
      <label>OpenRouter key<input type="password" id="agent-key-openrouter" autocomplete="off" placeholder="sk-or-..."></label>
      <label>NVIDIA key<input type="password" id="agent-key-nvidia" autocomplete="off" placeholder="nvapi-..."></label></div>
    <label>Yêu cầu<textarea id="agent-instruction" rows="3" maxlength="3000" placeholder="Thêm dòng chữ Xin chào tại giây 5, hiển thị 3 giây"></textarea></label>
    <div class="agent-actions"><button id="agent-cancel" type="button" class="button button-ghost" disabled>Dừng</button>
      <button id="agent-request" type="button" class="button button-primary">Lên kế hoạch</button></div>
    <p id="agent-status" role="status"></p><div id="agent-preview" hidden><h3>Xem trước kế hoạch</h3>
      <p id="agent-summary"></p><ol id="agent-steps"></ol><button id="agent-apply" class="button button-primary" type="button">Xác nhận áp dụng</button></div>
    <p class="agent-hint">Key chỉ giữ trong tab, không lưu trong dự án hoặc GitHub. Khi dùng API trực tiếp từ trình duyệt, key vẫn xuất hiện trong Network của chính máy bạn. Trang công khai nên dùng backend proxy.</p>`;
  document.body.append(dialog);
  const css = document.createElement('style'); css.textContent = `
    .agent-dialog{width:min(560px,calc(100vw - 30px));max-height:90vh;overflow:auto;background:#171b23;color:#f3f6fc;border:1px solid #485267;border-radius:16px;padding:22px;box-shadow:0 20px 65px #0009}
    .agent-dialog::backdrop{background:#05070bba}.agent-dialog .agent-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
    .agent-dialog h2,.agent-dialog h3{margin:0 0 10px}.agent-dialog label{display:block;font-size:13px;margin:10px 0}
    .agent-dialog input,.agent-dialog select,.agent-dialog textarea{display:block;box-sizing:border-box;width:100%;padding:10px;margin-top:5px;border:1px solid #4f5667;border-radius:8px;background:#0d1119;color:white}
    .agent-keys{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:9px}.agent-actions{display:flex;justify-content:flex-end;gap:10px;margin-top:12px}
    #agent-status{min-height:1.5em;font-size:13px}#agent-steps{padding-left:24px;line-height:1.55}#agent-preview{border-top:1px solid #394456;padding-top:14px}
    .agent-hint{font-size:12px;color:#a6b4c7}@media(max-width:600px){.agent-keys{grid-template-columns:1fr}}`;
  document.head.append(css);
  const $ = (id) => dialog.querySelector('#' + id);
  let pending = null, controller = null, fingerprint = null;
  const status = (value) => { $('agent-status').textContent = value; };
  function setBusy(busy) {
    $('agent-request').disabled = busy; $('agent-cancel').disabled = !busy;
    $('agent-apply').disabled = busy;
  }
  button.addEventListener('click', () => dialog.showModal());
  $('agent-cancel').addEventListener('click', () => controller?.abort());
  dialog.addEventListener('close', () => { controller?.abort(); pending = null; $('agent-preview').hidden = true;
    for (const field of dialog.querySelectorAll('input[type=password]')) field.value = ''; });
  $('agent-request').addEventListener('click', async () => {
    const instruction = $('agent-instruction').value.trim();
    if (!instruction) { status('Hãy nhập yêu cầu cho agent.'); return; }
    pending = null; $('agent-preview').hidden = true;
    const context = getContext();
    fingerprint = JSON.stringify(context);
    const keys = { groq: $('agent-key-groq').value, openrouter: $('agent-key-openrouter').value,
      nvidia: $('agent-key-nvidia').value };
    controller = new AbortController(); setBusy(true); status('Đang lập kế hoạch…');
    try {
      const result = await requestAgent({ selection: $('agent-provider').value, keys, context, instruction,
        signal: controller.signal });
      pending = result; $('agent-summary').textContent = result.summary;
      $('agent-steps').replaceChildren(...result.actions.map((a) => {
        const li = document.createElement('li'); li.textContent = describeAgentAction(a); return li;
      }));
      $('agent-apply').hidden = result.actions.length === 0;
      $('agent-preview').hidden = false;
      status('Đã dùng ' + AGENT_PROVIDERS[result.provider].label + '. Xem lại trước khi áp dụng.');
    } catch (error) { status(error.name === 'AbortError' ? 'Đã dừng.' : error.message); }
    finally { controller = null; setBusy(false); }
  });
  $('agent-apply').addEventListener('click', () => {
    if (!pending || !pending.actions.length) return;
    if (JSON.stringify(getContext()) !== fingerprint) {
      pending = null; $('agent-preview').hidden = true;
      status('Dự án đã thay đổi. Hãy tạo lại kế hoạch để tránh sửa sai clip.'); return;
    }
    try {
      // Always validate model output a second time immediately before acting.
      const plan = normalizeAgentPlan(pending);
      applyActions(plan.actions);
      pending = null; $('agent-preview').hidden = true;
      status('Đã áp dụng. Có thể nhấn Ctrl+Z để hoàn tác.');
    } catch (error) { status('Chưa áp dụng: ' + error.message); }
  });
}
