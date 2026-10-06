/**
 * KBPRO — AI 提供商抽象层
 *  支持三类后端，自动降级：
 *   1. ollama          —— 本地大模型（http://127.0.0.1:11434）
 *   2. openai          —— 任意 OpenAI 兼容接口（含 DeepSeek / 通义 / vLLM / one-api）
 *   3. local           —— 内置抽取式引擎（零依赖，永远可用）
 */
import { loadConfig } from '../config.js';
import { decryptText } from './crypto.js';
import * as local from './localai.js';

const probeCache = new Map();

/* ------------------------------------------------------------------ 配置解析 */

/**
 * 规范化 Ollama 地址。
 *
 * 坑：Ollama 自身使用环境变量 OLLAMA_HOST 表示**服务端监听地址**，
 * 常见取值是 `0.0.0.0`、`127.0.0.1:11434` 或 `:11434`——它们都不是可用的客户端 URL。
 * 因此这里优先读取本项目的专用变量 KBPRO_OLLAMA_URL，并把 OLLAMA_HOST 归一化：
 *   · 0.0.0.0 / :: / 空 → 127.0.0.1
 *   · 缺少协议 → 补 http://
 *   · 缺少端口 → 补 11434
 */
export function normalizeOllamaUrl(raw) {
  let v = String(raw || '').trim();
  if (!v) return 'http://127.0.0.1:11434';

  if (!/^https?:\/\//i.test(v)) {
    // 形如 ":11434" / "0.0.0.0" / "127.0.0.1:11434"
    if (v.startsWith(':')) v = `127.0.0.1${v}`;
    v = `http://${v}`;
  }

  let parsed;
  try { parsed = new URL(v); } catch { return 'http://127.0.0.1:11434'; }

  // 监听地址不能作为连接地址
  if (['0.0.0.0', '::', '[::]', '*'].includes(parsed.hostname)) parsed.hostname = '127.0.0.1';
  if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
  // 仅在 http 且未显式指定端口时补默认端口；https 通常走 443，不强加 11434
  if (!parsed.port && parsed.protocol === 'http:') parsed.port = '11434';

  const basePath = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
  return `${parsed.protocol}//${parsed.hostname}${parsed.port ? ':' + parsed.port : ''}${basePath}`;
}

/**
 * 解析用户/全局的 AI 配置。
 * @param {object} userRow users 表行（可为 null）
 */
export function resolveAiConfig(userRow) {
  const cfg = loadConfig();
  const base = cfg.ai || {};

  let provider = String(userRow?.ai_provider || base.provider || 'auto').toLowerCase();
  let baseUrl = String(userRow?.ai_base_url || base.baseUrl || '').trim();
  let apiKey = '';
  if (userRow?.ai_key_enc) apiKey = decryptText(userRow.ai_key_enc);
  if (!apiKey) apiKey = String(base.apiKey || '');
  let chatModel = String(userRow?.ai_model || base.chatModel || '').trim();
  const embedModel = String(base.embedModel || '').trim();
  const ollamaUrl = normalizeOllamaUrl(process.env.KBPRO_OLLAMA_URL || base.ollamaUrl);

  if (provider === 'auto') {
    if (baseUrl && apiKey) provider = 'openai';
    else if (ollamaUrl) provider = 'ollama';
    else provider = 'local';
  }

  if (provider === 'openai' && !baseUrl) provider = 'local';
  if (provider === 'openai' && !apiKey) provider = 'local';

  if (!baseUrl && provider === 'openai') baseUrl = 'https://api.openai.com/v1';
  if (baseUrl && !/\/v1$|\/chat\/completions$/.test(baseUrl)) {
    // 允许用户填 https://host 或 https://host/v1
    if (!/\/v\d+/.test(baseUrl)) baseUrl = baseUrl.replace(/\/+$/, '') + '/v1';
  }

  return {
    provider,
    baseUrl,
    apiKey,
    chatModel: chatModel || defaultChatModel(provider),
    embedModel: embedModel || defaultEmbedModel(provider),
    ollamaUrl,
    temperature: Number(base.temperature ?? 0.2),
    maxTokens: Number(base.maxTokens ?? 1600),
    timeoutMs: Number(base.timeoutMs ?? 120000)
  };
}

function defaultChatModel(provider) {
  if (provider === 'ollama') return 'qwen2.5:7b';
  if (provider === 'openai') return 'gpt-4o-mini';
  return 'local-extractive';
}

function defaultEmbedModel(provider) {
  if (provider === 'ollama') return '';
  if (provider === 'openai') return 'text-embedding-3-small';
  return '';
}

/* ------------------------------------------------------------------ 探测 */

