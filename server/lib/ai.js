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

/**
 * 上游大模型请求日志。
 * 默认打屏（KBPRO_QUIET=1 时静默），便于确认是否真的请求了 DeepSeek 等接口。
 * 需要绝对安静可用 KBPRO_AI_DEBUG=0 关闭。
 */
function aiLog(...args) {
  if (process.env.KBPRO_AI_DEBUG === '0') return;
  if (process.env.KBPRO_QUIET === '1') return;
  console.log('[kbpro:ai]', ...args);
}

/* ------------------------------------------------------------------ SSRF 防护 */

/**
 * 云厂商元数据端点与服务名。这些地址永远不会是合法的大模型接口，
 * 一旦被访问就可能泄漏实例凭证，因此**无条件拒绝**。
 */
const METADATA_HOSTS = new Set([
  '169.254.169.254',            // AWS / GCP / Azure IMDS
  'fd00:ec2::254',              // AWS IMDS (IPv6)
  '100.100.100.200',            // 阿里云元数据
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
  'metadata.azure.com'
]);

function parseIPv4(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((n) => n > 255)) return null;
  return octets;
}

function classifyIPv4(o) {
  const v = ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
  const inRange = (base, bits) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (v & mask) === (base & mask);
  };
  return {
    loopback: inRange(0x7f000000, 8),
    linkLocal: inRange(0xa9fe0000, 16),
    private: inRange(0x0a000000, 8) || inRange(0xac100000, 12) || inRange(0xc0a80000, 16),
    cgnat: inRange(0x64400000, 10),
    benchmark: inRange(0xc6120000, 15),
    reserved: inRange(0xf0000000, 4),
    multicast: inRange(0xe0000000, 4),
    unspecified: v === 0
  };
}

function classifyIPv6(hostRaw) {
  const h = hostRaw.replace(/^\[|\]$/g, '').toLowerCase();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(h);
  if (mapped) {
    const o = parseIPv4(mapped[1]);
    return o ? classifyIPv4(o) : {};
  }
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return { loopback: true };
  if (h === '::') return { unspecified: true };
  const first = parseInt((h.split(':')[0] || '0'), 16);
  if (Number.isFinite(first)) {
    if ((first & 0xffc0) === 0xfe80) return { linkLocal: true };   // fe80::/10
    if ((first & 0xfe00) === 0xfc00) return { private: true };     // fc00::/7 ULA
    if ((first & 0xff00) === 0xff00) return { multicast: true };   // ff00::/8
  }
  return {};
}

/** 对单个主机名/IP 做分类判定 */
function classifyHost(hostRaw) {
  const host = String(hostRaw || '').replace(/^\[|\]$/g, '').toLowerCase();
  const isIpLiteral = /^[\d.]+$/.test(host) || host.includes(':');
  if (isIpLiteral) {
    const v4 = parseIPv4(host);
    return { host, kind: v4 ? 'ipv4' : 'ipv6', flags: v4 ? classifyIPv4(v4) : classifyIPv6(host) };
  }
  return { host, kind: 'hostname', flags: {} };
}

function describeBlock(flags) {
  if (flags.unspecified) return '目标地址无效（0.0.0.0 / ::）';
  if (flags.linkLocal) return '禁止访问链路本地地址（169.254.0.0/16、fe80::/10，含云元数据服务）';
  if (flags.multicast) return '禁止访问组播地址';
  if (flags.reserved) return '禁止访问保留地址段';
  if (flags.benchmark) return '禁止访问基准测试地址段（198.18.0.0/15）';
  if (flags.loopback) return '当前策略禁止访问回环地址（如需本机推理服务，请在实例设置中开启 ai.allowLoopbackBaseUrl）';
  if (flags.private || flags.cgnat) return '当前策略禁止访问私有网段（如需内网推理服务，请开启 ai.allowPrivateBaseUrl）';
  return '';
}

/**
 * 同步校验：不做 DNS 解析，检查主机字面量。
 * @param {string} rawUrl
 * @param {{allowLoopback?:boolean, allowPrivate?:boolean, allowedHosts?:string[]}} [opts]
 * @returns {{ok:boolean, reason?:string, host?:string}}
 */
