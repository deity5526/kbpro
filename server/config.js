/**
 * KBPRO — 全局配置
 * 所有可调参数集中在此；支持 data/config.json 覆盖（个人中心可写）。
 */
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

export const ROOT = path.resolve(__dirname, '..');
export const WEB_DIR = path.join(ROOT, 'web');
export const DATA_DIR = process.env.KBPRO_DATA ? path.resolve(process.env.KBPRO_DATA) : path.join(ROOT, 'data');
export const FILES_DIR = path.join(DATA_DIR, 'files');
export const BACKUP_DIR = path.join(DATA_DIR, 'backups');
export const TMP_DIR = path.join(DATA_DIR, 'tmp');
export const EXPORT_DIR = path.join(DATA_DIR, 'exports');
export const DB_PATH = path.join(DATA_DIR, 'kbpro.sqlite');
/** 项目根目录下的可提交配置文件（大模型接入等），优先于默认值、低于运行时 data/config.json */
export const ROOT_CONFIG_PATH = path.join(ROOT, 'config.json');
/** 运行时配置（由「系统管理 → 实例设置」写入），优先级最高 */
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const KEY_PATH = path.join(DATA_DIR, '.master.key');

export const DEFAULTS = {
  host: process.env.KBPRO_HOST || '127.0.0.1',
  port: Number(process.env.KBPRO_PORT || 8787),
  /** 单文件上传上限（字节） */
  maxUploadBytes: 200 * 1024 * 1024,
  /** 允许用于自动解析的文本上限（字符） */
  maxExtractChars: 4 * 1024 * 1024,
  /** 检索返回上限 */
  searchLimit: 50,
  /** RAG 检索片段数 */
  ragTopK: 8,
  /** RAG 片段左右扩展窗口（字符） */
  ragChunkSize: 900,
  ragChunkOverlap: 180,
  /** 匿名访问关闭 */
  allowSignup: true,
  /** 会话有效期（天） */
  sessionDays: 30,
  /** AI 提供商：auto | ollama | openai | none */
  ai: {
    provider: 'auto',
    baseUrl: process.env.KBPRO_AI_BASE_URL || '',
    apiKey: process.env.KBPRO_AI_API_KEY || '',
    chatModel: process.env.KBPRO_AI_MODEL || '',
    embedModel: process.env.KBPRO_AI_EMBED_MODEL || '',
    ollamaUrl: process.env.KBPRO_OLLAMA_URL || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434',
    temperature: 0.2,
    maxTokens: 1600,
    timeoutMs: 120000,
    /** 知识库未检索到依据时，是否仍用大模型以通用知识作答（默认开启） */
    answerWithoutContext: true
  },
  /** 默认演示账号，仅在数据库为空时创建 */
  bootstrap: {
    email: 'admin@kbpro.local',
    password: 'admin12345',
    name: '知识库管理员'
  }
};

export function ensureDirs() {
  for (const d of [DATA_DIR, FILES_DIR, BACKUP_DIR, TMP_DIR, EXPORT_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

let cachedConfig = null;

/** 读取合并后的配置（默认值 <- config.json <- data/config.json <- 环境变量） */
export function loadConfig({ reload = false } = {}) {
  if (cachedConfig && !reload) return cachedConfig;
  const readJson = (p) => {
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { /* 忽略非法 JSON */ }
    return {};
  };
  const rootCfg = readJson(ROOT_CONFIG_PATH);
  const fileCfg = readJson(CONFIG_PATH);
  const merged = deepMerge(deepMerge(structuredClone(DEFAULTS), rootCfg), fileCfg);
  if (process.env.KBPRO_HOST) merged.host = process.env.KBPRO_HOST;
  if (process.env.KBPRO_PORT) merged.port = Number(process.env.KBPRO_PORT);
  cachedConfig = merged;
  return merged;
}

/** 持久化一份配置增量到 data/config.json */
export function saveConfig(patch) {
  let fileCfg = {};
  try {
    if (fs.existsSync(CONFIG_PATH)) fileCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    fileCfg = {};
  }
  const next = deepMerge(fileCfg, patch || {});
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
  cachedConfig = null;
  return loadConfig({ reload: true });
}

export function deepMerge(target, source) {
  if (!source || typeof source !== 'object') return target;
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      target[k] = deepMerge(target[k] && typeof target[k] === 'object' ? target[k] : {}, v);
    } else if (v !== undefined) {
      target[k] = v;
    }
  }
  return target;
}