export async function probeOllama(url = 'http://127.0.0.1:11434', timeoutMs = 2500) {
  const cacheKey = `ollama:${url}`;
  const cached = probeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 15000) return cached.value;
  let value = { ok: false, models: [], error: '' };
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      value = { ok: true, models: (data.models || []).map((m) => m.name), error: '' };
    } else {
      value = { ok: false, models: [], error: `HTTP ${res.status}` };
    }
  } catch (err) {
    value = { ok: false, models: [], error: err.name === 'AbortError' ? '连接超时' : err.message };
  }
  probeCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export async function probeAi(userRow) {
  return probeAiConfig(resolveAiConfig(userRow));
}

/** 用给定配置探测可用性（不落库，供「测试连接」按未保存的表单值验证） */
export async function probeAiConfig(conf) {
  if (!conf) {
    return { provider: 'local', requested: 'local', available: true, models: ['local-extractive'], model: 'local-extractive', note: '内置本地引擎' };
  }

  if (conf.provider === 'local') {
    return {
      provider: 'local', requested: 'local', available: true,
      models: ['local-extractive'], model: 'local-extractive',
      note: '内置本地引擎，无需联网即可完成摘要与问答'
    };
  }

  if (conf.provider === 'ollama') {
    const p = await probeOllama(conf.ollamaUrl);
    // 服务不可用或未安装任何模型时，实际生效的是本地抽取式引擎。
    // 这里如实报告「实际生效的提供商」，避免前端误以为大模型已就绪。
    if (!p.ok || !p.models.length) {
      return {
        provider: 'local', requested: 'ollama', available: true,
        models: ['local-extractive'], model: 'local-extractive',
        baseUrl: conf.ollamaUrl,
        note: p.ok
          ? 'Ollama 服务可用但未安装任何模型（可执行 ollama pull <模型名>），当前已降级为内置本地引擎'
          : `Ollama 不可用（${p.error}），当前已降级为内置本地引擎`
      };
    }
    return {
      provider: 'ollama', requested: 'ollama', available: true,
      models: p.models, model: conf.chatModel, baseUrl: conf.ollamaUrl,
      note: `Ollama 本地服务可用（${p.models.length} 个模型）`
    };
  }

  // openai 兼容：做一次极轻量请求验证
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(`${conf.baseUrl}/models`, {
      headers: authHeaders(conf), signal: controller.signal
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
      return {
        provider: 'openai', requested: 'openai', available: true, models,
        model: conf.chatModel, baseUrl: conf.baseUrl, note: 'OpenAI 兼容接口可用'
      };
    }
    return {
      provider: 'local', requested: 'openai', available: false, models: [],
      model: 'local-extractive', baseUrl: conf.baseUrl,
      note: `接口返回 HTTP ${res.status}，当前已降级为内置本地引擎`
    };
  } catch (err) {
    return {
      provider: 'local', requested: 'openai', available: false, models: [],
      model: 'local-extractive', baseUrl: conf.baseUrl,
      note: `连接失败（${err.message}），当前已降级为内置本地引擎`
    };
  }
}

function authHeaders(conf) {
  const h = { 'Content-Type': 'application/json' };
  if (conf.apiKey) h.Authorization = `Bearer ${conf.apiKey}`;
  return h;
}

/* ------------------------------------------------------------------ 对话 */

/**
 * 统一的对话补全。
 * @param {object} p
 * @param {{role:string,content:string}[]} p.messages
 * @param {object} [p.userRow]
 * @param {boolean} [p.stream]
 * @param {(token:string)=>void} [p.onToken]
 * @param {(delta:string)=>void} [p.onDelta]
 * @param {AbortSignal} [p.signal]
 * @param {object} [p.fallback] 本地引擎兜底参数 { question, contexts }
 * @returns {Promise<{content:string, provider:string, model:string, usage:object, fallback:boolean}>}
 */
export async function chatCompletion(p) {
  const conf = resolveAiConfig(p.userRow);
  const provider = p.provider || conf.provider;
  const model = p.model || conf.chatModel;
  const messages = p.messages || [];

  if (provider === 'local') {
    return runLocal(p, 'local', 'local-extractive');
  }

  try {
    if (provider === 'ollama') {
      return await ollamaChat({ ...p, conf, model, messages });
    }
    if (provider === 'openai') {
      return await openaiChat({ ...p, conf, model, messages });
    }
    return runLocal(p, 'local', 'local-extractive');
  } catch (err) {
    if (p.signal?.aborted) throw err;
    const result = runLocal(p, 'local', 'local-extractive');
    result.content = `${result.content}\n\n> ⚠️ 大模型调用失败（${err.message}），已自动降级为本地抽取式引擎。`;
    result.error = err.message;
    return result;
  }
}

function runLocal(p, provider, model) {
  const fallback = p.fallback || {};
  let content = '';
  if (Array.isArray(fallback.contexts)) {
    const r = local.localAnswer(fallback.question || lastUser(p.messages), fallback.contexts);
    content = r.answer;
    p.onToken?.(content);
    return { content, provider, model, citations: r.citations, confidence: r.confidence, usage: {}, fallback: true };
  }
  content = fallback.text ? local.localSummarize(fallback.text).content : '本地引擎未获得可用输入。';
  p.onToken?.(content);
  return { content, provider, model, usage: {}, fallback: true };
}