export function assertSafeAiBaseUrl(rawUrl, opts = {}) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return { ok: true, host: '' };

  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'Base URL 不是合法的 URL' }; }
  if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: 'Base URL 仅支持 http:// 或 https://' };

  const { host, flags } = classifyHost(u.hostname);

  if (METADATA_HOSTS.has(host)) {
    return { ok: false, reason: '禁止访问云厂商元数据地址（可能导致实例凭证泄漏）' };
  }
  // 链路本地、组播、保留段、未指定地址：无条件拒绝
  if (flags.linkLocal || flags.multicast || flags.reserved || flags.unspecified || flags.benchmark) {
    return { ok: false, reason: describeBlock(flags) };
  }
  if (flags.loopback && opts.allowLoopback === false) {
    return { ok: false, reason: describeBlock(flags) };
  }
  if ((flags.private || flags.cgnat) && opts.allowPrivate === false) {
    return { ok: false, reason: describeBlock(flags) };
  }
  if (Array.isArray(opts.allowedHosts) && opts.allowedHosts.length
    && !opts.allowedHosts.map((h) => String(h).toLowerCase()).includes(host)) {
    return { ok: false, reason: `Base URL 主机 ${host} 不在允许列表中（ai.allowedBaseUrlHosts）` };
  }
  return { ok: true, host };
}

/** 解析结果缓存，避免每次对话都做一次 DNS 查询 */
const dnsVerdictCache = new Map();

/**
 * 异步校验：在同步校验基础上解析域名，防止「域名指向内网/元数据地址」的绕过。
 * @returns {Promise<{ok:boolean, reason?:string, host?:string}>}
 */
export async function assertSafeAiBaseUrlAsync(rawUrl, opts = {}) {
  const basic = assertSafeAiBaseUrl(rawUrl, opts);
  if (!basic.ok) return basic;
  if (!basic.host) return basic;

  const { kind } = classifyHost(basic.host);
  if (kind !== 'hostname') return basic;   // 已是 IP 字面量，同步校验已覆盖

  const cacheKey = `${basic.host}|${opts.allowLoopback === false}|${opts.allowPrivate === false}`;
  const cached = dnsVerdictCache.get(cacheKey);
  if (cached && Date.now() - cached.at < 60000) return cached.verdict;

  let verdict = { ok: true, host: basic.host };
  try {
    const { lookup } = await import('node:dns/promises');
    const records = await lookup(basic.host, { all: true, verbatim: false });
    for (const rec of records || []) {
      const { flags } = classifyHost(rec.address);
      if (flags.linkLocal || flags.multicast || flags.reserved || flags.unspecified || flags.benchmark) {
        verdict = { ok: false, reason: `域名 ${basic.host} 解析到受限地址 ${rec.address}：${describeBlock(flags)}` };
        break;
      }
      if (flags.loopback && opts.allowLoopback === false) {
        verdict = { ok: false, reason: `域名 ${basic.host} 解析到回环地址 ${rec.address}` };
        break;
      }
      if ((flags.private || flags.cgnat) && opts.allowPrivate === false) {
        verdict = { ok: false, reason: `域名 ${basic.host} 解析到私有地址 ${rec.address}` };
        break;
      }
    }
  } catch {
    // DNS 解析失败交由后续 fetch 自行报错，不在此处误判
    verdict = { ok: true, host: basic.host };
  }

  dnsVerdictCache.set(cacheKey, { at: Date.now(), verdict });
  return verdict;
}

/** 从全局配置中取出 SSRF 策略 */
export function baseUrlPolicy() {
  const cfg = loadConfig();
  const ai = cfg.ai || {};
  return {
    allowLoopback: ai.allowLoopbackBaseUrl !== false,
    allowPrivate: ai.allowPrivateBaseUrl !== false,
    allowedHosts: Array.isArray(ai.allowedBaseUrlHosts) ? ai.allowedBaseUrlHosts : []
  };
}

/** 供路由层复用的校验（抛出可读错误） */
export async function requireSafeAiBaseUrl(rawUrl) {
  const verdict = await assertSafeAiBaseUrlAsync(rawUrl, baseUrlPolicy());
  if (!verdict.ok) {
    const err = new Error(verdict.reason || 'Base URL 被安全策略拒绝');
    err.status = 400;
    throw err;
  }
  return verdict;
}

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
  if (baseUrl) {
    // 统一去掉尾部斜杠，避免探测(/models)与对话(/chat/completions)拼出 "//" 导致 404
    baseUrl = baseUrl.replace(/\/+$/, '');
    if (!/\/v\d+$|\/chat\/completions$/.test(baseUrl)) {
      // 允许用户填 https://host 或 https://host/v1
      baseUrl = `${baseUrl}/v1`;
    }
  }

  const resolvedModel = chatModel || defaultChatModel(provider, baseUrl);
  return {
    provider,
    baseUrl,
    apiKey,
    chatModel: resolvedModel,
    // 未配置模型名时不做编造，交由上层明确提示，避免静默回退到本地引擎
    modelMissing: provider === 'openai' && !resolvedModel,
    embedModel: embedModel || defaultEmbedModel(provider, baseUrl),
    ollamaUrl,
    temperature: Number(base.temperature ?? 0.2),
    maxTokens: Number(base.maxTokens ?? 1600),
    timeoutMs: Number(base.timeoutMs ?? 120000),
    // true=始终开启思考；false=从不；null/未设=自动（DeepSeek 思考型模型默认开启）
    thinking: base.thinking === true ? true : (base.thinking === false ? false : null),
    reasoningEffort: String(base.reasoningEffort || '').trim()
  };
}

