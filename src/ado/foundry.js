'use strict';

// Azure AI Foundry (Azure OpenAI v1-compatible endpoint) client.
//
//   POST {FOUNDRY_ENDPOINT}/openai/v1/chat/completions   { model: <deployment>, messages, ... }
//
// Auth: FOUNDRY_API_KEY (local dev) or, on Azure, the App Service managed identity via
// @azure/identity (scope https://cognitiveservices.azure.com/.default). Plain fetch, no SDK,
// so tests can point FOUNDRY_ENDPOINT at a fake server.

const SCOPE = 'https://cognitiveservices.azure.com/.default';
const TIMEOUT_MS = Number(process.env.FOUNDRY_TIMEOUT_MS || 60000);

let credential = null;

class FoundryError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

function isConfigured() {
  return Boolean(process.env.FOUNDRY_ENDPOINT);
}

async function authHeaders() {
  if (process.env.FOUNDRY_API_KEY) return { 'api-key': process.env.FOUNDRY_API_KEY };
  if (!credential) {
    // Lazy: only needed on Azure (managed identity) or with `az login` locally.
    // eslint-disable-next-line global-require
    const { DefaultAzureCredential } = require('@azure/identity');
    credential = new DefaultAzureCredential();
  }
  const token = await credential.getToken(SCOPE);
  return { Authorization: `Bearer ${token.token}` };
}

// One chat-completions call. Returns the raw `choices[0].message`.
async function complete({ deployment, messages, tools, responseFormat, temperature = 0.2, maxTokens = 2000 }) {
  if (!isConfigured()) throw new FoundryError('AI is not configured on the server (FOUNDRY_ENDPOINT)', 503);
  const model = deployment || process.env.FOUNDRY_DEPLOYMENT;
  if (!model) throw new FoundryError('No Foundry deployment configured (ai.deployment / FOUNDRY_DEPLOYMENT)', 503);

  const url = `${process.env.FOUNDRY_ENDPOINT.replace(/\/$/, '')}/openai/v1/chat/completions`;
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (tools && tools.length) body.tools = tools;
  if (responseFormat) body.response_format = responseFormat;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeaders()) },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new FoundryError(err.name === 'AbortError' ? 'AI request timed out' : `AI request failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data.error && data.error.message) || `AI request failed (${res.status})`;
    const e = new FoundryError(msg, res.status === 429 ? 429 : 502);
    e.foundryStatus = res.status;
    throw e;
  }
  const choice = data.choices && data.choices[0];
  if (!choice || !choice.message) throw new FoundryError('AI returned no answer');
  return choice.message;
}

// Plain-text answer.
async function chatReply({ deployment, system, messages }) {
  const msg = await complete({
    deployment,
    messages: [{ role: 'system', content: system }, ...messages],
    temperature: 0.4,
    maxTokens: 1200,
  });
  return String(msg.content || '').trim();
}

// Free-text answer that may call tools first (e.g. read_file). Returns the final text.
async function chatWithTools({ deployment, system, messages, tools = [], maxRounds = 3 }) {
  const convo = [{ role: 'system', content: system }, ...messages];
  const toolDefs = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  for (let round = 0; round <= maxRounds; round++) {
    const lastRound = round === maxRounds;
    const msg = await complete({ deployment, messages: convo, tools: lastRound ? [] : toolDefs, temperature: 0.4, maxTokens: 1500 });
    if (msg.tool_calls && msg.tool_calls.length && !lastRound) {
      convo.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const tool = tools.find((t) => t.name === (call.function && call.function.name));
        let result;
        try {
          result = tool ? await tool.handler(JSON.parse((call.function && call.function.arguments) || '{}')) : 'Unknown tool';
        } catch (err) {
          result = `Error: ${err.message}`;
        }
        convo.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }
      continue;
    }
    return String(msg.content || '').trim();
  }
  throw new FoundryError('AI did not finish');
}

// Tool-using loop that ends in a JSON object matching `schema`.
//   tools: [{ name, description, parameters, handler: async (args) => string }]
// Falls back from json_schema to json_object for deployments without structured outputs.
async function structured({ deployment, system, user, schemaName, schema, tools = [], maxRounds = 4 }) {
  const messages = [{ role: 'system', content: system }, { role: 'user', content: user }];
  const toolDefs = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
  let format = { type: 'json_schema', json_schema: { name: schemaName, strict: true, schema } };

  for (let round = 0; round <= maxRounds; round++) {
    const lastRound = round === maxRounds;
    let msg;
    try {
      msg = await complete({ deployment, messages, tools: lastRound ? [] : toolDefs, responseFormat: format, maxTokens: 4000 });
    } catch (err) {
      if (err.foundryStatus === 400 && format.type === 'json_schema' && /response_format|json_schema/i.test(err.message)) {
        format = { type: 'json_object' };
        messages[0] = { role: 'system', content: `${system}\n\nReply with a single JSON object matching this JSON schema:\n${JSON.stringify(schema)}` };
        round--; // retry this round
        continue;
      }
      throw err;
    }

    if (msg.tool_calls && msg.tool_calls.length && !lastRound) {
      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        const tool = tools.find((t) => t.name === (call.function && call.function.name));
        let result;
        try {
          const args = JSON.parse((call.function && call.function.arguments) || '{}');
          result = tool ? await tool.handler(args) : `Unknown tool ${call.function && call.function.name}`;
        } catch (err) {
          result = `Error: ${err.message}`;
        }
        messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }
      continue;
    }

    const text = String(msg.content || '').trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    try {
      return JSON.parse(text);
    } catch {
      throw new FoundryError('AI returned invalid JSON');
    }
  }
  throw new FoundryError('AI did not finish');
}

module.exports = { isConfigured, complete, chatReply, chatWithTools, structured, FoundryError };
