import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAgentPlan, requestAgent } from '../dist/ai-agent.js';

test('validates and normalizes safe edit proposals', () => {
  assert.deepEqual(normalizeAgentPlan({ summary: 'ok', actions: [{ type: 'seek', seconds: 1.23456 }] }).actions,
    [{ type: 'seek', seconds: 1.235 }]);
  assert.throws(() => normalizeAgentPlan({ actions: [{ type: 'delete_file' }] }));
  assert.throws(() => normalizeAgentPlan({ actions: [{ type: 'add_text', text: 'x', start: -2, duration: 2 }] }));
});
test('uses authorized Groq key and parses function call without executing tools', async () => {
  let requests = 0;
  const fetcher = async (url, options) => {
    requests++;
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer test-secret');
    const req = JSON.parse(options.body);
    assert.equal(req.model, 'openai/gpt-oss-120b');
    assert.ok(!options.body.includes('data:video'));
    return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [{
      function: { name: 'propose_timeline_edits', arguments: JSON.stringify({
        summary: 'Thêm chữ', actions: [{ type: 'add_text', text: 'Chào bạn', start: 5, duration: 3 }]
      }) }
    }] } }] }) };
  };
  const result = await requestAgent({ selection: 'groq', keys: { groq: 'test-secret' }, instruction: 'Thêm chữ',
    context: { clips: [] }, fetcher });
  assert.equal(requests, 1); assert.equal(result.provider, 'groq');
  assert.equal(result.actions[0].text, 'Chào bạn');
});
test('falls back when primary provider reaches limits', async () => {
  const tried = [];
  const fetcher = async (url) => {
    tried.push(url);
    if (url.includes('groq.com')) return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'Hãy cung cấp thời điểm chính xác.' } }] }) };
  };
  const result = await requestAgent({ selection: 'auto', keys: { groq: 'g', openrouter: 'o' },
    context: {}, instruction: 'help', fetcher });
  assert.equal(tried.length, 2); assert.equal(result.provider, 'openrouter');
  assert.deepEqual(result.actions, []);
});