/**
 * 仅对可确定的厂商给出默认对话模型；未知的 OpenAI 兼容接口不猜测，
 * 否则会把 gpt-4o-mini 发往 DeepSeek 等接口导致报错并静默降级。
 */
function defaultChatModel(provider, baseUrl = '') {
  if (provider === 'ollama') return 'qwen2.5:7b';
  if (provider !== 'openai') return 'local-extractive';
  const u = String(baseUrl || '').toLowerCase();
  if (u.includes('api.openai.com') || u.includes('openai.azure.com')) return 'gpt-4o-mini';
  if (u.includes('deepseek')) return 'deepseek-chat';
  if (u.includes('dashscope') || u.includes('aliyun')) return 'qwen-plus';
  if (u.includes('moonshot')) return 'moonshot-v1-8k';
  if (u.includes('bigmodel') || u.includes('zhipu')) return 'glm-4-flash';
  if (u.includes('volces') || u.includes('volcengine')) return 'doubao-pro-32k';
  return '';
}

/** 嵌入模型同理：仅当能确定厂商提供嵌入接口时才给默认值 */
function defaultEmbedModel(provider, baseUrl = '') {
  if (provider === 'ollama') return '';
  if (provider !== 'openai') return '';
  const u = String(baseUrl || '').toLowerCase();
  if (u.includes('api.openai.com')) return 'text-embedding-3-small';
  if (u.includes('dashscope') || u.includes('aliyun')) return 'text-embedding-v3';
  if (u.includes('bigmodel') || u.includes('zhipu')) return 'embedding-3';
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
    aiLog(`GET ${conf.baseUrl}/models（探测）`);
    const res = await fetch(`${conf.baseUrl}/models`, {
      headers: authHeaders(conf), signal: controller.signal
    });
    clearTimeout(timer);
    aiLog(`← ${res.status} ${conf.baseUrl}/models`);
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const models = (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean);
      let note = 'OpenAI 兼容接口可用';
      if (!conf.chatModel) {
        note = '接口可访问，但未指定对话模型名（如 deepseek-chat），对话时无法调用大模型';
      } else if (models.length && !models.includes(conf.chatModel)) {
        note = `接口可用，但模型「${conf.chatModel}」不在返回的模型列表中，请确认模型名是否正确`;
      }
      return {
        provider: 'openai', requested: 'openai', available: Boolean(conf.chatModel), models,
        model: conf.chatModel || '（未指定）', baseUrl: conf.baseUrl, note
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

  // 跟踪「是否已经向客户端吐出过内容」。流式中断时这个标记决定了能否安全降级：
  // 若已有部分内容送达用户，就不能再把一份完整的本地答案续在后面（会得到前后拼接的乱码）。
  let emitted = false;
  const track = (t) => { if (t) emitted = true; };
  const inner = p.onToken
    ? { ...p, onToken: (t) => { track(t); p.onToken(t); } }
    : { ...p };

  if (provider === 'local') {
    return runLocal(inner, 'local', 'local-extractive');
  }

  try {
    if (provider === 'ollama') {
      return await ollamaChat({ ...inner, conf, model, messages });
    }
    if (provider === 'openai') {
      return await openaiChat({ ...inner, conf, model, messages });
    }
    return runLocal(inner, 'local', 'local-extractive');
  } catch (err) {
    if (p.signal?.aborted) throw err;

    if (emitted) {
      const notice = `\n\n> ⚠️ 生成中断：${err.message}\n> 以上内容不完整，建议重试。`;
      p.onToken?.(notice);
      return {
        content: notice.trim(), provider, model, usage: {},
        fallback: true, error: err.message, interrupted: true
      };
    }

    const result = runLocal(inner, 'local', 'local-extractive');
    if (result.empty) {
      // 没有任何本地兜底素材：如实失败，由调用方决定提示文案，绝不编造内容
      return { content: '', provider, model, usage: {}, fallback: true, error: err.message, empty: true };
    }
    result.content = `${result.content}\n\n> ⚠️ 大模型调用失败（${err.message}），已自动降级为本地抽取式引擎。`;
    result.error = err.message;
    return result;
  }
}

function runLocal(p, provider, model) {
  const fallback = p.fallback || {};

  if (Array.isArray(fallback.contexts) && fallback.contexts.length) {
    const r = local.localAnswer(fallback.question || lastUser(p.messages), fallback.contexts);
    p.onToken?.(r.answer);
    return {
      content: r.answer, provider, model, citations: r.citations,
      confidence: r.confidence, usage: {}, fallback: true
    };
  }

  if (fallback.text) {
    const content = local.localSummarize(fallback.text).content;
    p.onToken?.(content);
    return { content, provider, model, usage: {}, fallback: true };
  }

  // 没有可用的本地兜底素材。绝不能返回「本地引擎未获得可用输入」这类内部占位文案——
  // 它会被当成正常回答呈现给用户。标记为空结果，交给调用方给出恰当的提示。
  return { content: '', provider, model, usage: {}, fallback: true, empty: true };
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

  // 与 OpenAI 路径一致：即便 ollamaUrl 来自全局配置，也做一次安全校验
  const safe = await assertSafeAiBaseUrlAsync(conf.ollamaUrl, baseUrlPolicy());
  if (!safe.ok) throw new Error(safe.reason || 'Ollama 地址被安全策略拒绝');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conf.timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });
  const finish = () => clearTimeout(timer);

  aiLog(`POST ${url} model=${model} stream=${!!stream}（Ollama）`);
  let res;
  try {
    res = await fetch(url, {
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
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status} ${text.slice(0, 200)}`);
    }

    if (!stream) {
      const data = await res.json();
      if (data.error) throw new Error(`Ollama 返回错误：${String(data.error).slice(0, 200)}`);
      return {
        content: data.message?.content || '',
        provider: 'ollama', model,
        usage: { evalCount: data.eval_count, promptEvalCount: data.prompt_eval_count }
      };
    }

    let content = '';
    await readNdjson(res, (obj) => {
      if (obj.error) throw new Error(`Ollama 返回错误：${String(obj.error).slice(0, 200)}`);
      const piece = obj.message?.content || '';
      if (piece) {
        content += piece;
        onToken?.(piece);
        onDelta?.(piece);
      }
    });
    if (!content) throw new Error('Ollama 返回了空内容（未收到任何 token）');
    return { content, provider: 'ollama', model, usage: {} };
  } finally {
    finish();
  }
}

async function readNdjson(res, onObj) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try { onObj(JSON.parse(line)); } catch (e) {
          if (e instanceof SyntaxError) continue;   // 忽略脏行
          throw e;                                  // 业务错误（如 obj.error）向上抛
        }
      }
    }
    const tail = buf.trim();
    if (tail) {
      try { onObj(JSON.parse(tail)); } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
  } catch (err) {
    if (err instanceof SyntaxError) return;
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/* ------------------------------------------------------------------ OpenAI 兼容 */

/** 记录「该上游已拒绝过思考参数」，避免每次请求都白挨一次 400 */
const thinkingUnsupported = new Set();

async function openaiChat({ conf, model, messages, stream, onToken, onDelta, signal, temperature, maxTokens }) {
  const url = /\/chat\/completions$/.test(conf.baseUrl)
    ? conf.baseUrl
    : `${conf.baseUrl.replace(/\/+$/, '')}/chat/completions`;

  // 纵深防御：Base URL 由用户配置，而请求由服务端发出，必须防 SSRF。
  // 即使有人直接改了 config.json，这里也会拦下来并如实降级。
  const safe = await assertSafeAiBaseUrlAsync(conf.baseUrl, baseUrlPolicy());
  if (!safe.ok) throw new Error(safe.reason || 'Base URL 被安全策略拒绝');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), conf.timeoutMs);
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true });

  const finish = () => clearTimeout(timer);

  // 组装请求体；对 DeepSeek 的思考型模型（deepseek-flash / deepseek-reasoner）
  // 按官方协议附加 thinking / reasoning_effort。其它兼容接口默认不发送，避免报错。
  const baseBody = {
    model,
    messages,
    stream: !!stream,
    temperature: Number(temperature ?? conf.temperature),
    max_tokens: Number(maxTokens ?? conf.maxTokens)
  };
  const isDeepSeek = /deepseek/i.test(conf.baseUrl);
  const thinkingModel = /(flash|reasoner|reason)/i.test(String(model));
  const wantsThinking = !thinkingUnsupported.has(conf.baseUrl)
    && (conf.thinking === true || (conf.thinking !== false && isDeepSeek && thinkingModel));
  const buildBody = () => {
    const b = { ...baseBody };
    if (wantsThinking) {
      b.thinking = { type: 'enabled' };
      const effort = conf.reasoningEffort || (thinkingModel ? 'high' : '');
      if (effort) b.reasoning_effort = effort;
    } else if (conf.reasoningEffort) {
      b.reasoning_effort = conf.reasoningEffort;
    }
    return b;
  };

  const send = (payload) => fetch(url, {
    method: 'POST',
    headers: authHeaders(conf),
    body: JSON.stringify(payload),
    signal: controller.signal
  });

  let body = buildBody();
  aiLog(`POST ${url} model=${model} stream=${!!stream} key=${conf.apiKey ? 'set' : 'empty'}${body.thinking ? ' thinking=on' : ''}`);
  let res = await send(body);

  // 有些 OpenAI 兼容网关不认识 thinking / reasoning_effort，会直接 400。
  // 这种情况下自动去掉这两个参数重试一次，而不是让用户白白降级到本地引擎。
  if (!res.ok && res.status === 400 && (body.thinking || body.reasoning_effort)) {
    const text = await res.text().catch(() => '');
    if (/thinking|reasoning_effort|unrecognized|unknown|unsupported|invalid.*argument/i.test(text)) {
      aiLog(`← 400 且疑似不支持思考参数，去掉后重试：${text.slice(0, 140)}`);
      thinkingUnsupported.add(conf.baseUrl);
      body = buildBody();
      if (body.thinking || body.reasoning_effort) {
        delete body.thinking;
        delete body.reasoning_effort;
      }
      res = await send(body);
    } else {
      finish();
      aiLog(`← ${res.status} ${text.slice(0, 200)}`);
      throw new Error(`接口 HTTP ${res.status} ${text.slice(0, 200)}`);
    }
  }

  if (!res.ok) {
    finish();
    const text = await res.text().catch(() => '');
    aiLog(`← ${res.status} ${text.slice(0, 200)}`);
    throw new Error(`接口 HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  aiLog(`← ${res.status} ${url}`);

  const contentType = String(res.headers.get('content-type') || '');
  // 以**实际响应类型**为准，而不是我们请求的类型：部分网关会无视 stream 参数，
  // 两个方向都可能发生（要流式给 JSON、要非流式给 SSE）。
  const isSse = /text\/event-stream/i.test(contentType);
  const isJson = /application\/json/i.test(contentType);
  const parseAsStream = isSse || (!isJson && !!stream);

  if (!parseAsStream) {
    try {
      const data = await res.json();
      if (data.error) throw new Error(`上游返回错误：${data.error.message || JSON.stringify(data.error).slice(0, 160)}`);
      const content = data.choices?.[0]?.message?.content || '';
      // 调用方要的是流式、但上游给了整包 JSON：把内容整体补发一次，避免前端空白
      if (content && onToken) { onToken(content); onDelta?.(content); }
      return { content, provider: 'openai', model, usage: data.usage || {} };
    } finally {
      finish();
    }
  }

  let content = '';
  try {
    await readSse(res, (data) => {
      if (data === '[DONE]') return;
      let obj;
      try { obj = JSON.parse(data); } catch { return; }
      // 上游可能在流中间回吐 error 负载。绝不能忽略它，否则半截回答会被当成完整答案。
      if (obj.error) {
        const e = new Error(`上游返回错误：${obj.error.message || JSON.stringify(obj.error).slice(0, 160)}`);
        e.upstreamError = true;
        throw e;
      }
      const choice = obj.choices?.[0] || {};
      const piece = choice.delta?.content || choice.message?.content || '';
      if (piece) {
        content += piece;
        onToken?.(piece);
        onDelta?.(piece);
      }
    });
  } finally {
    finish();
  }

  // 流结束但一个字都没有，且没有任何错误信号：如实报告，避免「空回答」
  if (!content) {
    throw new Error('上游返回了空内容（未收到任何 token）');
  }
  return { content, provider: 'openai', model, usage: {} };
}

async function readSse(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  try {
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
  } catch (err) {
    // 回调内部抛出的业务错误（如上游 error 负载）原样上抛，不要伪装成连接中断
    if (err?.upstreamError) throw err;
    throw new Error(`连接中断：${err?.message || err}`);
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
  aiLog(`embedTexts provider=${conf.provider} embedModel=${conf.embedModel || '（无，使用内置哈希向量）'}`);

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
