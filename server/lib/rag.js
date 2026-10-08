/**
 * KBPRO — RAG 引擎
 *  文档结构化 → 智能分块 → 向量化 → 混合召回（BM25 + 向量 + RRF 融合）→ 重排 → 生成
 */
import { all, get, run, insert, tx, nowIso, indexEntity, removeEntityIndex, corpusStats } from '../db.js';
import { loadConfig } from '../config.js';
import {
  normalizeWhitespace, splitSections, tokenize, extractKeywords, truncate, splitSentences, makeSnippet
} from './text.js';
import { hashEmbed, packVec, unpackVec, cosine, l2norm, LOCAL_DIM, LOCAL_MODEL, isLocalVectorModel } from './vector.js';
import { embedTexts, chatCompletion, resolveAiConfig } from './ai.js';
import * as local from './localai.js';
import { bm25Scores } from './search.js';

/* ================================================================== 分块 */

/**
 * 将长文本切分为带元数据的检索块。
 * 规则：优先按 Markdown 标题分段 → 段落聚合 → 超长段落按句子拆分。
 * @param {string} text
 * @param {{size?:number, overlap?:number, pages?:{index:number,text:string}[], title?:string}} opts
 */
export function chunkText(text, opts = {}) {
  const size = opts.size ?? loadConfig().ragChunkSize ?? 900;
  const overlap = opts.overlap ?? loadConfig().ragChunkOverlap ?? 180;
  const pages = Array.isArray(opts.pages) && opts.pages.length ? opts.pages : null;

  const raw = normalizeWhitespace(text || '');
  if (!raw) return [];

  // 若有分页信息，按页独立分块以保留页码
  if (pages) {
    const out = [];
    let index = 0;
    for (const page of pages) {
      const pieces = chunkBySections(page.text || '', { size, overlap });
      for (const p of pieces) {
        out.push({ idx: index++, heading: p.heading, page: Number(page.index || 0), text: p.text });
      }
    }
    return out;
  }

  const pieces = chunkBySections(raw, { size, overlap });
  return pieces.map((p, i) => ({ idx: i, heading: p.heading, page: 0, text: p.text }));
}

function chunkBySections(text, { size, overlap }) {
  const sections = splitSections(text);
  const out = [];
  for (const sec of sections) {
    const body = sec.text;
    if (!body) continue;
    if (body.length <= size * 1.4) {
      out.push({ heading: sec.heading, text: body });
      continue;
    }
    const paras = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
    let buf = '';
    for (const para of paras) {
      if (para.length > size * 1.6) {
        if (buf.trim()) { out.push({ heading: sec.heading, text: buf.trim() }); buf = ''; }
        for (const piece of splitLongParagraph(para, size, overlap)) {
          out.push({ heading: sec.heading, text: piece });
        }
        continue;
      }
      if ((buf + '\n\n' + para).length > size && buf) {
        out.push({ heading: sec.heading, text: buf.trim() });
        buf = tailOverlap(buf, overlap) + '\n\n' + para;
      } else {
        buf = buf ? `${buf}\n\n${para}` : para;
      }
    }
    if (buf.trim()) out.push({ heading: sec.heading, text: buf.trim() });
  }
  return out.length ? out : [{ heading: '', text }];
}

