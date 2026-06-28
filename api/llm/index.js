/**
 * Azure Static Web Apps managed function — LLM proxy for the Science Bowl app.
 *
 * Why: the browser app must NOT carry an API key on a public URL. This function
 * holds the provider key(s) in SWA *Application Settings* (env vars), so the
 * kids' laptops never see them. The app calls it same-origin at POST /api/llm.
 *
 * Returns an Anthropic-shaped { content:[{type:'text',text}], usage:{...} } for
 * every provider so the client treats all responses uniformly.
 *
 * Settings to configure in the Azure portal (Static Web App → Configuration):
 *   ANTHROPIC_API_KEY   (and/or GOOGLE_API_KEY / OPENAI_API_KEY)
 *   APP_TOKEN           (optional shared gate; set matching proxyToken in the app)
 *
 * No npm dependencies — uses Node 18+ global fetch.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const GOOGLE_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_OUTPUT_TOKENS = 1024; // clamp so a bad request can't run up cost

module.exports = async function (context, req) {
  const reply = (status, obj) => {
    context.res = { status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
  };

  // Optional shared-token gate (defense-in-depth alongside SWA auth).
  if (process.env.APP_TOKEN && (req.headers['x-app-token'] || '') !== process.env.APP_TOKEN) {
    return reply(401, { error: 'unauthorized' });
  }

  let body;
  try {
    body = (req.body && typeof req.body === 'object') ? req.body : JSON.parse(req.body || '{}');
  } catch (_) {
    return reply(400, { error: 'bad json' });
  }

  const { model, system, messages, noSampling, wantsJson } = body;
  if (!model || !Array.isArray(messages)) return reply(400, { error: 'model and messages required' });
  const maxTokens = Math.min(Number(body.maxTokens) || 300, MAX_OUTPUT_TOKENS);

  try {
    let result;
    if (/^claude/i.test(model)) result = await callAnthropic(model, maxTokens, system, messages, noSampling);
    else if (/^gemini/i.test(model)) result = await callGoogle(model, maxTokens, system, messages, wantsJson);
    else if (/^gpt/i.test(model)) result = await callOpenAI(model, maxTokens, system, messages);
    else return reply(400, { error: 'unknown model: ' + model });
    reply(200, result);
  } catch (e) {
    reply(502, { error: String((e && e.message) || e) });
  }
};

async function callAnthropic(model, maxTokens, system, messages, noSampling) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY app setting not configured');
  const reqBody = {
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system || '', cache_control: { type: 'ephemeral' } }],
    messages,
  };
  if (!noSampling) reqBody.temperature = 0; // Opus 4.7+ reject temperature
  const res = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(reqBody),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${(data.error && data.error.message) || res.statusText}`);
  return data; // already { content, usage }
}

async function callGoogle(model, maxTokens, system, messages, wantsJson) {
  if (!process.env.GOOGLE_API_KEY) throw new Error('GOOGLE_API_KEY app setting not configured');
  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
  }));
  const generationConfig = { temperature: 0, maxOutputTokens: maxTokens };
  if (/flash/i.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (wantsJson) generationConfig.responseMimeType = 'application/json';
  const url = `${GOOGLE_BASE}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(process.env.GOOGLE_API_KEY)}`;
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

async function callOpenAI(model, maxTokens, system, messages) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY app setting not configured');
  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model, temperature: 0, max_tokens: maxTokens, messages: [{ role: 'system', content: system || '' }, ...messages] }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`API ${res.status}: ${(data.error && data.error.message) || res.statusText}`);
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
  const u = data.usage || {};
  return { content: [{ type: 'text', text: content }], usage: { input_tokens: u.prompt_tokens, output_tokens: u.completion_tokens } };
}
