/**
 * Cloudflare Worker — LLM proxy for the Science Bowl app.
 *
 * Why: the browser app must NOT carry an API key on a public URL (anyone could
 * read it and spend your credits). This Worker holds the provider key(s) as
 * Worker secrets, so the kids' laptops never see them. The app calls this
 * Worker; the Worker injects the key and forwards to Anthropic / Google / OpenAI.
 *
 * Returns an Anthropic-shaped { content:[{type:'text',text}], usage:{...} } for
 * every provider, so the client treats all responses uniformly.
 *
 * Deploy + secrets: see docs/DEPLOY.md.
 *   wrangler secret put ANTHROPIC_API_KEY   (and/or GOOGLE_API_KEY / OPENAI_API_KEY)
 *   wrangler secret put APP_TOKEN           (optional shared gate)
 *   vars: ALLOWED_ORIGIN = "https://<your-pages-domain>"
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_OUTPUT_TOKENS = 1024; // hard clamp so a bad request can't run up cost

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allow = env.ALLOWED_ORIGIN || '*';
    const okOrigin = allow === '*' || origin === allow;
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? (origin || allow) : allow,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405, cors);

    // Layer 1: lock the Worker to your site's origin.
    if (env.ALLOWED_ORIGIN && origin && origin !== env.ALLOWED_ORIGIN) {
      return json({ error: 'forbidden origin' }, 403, cors);
    }
    // Layer 2: optional shared token (defense-in-depth alongside Cloudflare Access).
    if (env.APP_TOKEN && request.headers.get('X-App-Token') !== env.APP_TOKEN) {
      return json({ error: 'unauthorized' }, 401, cors);
    }

    let body;
    try { body = await request.json(); } catch (_) { return json({ error: 'bad json' }, 400, cors); }
    const { model, system, messages, noSampling, wantsJson } = body;
    if (!model || !Array.isArray(messages)) return json({ error: 'model and messages required' }, 400, cors);
    const maxTokens = Math.min(Number(body.maxTokens) || 300, MAX_OUTPUT_TOKENS);

    try {
      let result;
      if (/^claude/i.test(model)) result = await callAnthropic(env, model, maxTokens, system, messages, noSampling);
      else if (/^gemini/i.test(model)) result = await callGoogle(env, model, maxTokens, system, messages, wantsJson);
      else if (/^gpt/i.test(model)) result = await callOpenAI(env, model, maxTokens, system, messages);
      else return json({ error: 'unknown model: ' + model }, 400, cors);
      return json(result, 200, cors);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, cors);
    }
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', ...cors } });
}

async function callAnthropic(env, model, maxTokens, system, messages, noSampling) {
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY secret not set on the Worker');
  const reqBody = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system || '', cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (!noSampling) reqBody.temperature = 0; // Opus 4.7+ reject temperature
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(reqBody),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${(data.error && data.error.message) || res.statusText}`);
  return data; // already { content, usage }
}

async function callGoogle(env, model, maxTokens, system, messages, wantsJson) {
  if (!env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY secret not set on the Worker');
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }));
  const generationConfig = { temperature: 0, maxOutputTokens: maxTokens };
  if (/flash/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (wantsJson) generationConfig.responseMimeType = 'application/json';
  const url = `${GOOGLE_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GOOGLE_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: system || '' }] }, contents, generationConfig }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${(data.error && data.error.message) || res.statusText}`);
  const text = ((data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [])
    .map((p) => p.text || '').join('');
  const u = data.usageMetadata || {};
  return { content: [{ type: 'text', text }], usage: { input_tokens: u.promptTokenCount, output_tokens: u.candidatesTokenCount } };
}

async function callOpenAI(env, model, maxTokens, system, messages) {
  if (!env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY secret not set on the Worker');
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'system', content: system || '' }, ...messages] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${(data.error && data.error.message) || res.statusText}`);
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  const u = data.usage || {};
  return { content: [{ type: 'text', text: content }], usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } };
}