function splitLongParagraph(para, size, overlap) {
  const sentences = splitSentences(para);
  const out = [];
  let buf = '';
  for (const s of sentences) {
    if ((buf + s).length > size && buf) {
      out.push(buf.trim());
      buf = tailOverlap(buf, overlap) + s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out.length ? out : [truncate(para, size)];
}

function tailOverlap(text, overlap) {
  if (overlap <= 0) return '';
  const s = text.trim();
  if (s.length <= overlap) return s + ' ';
  let cut = s.length - overlap;
  const nextSpace = s.indexOf(' ', cut);
  if (nextSpace > 0 && nextSpace - cut < 40) cut = nextSpace + 1;
  return s.slice(cut);
}

/* ================================================================== 索引 */

/**
 * 为文件建立全文/分块/向量索引。
 * @param {object} p
 * @param {string} p.fileId
 * @param {string} p.workspaceId
 * @param {string} p.title
 * @param {string} p.text
 * @param {{index:number,text:string}[]} [p.pages]
 * @param {string[]} [p.tags]
 */
export function indexFile({ fileId, workspaceId, title, text, pages, tags = [] }) {
  const started = Date.now();
  const clean = normalizeWhitespace(text || '');

  // 1) 清理旧索引
  removeFileIndex(fileId);

  // 2) 分块
  const chunks = chunkText(clean, { pages });

  // 3) 落库 + 向量，并回收真实 chunk id
  const persisted = []; // { chunkId, text }
  tx((d) => {
    const insChunk = d.prepare(`INSERT INTO chunks(file_id, workspace_id, idx, heading, page, text, chars) VALUES(?,?,?,?,?,?,?)`);
    const insVec = d.prepare(`INSERT INTO chunk_vectors(chunk_id, dim, vec, model) VALUES(?,?,?,?)`);
    for (const c of chunks) {
      const info = insChunk.run(fileId, workspaceId, c.idx, c.heading || '', c.page || 0, c.text, c.text.length);
      const chunkId = Number(info.lastInsertRowid);
      insVec.run(chunkId, LOCAL_DIM, packVec(hashEmbed(c.text, LOCAL_DIM)), LOCAL_MODEL);
      persisted.push({ chunkId, text: c.text, workspaceId });
    }
  });

  // 4) 文件级 BM25（标题加权 + 正文头部 + 关键词，保证标题检索命中）
  const keywords = extractKeywords(clean, 24);
  const fileDoc = [
    title || '',
    title || '',
    title || '',
    (tags || []).join(' '),
    keywords.join(' '),
    clean.slice(0, 6000)
  ].join('\n');
  indexEntity('file', fileId, workspaceId, tokenize(fileDoc));

  // 5) 块级 BM25 —— 键必须是真实的 chunks.id，检索时据此回查文件
  for (const c of persisted) {
    indexEntity('chunk', String(c.chunkId), c.workspaceId, tokenize(c.text));
  }

  return { chunks: persisted.length, keywords, ms: Date.now() - started };
}

/** 重建某文件的块级 BM25 索引 */
export function reindexChunkTerms(fileId, workspaceId) {
  const rows = all(`SELECT id, text FROM chunks WHERE file_id=?`, fileId);
  for (const r of rows) indexEntity('chunk', String(r.id), workspaceId, tokenize(r.text));
  return rows.length;
}

export function removeFileIndex(fileId) {
  const rows = all(`SELECT id FROM chunks WHERE file_id=?`, fileId);
  tx((d) => {
    const delVec = d.prepare(`DELETE FROM chunk_vectors WHERE chunk_id=?`);
    for (const r of rows) delVec.run(r.id);
    d.prepare(`DELETE FROM chunks WHERE file_id=?`).run(fileId);
  });
  for (const r of rows) removeEntityIndex('chunk', String(r.id));
  removeEntityIndex('file', fileId);
}

/** 用大模型 embedding 覆盖本地哈希向量（可选增强） */
export async function reembedWorkspace(workspaceId, userRow, { batchSize = 24, onProgress } = {}) {
  const rows = all(
    `SELECT c.id, c.text FROM chunks c WHERE c.workspace_id=? ORDER BY c.id`, workspaceId
  );
  if (!rows.length) return { updated: 0, model: '', provider: '' };

  let updated = 0;
  let model = LOCAL_MODEL;
  let provider = 'local';

  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const res = await embedTexts(batch.map((r) => r.text), userRow);
    if (res.vectors && res.vectors.length === batch.length) {
      model = res.model;
      provider = res.provider;
      tx((d) => {
        const stmt = d.prepare(`UPDATE chunk_vectors SET dim=?, vec=?, model=? WHERE chunk_id=?`);
        for (let k = 0; k < batch.length; k++) {
          stmt.run(res.vectors[k].length, packVec(l2norm(Float32Array.from(res.vectors[k]))), res.model, batch[k].id);
        }
      });
    } else {
      tx((d) => {
        const stmt = d.prepare(`UPDATE chunk_vectors SET dim=?, vec=?, model=? WHERE chunk_id=?`);
        for (const b of batch) stmt.run(LOCAL_DIM, packVec(hashEmbed(b.text, LOCAL_DIM)), LOCAL_MODEL, b.id);
      });
    }
    updated += batch.length;
    onProgress?.({ updated, total: rows.length });
  }
  return { updated, model, provider };
}

/* ================================================================== 检索 */

/**
 * 混合召回：BM25（块级）+ 向量，RRF 融合后重排。
 * @returns {{chunkId:number, fileId:string, title:string, ext:string, folderId:string|null,
 *            text:string, heading:string, page:number, score:number, sources:string[]}[]}
 */
export function retrieveContexts({ workspaceIds = [], query, topK = 8, fileIds = null, minScore = 0, acl = null, queryVector = null }) {
  const q = String(query || '').trim();
  if (!q || !workspaceIds.length) return [];

  const terms = [...new Set(tokenize(q))];
  const ranks = new Map(); // chunkId -> {bm25, vec, chunk}

  /* --- BM25 块级 --- */
  if (terms.length) {
    const bm = bm25Scores(terms, 'chunk', { limit: 30000 });
    const scored = [...bm.entries()].map(([id, v]) => ({ id: Number(id), score: v.score })).sort((a, b) => b.score - a.score);
    const top = scored.slice(0, 200);
    if (top.length) {
      const ids = top.map((t) => t.id);
      const rows = all(
        `SELECT id, file_id, workspace_id, heading, page, text FROM chunks WHERE id IN (${ids.map(() => '?').join(',')})`,
        ...ids
      );
      const byId = new Map(rows.map((r) => [String(r.id), r]));
      top.forEach((t, i) => {
        const row = byId.get(String(t.id));
        if (!row) return;
        ranks.set(t.id, { chunk: row, bm25: t.score, bm25Rank: i + 1, rrf: 1 / (60 + i + 1) });
      });
    }
  }

  /* --- 向量召回 --- */
  const qvLocal = hashEmbed(q, LOCAL_DIM);
  const remoteQ = queryVector && queryVector.length ? queryVector : null;
  const ph = workspaceIds.map(() => '?').join(',');
  const vecRows = all(
    `SELECT v.chunk_id, v.dim, v.vec, v.model, c.file_id, c.workspace_id, c.heading, c.page, c.text
       FROM chunk_vectors v JOIN chunks c ON c.id = v.chunk_id
      WHERE c.workspace_id IN (${ph})
      LIMIT 20000`,
    ...workspaceIds
  );
  const vecScored = [];
  for (const r of vecRows) {
    const v = unpackVec(r.vec, r.dim);
    const qv = remoteQ && remoteQ.length === r.dim ? remoteQ
      : (r.dim === qvLocal.length ? qvLocal : null);
    if (!qv) continue;
    const s = cosine(qv, v);
    if (s <= 0.05) continue;
    // 本地哈希向量是词面近似的代理，存在哈希碰撞导致的假阳性；
    // 因此只有当片段与查询词存在实际字面交集时才采信它。
    // 真实语义模型（远程 embedding）不受此限制。
    if (isLocalVectorModel(r.model)) {
      const lower = String(r.text || '').toLowerCase();
      if (!terms.some((t) => t.length >= 2 && lower.includes(t))) continue;
    }
    vecScored.push({ row: r, score: s });
  }
  vecScored.sort((a, b) => b.score - a.score);
  vecScored.slice(0, 200).forEach((item, i) => {
    const chunkId = Number(item.row.chunk_id);
    const entry = ranks.get(chunkId) || {
      chunk: { id: chunkId, file_id: item.row.file_id, workspace_id: item.row.workspace_id, heading: item.row.heading, page: item.row.page, text: item.row.text },
      bm25: 0, bm25Rank: null, rrf: 0
    };
    entry.vec = item.score;
    entry.vecRank = i + 1;
    entry.rrf = (entry.rrf || 0) + 1 / (60 + i + 1);
    ranks.set(chunkId, entry);
  });

  if (!ranks.size) return [];

  /* --- 过滤 & 装配 --- */
  const candidates = [...ranks.values()];
  const fileIdSet = candidates.map((c) => c.chunk.file_id);
  const uniqueFileIds = [...new Set(fileIdSet)];
  const fileRows = uniqueFileIds.length
    ? all(
      `SELECT id, name, ext, folder_id, workspace_id, tags, starred, pinned, updated_at
         FROM files WHERE deleted_at IS NULL AND id IN (${uniqueFileIds.map(() => '?').join(',')})`,
      ...uniqueFileIds
    )
    : [];
  const fileMap = new Map(fileRows.map((r) => [r.id, r]));

  const termSet = terms;
  const out = [];
  const wsSet = new Set(workspaceIds);
  const aclFiles = acl && acl.allowedFileIds ? acl.allowedFileIds : null;
  for (const c of candidates) {
    const f = fileMap.get(c.chunk.file_id);
    if (!f) continue;
    if (!wsSet.has(f.workspace_id)) continue;
    if (fileIds && fileIds.length && !fileIds.includes(f.id)) continue;
    if (aclFiles && !aclFiles.has(f.id)) continue;

    let score = (c.rrf || 0) * 10;
    score += Math.min(2, (c.bm25 || 0) * 0.12);
    score += (c.vec || 0) * 3.2;

    // 词覆盖重排：命中的查询词越多越靠前
    const lower = String(c.chunk.text || '').toLowerCase();
    let hits = 0;
    for (const t of termSet) if (lower.includes(t)) hits++;
    score += (hits / Math.max(1, termSet.length)) * 1.6;

    if (f.pinned) score += 0.15;
    if (f.starred) score += 0.08;
    if (score < minScore) continue;

    const sources = [];
    if (c.bm25Rank) sources.push('keyword');
    if (c.vecRank) sources.push('vector');

    out.push({
      chunkId: c.chunk.id,
      fileId: f.id,
      title: f.name,
      ext: f.ext,
      folderId: f.folder_id,
      tags: f.tags,
      heading: c.chunk.heading || '',
      page: Number(c.chunk.page || 0),
      text: String(c.chunk.text || ''),
      score: Number(score.toFixed(4)),
      bm25: Number((c.bm25 || 0).toFixed(4)),
      vec: Number((c.vec || 0).toFixed(4)),
      sources
    });
  }

  out.sort((a, b) => b.score - a.score);

  // 同一文件最多保留 4 块，保证来源多样性
  const perFile = new Map();
  const picked = [];
  for (const item of out) {
    const n = perFile.get(item.fileId) || 0;
    if (n >= 4) continue;
    perFile.set(item.fileId, n + 1);
    picked.push(item);
    if (picked.length >= topK) break;
  }

  // 用户已显式指定文档：确保**每一份**指定文档都有代表。
  //
  // 两个场景：
  //  1) 一条都没匹配上（「就此文档提问 → 这份文档讲了什么？」这类问题与正文用词
  //     几乎没有交集，词面检索必然为空）→ 把额度都给指定文档；
  //  2) 只匹配上了其中一部分（问「对比这两份」却只召回了一份）→ 给落空的文档各补 1 块，
  //     否则用户会以为两份都被参考了，而答案实际只基于其中一份。
  //
  // 注意：仅当用户显式限定文件时才兜底；普通提问仍严格按相关性召回，不拿无关文档凑数。
  if (fileIds && fileIds.length) {
    const covered = new Set(picked.map((i) => i.fileId));
    const missing = fileIds.filter((id) => !covered.has(id));
    if (missing.length) {
      const budget = picked.length === 0 ? topK : missing.length;
      picked.push(...chunksOfScopedFiles(missing, budget));
    }
  }
  return picked;
}

/**
 * 兜底：按文档顺序取指定文件的若干知识块（长文档取开头部分，通常正是概述所在）。
 * 多文件时每个文件均分名额，避免第一个文件把名额吃光。
 */
function chunksOfScopedFiles(fileIds, topK) {
  const ph = fileIds.map(() => '?').join(',');
  const rows = all(
    `SELECT c.id AS chunk_id, c.file_id, c.heading, c.page, c.text,
            f.name, f.ext, f.folder_id, f.tags
       FROM chunks c JOIN files f ON f.id = c.file_id
      WHERE c.file_id IN (${ph}) AND f.deleted_at IS NULL
      ORDER BY c.file_id, c.idx`,
    ...fileIds
  );
  const cap = fileIds.length === 1 ? topK : Math.max(1, Math.ceil(topK / fileIds.length));
  const perFile = new Map();
  const out = [];
  for (const r of rows) {
    const n = perFile.get(r.file_id) || 0;
    if (n >= cap) continue;
    perFile.set(r.file_id, n + 1);
    out.push({
      chunkId: Number(r.chunk_id),
      fileId: r.file_id,
      title: r.name,
      ext: r.ext,
      folderId: r.folder_id,
      tags: r.tags,
      heading: r.heading || '',
      page: Number(r.page || 0),
      text: String(r.text || ''),
      score: 0, bm25: 0, vec: 0,
      sources: ['scoped']
    });
    if (out.length >= topK) break;
  }
  return out;
}

/* ================================================================== 提示词 */

export const SYSTEM_PROMPT = `你是「KBPRO 智能知识库」的问答助手，服务于企业内部与个人知识管理场景。

严格遵守以下规则：
1. 只依据下方提供的【知识片段】作答，不得编造片段中不存在的事实、数字或结论。
2. 每一个关键论断后必须标注来源编号，格式为 [1]、[2,3]。
3. 如果知识片段不足以回答，明确说明"知识库中暂无相关依据"，并指出还需要补充哪类资料。
4. 回答使用简体中文，结构清晰：先给结论，再给要点，必要时用列表或表格。
5. 遇到专业术语保持原文表述，不要擅自改写专有名词。
6. 不要提及"知识片段""上下文"等实现细节，直接给出面向用户的答案。`;

/** 知识库未检索到依据时，改用通用知识回答的系统提示词 */
export const GENERAL_SYSTEM_PROMPT = `你是 KBPRO 智能助手。当前知识库中没有检索到与该问题相关的资料，因此请基于你的通用知识直接回答用户。要求：
1. 回答准确、简洁、有条理，使用 Markdown；
2. 不得伪造引用，也不要声称内容来自知识库；
3. 用一句话在开头说明「以下为通用回答，未引用知识库资料」；
4. 若涉及实时、私有或你无法确认的信息，请如实说明不确定。`;

/**
 * 构建带引用的 RAG 提示词。
 * @param {string} question
 * @param {object[]} contexts retrieveContexts 的返回
 * @param {{role:string,content:string}[]} [history]
 */
export function buildRagMessages(question, contexts, history = []) {
  const blocks = contexts.map((c, i) => {
    const loc = [c.page ? `第 ${c.page} 页` : '', c.heading ? `章节：${c.heading}` : ''].filter(Boolean).join(' · ');
    return `[${i + 1}] 《${c.title}》${loc ? ` (${loc})` : ''}\n${c.text}`;
  }).join('\n\n---\n\n');

  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const h of history.slice(-6)) {
    if (h.role === 'user' || h.role === 'assistant') messages.push({ role: h.role, content: String(h.content).slice(0, 4000) });
  }
  messages.push({
    role: 'user',
    content: `【知识片段】\n${blocks || '（未检索到相关内容）'}\n\n【用户问题】\n${question}\n\n请依据上述片段回答，并标注来源编号。`
  });
  return messages;
}