function lastUser(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

/* ------------------------------------------------------------------ Ollama */

async function ollamaChat({ conf, model, messages, stream, onToken, onDelta, signal, temperature, maxTokens }) {
  const url = `${conf.ollamaUrl.replace(/\/+$/, '')}/api/chat`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conf.timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      stream: !!stream,
      options: {
        temperature: Number(temperature ?? conf.temperature),
        num_predict: Number(maxTokens ?? conf.maxTokens)
      }
    }),
    signal: controller.signal
  });

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    throw new Error(`Ollama HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  if (!stream) {
    const data = await res.json();
    clearTimeout(timer);
    const content = data.message?.content || '';
    return { content, provider: 'ollama', model, usage: { evalCount: data.eval_count, promptEvalCount: data.prompt_eval_count } };
  }

  let content = '';
  await readNdjson(res, (obj) => {
    const piece = obj.message?.content || '';
    if (piece) {
      content += piece;
      onToken?.(piece);
      onDelta?.(piece);
    }
  });
  clearTimeout(timer);
  return { content, provider: 'ollama', model, usage: {} };
}

async function readNdjson(res, onObj) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { onObj(JSON.parse(line)); } catch { /* 忽略脏行 */ }
    }
  }
  const tail = buf.trim();
  if (tail) { try { onObj(JSON.parse(tail)); } catch { /* */ } }
}

/* ------------------------------------------------------------------ OpenAI 兼容 */

async function openaiChat({ conf, model, messages, stream, onToken, onDelta, signal, temperature, maxTokens }) {
  const url = /\/chat\/completions$/.test(conf.baseUrl)
    ? conf.baseUrl
    : `${conf.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conf.timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(conf),
    body: JSON.stringify({
      model,
      messages,
      stream: !!stream,
      temperature: Number(temperature ?? conf.temperature),
      max_tokens: Number(maxTokens ?? conf.maxTokens)
    }),
    signal: controller.signal
  });

  if (!res.ok) {
    clearTimeout(timer);
    const text = await res.text().catch(() => '');
    throw new Error(`接口 HTTP ${res.status} ${text.slice(0, 200)}`);
  }

  if (!stream) {
    const data = await res.json();
    clearTimeout(timer);
    const content = data.choices?.[0]?.message?.content || '';
    return { content, provider: 'openai', model, usage: data.usage || {} };
  }

  let content = '';
  await readSse(res, (data) => {
    if (data === '[DONE]') return;
    let obj;
    try { obj = JSON.parse(data); } catch { return; }
    const piece = obj.choices?.[0]?.delta?.content || obj.choices?.[0]?.message?.content || '';
    if (piece) {
      content += piece;
      onToken?.(piece);
      onDelta?.(piece);
    }
  });
  clearTimeout(timer);
  return { content, provider: 'openai', model, usage: {} };
}

async function readSse(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, '');
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      onData(line.slice(5).trim());
    }
  }
}

/* ------------------------------------------------------------------ 向量化 */

/**
 * 批量生成嵌入。失败或未配置时回退到本地哈希向量。
 * @returns {Promise<{vectors:Float32Array[], model:string, provider:string}>}
 */
export async function embedTexts(texts, userRow) {
  const conf = resolveAiConfig(userRow);
  const list = texts.map((t) => String(t ?? '').slice(0, 8000));
  if (!list.length) return { vectors: [], model: '', provider: 'local' };

  if (conf.provider === 'ollama' && conf.embedModel) {
    try {
      const out = [];
      for (const text of list) {
        const res = await fetch(`${conf.ollamaUrl.replace(/\/+$/, '')}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: conf.embedModel, prompt: text })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data.embedding)) throw new Error('返回格式异常');
        out.push(Float32Array.from(data.embedding));
      }
      return { vectors: out, model: conf.embedModel, provider: 'ollama' };
    } catch {
      /* 降级 */
    }
  }

  if (conf.provider === 'openai' && conf.embedModel) {
    try {
      const res = await fetch(`${conf.baseUrl.replace(/\/+$/, '')}/embeddings`, {
        method: 'POST',
        headers: authHeaders(conf),
        body: JSON.stringify({ model: conf.embedModel, input: list })
      });
      if (res.ok) {
        const data = await res.json();
        const vecs = (data.data || []).map((d) => Float32Array.from(d.embedding));
        if (vecs.length === list.length) return { vectors: vecs, model: conf.embedModel, provider: 'openai' };
      }
    } catch {
      /* 降级 */
    }
  }

  return { vectors: null, model: 'local-hash-512', provider: 'local' };
}

export { local };
