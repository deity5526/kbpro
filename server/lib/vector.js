/**
 * KBPRO — 向量工具
 *  · 本地哈希嵌入（零依赖、确定性、离线可用）——用于模糊内容召回
 *  · 若接入 Ollama / OpenAI 兼容 embedding 接口，则使用真实语义向量
 *  · 向量打包/解包、余弦相似度、Top-K 检索
 */
import { tokenize, isCJK } from './text.js';

export const LOCAL_DIM = 512;
export const LOCAL_MODEL = 'local-hash-512';

/* ------------------------------------------------------------------ 哈希 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

function fnv1a(str, seed = FNV_OFFSET) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** 双哈希 + 符号散列，降低冲突 */
function bucket(token, dim) {
  const h1 = fnv1a(token, FNV_OFFSET);
  const h2 = fnv1a(token, 0x9e3779b9);
  return {
    idx: h1 % dim,
    sign: ((h2 >>> 31) & 1) === 0 ? 1 : -1,
    idx2: (h1 + h2) % dim
  };
}

/* ------------------------------------------------------------------ 编码 */

/**
 * 生成一段文本的本地嵌入（L2 归一化）。
 * 采用 词 + 字符三元组 的混合散列，中文场景下明显优于纯词袋。
 * @returns {Float32Array}
 */
export function hashEmbed(text, dim = LOCAL_DIM) {
  const vec = new Float32Array(dim);
  const s = String(text ?? '');
  if (!s.trim()) return vec;

  const tokens = tokenize(s, { stopwords: true });
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);

  for (const [tok, count] of tf) {
    const w = (1 + Math.log(count)) * (tok.length >= 2 ? 1 : 0.55);
    const b = bucket(tok, dim);
    vec[b.idx] += b.sign * w;
    vec[b.idx2] += b.sign * w * 0.5;

    // 字符三元组：捕捉未登录词与拼写近似
    if (tok.length >= 3) {
      for (let i = 0; i + 3 <= tok.length; i++) {
        const tri = tok.slice(i, i + 3);
        const tb = bucket('#' + tri, dim);
        vec[tb.idx] += tb.sign * w * 0.35;
      }
    }
  }

  // CJK 二元组额外补偿（tokenize 已产出二元组，这里只做加权微调）
  const cjkRuns = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]{2,}/g) || [];
  for (const run of cjkRuns.slice(0, 4000)) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const bg = run.slice(i, i + 2);
      const b = bucket('@' + bg, dim);
      vec[b.idx] += b.sign * 0.25;
    }
  }

  return l2norm(vec);
}

export function l2norm(vec) {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const n = Math.sqrt(sum);
  if (n > 0) for (let i = 0; i < vec.length; i++) vec[i] /= n;
  return vec;
}

export function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

/* ------------------------------------------------------------------ 打包 */

export function packVec(vec) {
  const f32 = vec instanceof Float32Array ? vec : Float32Array.from(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function unpackVec(buf, dim) {
  if (!buf) return new Float32Array(dim || 0);
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const usable = b.length - (b.length % 4);
  const copy = Buffer.from(b.subarray(0, usable));
  return new Float32Array(copy.buffer, copy.byteOffset, usable / 4);
}

/* ------------------------------------------------------------------ Top-K */

/**
 * @param {Float32Array} queryVec
 * @param {{id:any, vec:Float32Array}[]} items
 */
export function topKByCosine(queryVec, items, k = 10, minScore = 0.01) {
  const scored = [];
  for (const it of items) {
    if (!it.vec || it.vec.length !== queryVec.length) continue;
    const s = cosine(queryVec, it.vec);
    if (s >= minScore) scored.push({ ...it, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k);
}

/** 简易 k-means（用于知识聚类/主题发现，k 很小） */
export function kmeans(vectors, k = 4, iterations = 12, seed = 42) {
  if (!vectors.length) return { centroids: [], assignments: [] };
  const dim = vectors[0].length;
  const kk = Math.max(1, Math.min(k, vectors.length));
  let rand = seed >>> 0;
  const nextRand = () => {
    rand = (Math.imul(rand, 1664525) + 1013904223) >>> 0;
    return rand / 4294967296;
  };
  const centroids = [];
  const used = new Set();
  while (centroids.length < kk) {
    const i = Math.floor(nextRand() * vectors.length);
    if (used.has(i)) continue;
    used.add(i);
    centroids.push(Float32Array.from(vectors[i]));
  }
  let assignments = new Array(vectors.length).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (let i = 0; i < vectors.length; i++) {
      let best = 0;
      let bestScore = -Infinity;
      for (let c = 0; c < centroids.length; c++) {
        const s = cosine(vectors[i], centroids[c]);
        if (s > bestScore) { bestScore = s; best = c; }
      }
      if (assignments[i] !== best) { assignments[i] = best; changed = true; }
    }
    for (let c = 0; c < centroids.length; c++) centroids[c] = new Float32Array(dim);
    const counts = new Array(centroids.length).fill(0);
    for (let i = 0; i < vectors.length; i++) {
      const c = assignments[i];
      counts[c]++;
      const v = vectors[i];
      for (let d = 0; d < dim; d++) centroids[c][d] += v[d];
    }
    for (let c = 0; c < centroids.length; c++) {
      if (counts[c] === 0) {
        const i = Math.floor(nextRand() * vectors.length);
        centroids[c] = Float32Array.from(vectors[i]);
        continue;
      }
      for (let d = 0; d < dim; d++) centroids[c][d] /= counts[c];
      l2norm(centroids[c]);
    }
    if (!changed && iter > 2) break;
  }
  return { centroids, assignments, k: kk };
}

/** 向量是否来自本地哈希嵌入（需要词面锚点约束，避免哈希碰撞假阳性） */
export function isLocalVectorModel(model) {
  return !model || model === LOCAL_MODEL;
}

/** 向量是否可用于中文——本地哈希始终可用 */
export function isLocalModel(model) {
  return !model || model === LOCAL_MODEL;
}

export { isCJK };