/* ================================================================== 问答 */

/**
 * 基于私有文档的智能问答（支持流式）。
 * @param {object} p
 * @param {string} p.question
 * @param {string[]} p.workspaceIds
 * @param {object} [p.userRow]
 * @param {{role,content}[]} [p.history]
 * @param {number} [p.topK]
 * @param {string[]} [p.fileIds]
 * @param {(token:string)=>void} [p.onToken]
 * @param {AbortSignal} [p.signal]
 */
export async function askKnowledgeBase(p) {
  const started = Date.now();
  const topK = p.topK ?? loadConfig().ragTopK ?? 8;

  // 若配置了远程嵌入模型，用同一模型生成查询向量，使回流向量能参与召回
  let queryVector = null;
  try {
    const { embedTexts } = await import('./ai.js');
    const er = await embedTexts([p.question], p.userRow);
    if (er?.provider && er.provider !== 'local' && er.vectors?.[0]) {
      queryVector = l2norm(Float32Array.from(er.vectors[0]));
    }
  } catch { /* 忽略，回退本地哈希向量 */ }

  const contexts = retrieveContexts({
    workspaceIds: p.workspaceIds,
    query: p.question,
    topK,
    fileIds: p.fileIds || null,
    acl: p.acl || null,
    queryVector
  });

  const citations = contexts.map((c, i) => ({
    index: i + 1,
    fileId: c.fileId,
    chunkId: c.chunkId,
    title: c.title,
    ext: c.ext,
    page: c.page,
    heading: c.heading,
    score: c.score,
    snippet: truncate(c.text, 260)
  }));

  // 统一累积「实际发给用户的文本」。返回值必须与流式内容完全一致，
  // 否则会出现「用户看到的」与「入库的」两份不同内容（例如降级时被替换掉半截输出）。
  let streamed = '';
  const emit = p.onToken
    ? (t) => { if (t) { streamed += t; p.onToken(t); } }
    : null;
  /** 流式时以累积内容为准；非流式时用返回值 */
  const reconcile = (result) => (emit ? (streamed || result.content || '') : (result.content || ''));

  if (!contexts.length) {
    // 未检索到知识库依据。
    // 若已配置大模型且开启 answerWithoutContext（默认开启），则用通用知识回答，
    // 并明确声明未引用知识库；否则返回固定的「暂无依据」提示。
    const cfg = loadConfig();
    const allowGeneral = cfg.ai?.answerWithoutContext !== false;
    let conf = null;
    try { conf = resolveAiConfig(p.userRow); } catch { conf = null; }

    if (allowGeneral && conf && conf.provider !== 'local') {
      try {
        const result = await chatCompletion({
          messages: [{ role: 'system', content: GENERAL_SYSTEM_PROMPT }, { role: 'user', content: p.question }],
          userRow: p.userRow,
          stream: !!emit,
          onToken: emit || undefined,
          signal: p.signal
        });
        const content = reconcile(result);
        if (content && !result.empty) {
          return {
            content, citations: [], provider: result.provider, model: result.model,
            fallback: !!result.fallback, error: result.error || '',
            interrupted: !!result.interrupted, contexts: [],
            ms: Date.now() - started, noContext: true, general: !result.fallback
          };
        }
      } catch (err) {
        if (p.signal?.aborted) throw err;
        /* 通用回答彻底失败，落到下面的固定提示 */
      }
      // 已经吐过内容（例如中断说明）时，绝不能再追加第二段提示——
      // 那会得到「半截大模型输出 + 提示」的前后拼接乱码。
      if (streamed) {
        return {
          content: streamed, citations: [], provider: 'none', model: '',
          fallback: true, error: '大模型调用失败', contexts: [],
          ms: Date.now() - started, noContext: true, general: false
        };
      }
    }

    const content = '知识库中暂无与该问题相关的依据。\n\n**可能的原因：**\n- 相关文档尚未上传，或仍处于解析中\n- 当前所处的知识库（个人 / 团队）不包含该资料\n- 问题中的关键词与文档表述差异较大\n\n建议换用文档中出现过的关键词重试，或先上传相关资料。';
    emit?.(content);
    return {
      content, citations: [], provider: 'none', model: '',
      fallback: false, error: '', contexts: [],
      ms: Date.now() - started, noContext: true, general: false
    };
  }

  const messages = buildRagMessages(p.question, contexts, p.history || []);
  const result = await chatCompletion({
    messages,
    userRow: p.userRow,
    provider: p.provider,
    model: p.model,
    stream: !!emit,
    onToken: emit || undefined,
    signal: p.signal,
    fallback: { question: p.question, contexts }
  });

  return {
    content: reconcile(result),
    citations,
    provider: result.provider,
    model: result.model,
    fallback: !!result.fallback,
    error: result.error || '',
    usage: result.usage || {},
    contexts,
    ms: Date.now() - started
  };
}

/* ================================================================== 文档智能处理 */

/**
 * 文档智能解析：摘要 / 大纲 / 关键词 / 术语。
 * @param {object} p
 * @param {string} p.text
 * @param {string} p.title
 * @param {'summary'|'outline'|'keywords'|'all'} [p.kind]
 * @param {object} [p.userRow]
 */
export async function analyzeDocument({ text, title, kind = 'all', userRow, style = 'paragraph' }) {
  const clean = normalizeWhitespace(text || '');
  const conf = resolveAiConfig(userRow);
  const result = { provider: conf.provider, model: conf.chatModel, local: {}, generated: {} };

  // 本地结构化结果始终产出（快速、可离线）
  if (kind === 'all' || kind === 'summary') result.local.summary = local.localSummarize(clean, { title: '', style });
  if (kind === 'all' || kind === 'outline') result.local.outline = local.localOutline(clean);
  if (kind === 'all' || kind === 'keywords') result.local.keywords = local.localKeywordReport(clean);

  if (conf.provider === 'local') {
    result.provider = 'local';
    result.model = 'local-extractive';
    result.degraded = true;
    return result;
  }

  // 有大模型时提供生成式摘要（更凝练、更结构化）
  try {
    const tasks = [];
    if (kind === 'all' || kind === 'summary') tasks.push(['summary', `请为文档《${title}》写一段 200-400 字的中文摘要，先给一句话结论，再给 3-5 条要点。不要编造内容。`]);
    if (kind === 'all' || kind === 'outline') tasks.push(['outline', `请为文档《${title}》生成结构化大纲（Markdown 多级列表），并标注每个章节的核心信息。`]);
    if (kind === 'all' || kind === 'keywords') tasks.push(['keywords', `请提取文档《${title}》的 12 个核心关键词与 5 个专业术语，并给出每个术语的一句话解释。`]);

    const body = clean.slice(0, 24000);
    for (const [key, instruction] of tasks) {
      const res = await chatCompletion({
        messages: [
          { role: 'system', content: '你是企业知识管理专家，擅长文档提炼。只依据用户提供的正文作答，不得编造。' },
          { role: 'user', content: `${instruction}\n\n【正文】\n${body}` }
        ],
        userRow,
        maxTokens: 1400
      });
      result.generated[key] = res.content;
    }
    result.model = Object.values(result.generated).length ? conf.chatModel : conf.chatModel;
  } catch (err) {
    result.degraded = true;
    result.error = err.message;
  }
  return result;
}

/** 文档间对比（多文档共性/差异） */
export async function compareDocuments({ docs, userRow }) {
  const contexts = docs.map((d) => ({ id: d.id, fileId: d.id, title: d.title, text: normalizeWhitespace(d.text || '').slice(0, 12000), score: 1 }));
  const conf = resolveAiConfig(userRow);
  const localResult = local.localCompare(contexts);
  if (conf.provider === 'local') return { ...localResult, provider: 'local', model: 'local-extractive' };
  try {
    const body = contexts.map((c, i) => `【文档${i + 1}】《${c.title}》\n${c.text.slice(0, 6000)}`).join('\n\n');
    const res = await chatCompletion({
      messages: [
        { role: 'system', content: '你是知识管理专家，请对比多份文档，输出共性与差异，使用 Markdown 表格与列表，不得编造。' },
        { role: 'user', content: `请对比以下文档：\n\n${body}` }
      ],
      userRow,
      maxTokens: 1800
    });
    return { ...localResult, generated: res.content, provider: res.provider, model: res.model };
  } catch {
    return { ...localResult, provider: 'local', model: 'local-extractive' };
  }
}

export { hashEmbed, LOCAL_MODEL, LOCAL_DIM };
