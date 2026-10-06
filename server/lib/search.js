/**
 * KBPRO — 检索引擎
 *  · BM25（DB 持久化倒排表）——标题 + 正文
 *  · 向量召回（chunk 级语义/模糊匹配）
 *  · RRF 融合 + 业务加权（标题命中、标签、收藏、置顶、时效）
 *  · 关键词高亮片段
 */
import {
  all, get, corpusStats, termDf, postingsForTerms, docLens, scalar
} from '../db.js';
import { tokenize, queryTerms, makeSnippet, highlight, escapeHtml, normalizeTags, truncate } from './text.js';
import { hashEmbed, unpackVec, topKByCosine, LOCAL_DIM, isLocalVectorModel } from './vector.js';

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

/* ------------------------------------------------------------------ BM25 打分 */

/**
 * 对单一实体类型做 BM25 打分。
 * @param {string[]} terms 去重后的查询词
 * @param {'file'|'note'|'chunk'} entityType
 * @returns {Map<string, {score:number, hits:Set<string>, tf:Map<string,number>}>}
 */
export function bm25Scores(terms, entityType, { limit = 5000 } = {}) {
  const out = new Map();
  const uniq = [...new Set(terms)].filter(Boolean);
  if (!uniq.length) return out;

  const { n, avgdl } = corpusStats(entityType);
  if (n === 0) return out;

  const df = termDf(uniq);
  const postings = postingsForTerms(uniq, entityType, limit);

  // 预取文档长度
  const ids = [...postings.keys()];
  const lens = docLens(entityType, ids);

  for (const [entityId, termTfs] of postings) {
    const dl = lens.get(entityId) || avgdl || 1;
    let score = 0;
    const hits = new Set();
    for (const [term, tf] of termTfs) {
      const dfv = df.get(term) || 1;
      const idf = Math.log(1 + (n - dfv + 0.5) / (dfv + 0.5));
      const denom = tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl));
      score += idf * ((tf * (BM25_K1 + 1)) / (denom || 1));
      if (idf > 0.15) hits.add(term);
    }
    out.set(String(entityId), { score, hits, tf: termTfs });
  }
  return out;
}

/* ------------------------------------------------------------------ 向量召回 */

/**
 * chunk 级向量检索。
 * 本地哈希向量（默认离线引擎）只是词面近似的代理，哈希碰撞会产生假阳性，
 * 因此对本地向量要求片段与查询词存在字面交集；真实语义模型不受此限制。
 * @param {string} query
 * @param {string[]} workspaceIds
 */
export function vectorSearchChunks(query, workspaceIds, { topK = 60, minScore = 0.06 } = {}) {
  const qv = hashEmbed(query, LOCAL_DIM);
  const placeholders = workspaceIds.map(() => '?').join(',') || "''";
  const rows = all(
    `SELECT c.id AS chunk_id, c.file_id, c.idx, c.text, c.heading, c.page, v.vec, v.dim, v.model
       FROM chunks c
       JOIN chunk_vectors v ON v.chunk_id = c.id
      WHERE c.workspace_id IN (${placeholders})`,
    ...workspaceIds
  );
  if (!rows.length) return [];
  const anchors = queryTerms(query).map((t) => String(t).toLowerCase()).filter((t) => t.length >= 2);
  const items = rows
    .filter((r) => {
      if (!isLocalVectorModel(r.model)) return true;
      if (!anchors.length) return true;
      const lower = String(r.text || '').toLowerCase();
      return anchors.some((t) => lower.includes(t));
    })
    .map((r) => ({ id: Number(r.chunk_id), fileId: r.file_id, vec: unpackVec(r.vec, r.dim), row: r }));
  if (!items.length) return [];
  const top = topKByCosine(qv, items, topK, minScore);
  return top.map((t) => ({
    chunkId: t.id, fileId: t.fileId, score: t.score,
    text: t.row.text, heading: t.row.heading, page: Number(t.row.page || 0), idx: Number(t.row.idx || 0)
  }));
}

/* ------------------------------------------------------------------ 工具 */

function placeholdersFor(arr) {
  return arr.length ? arr.map(() => '?').join(',') : "''";
}

function recencyBoost(iso) {
  if (!iso) return 0;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 0;
  const days = (Date.now() - t) / 86400000;
  if (days <= 1) return 0.35;
  if (days <= 7) return 0.22;
  if (days <= 30) return 0.12;
  if (days <= 180) return 0.04;
  return 0;
}

function titleBoost(title, terms) {
  const t = String(title || '').toLowerCase();
  if (!t) return 0;
  let boost = 0;
  for (const term of terms) {
    const lt = String(term).toLowerCase();
    if (!lt) continue;
    const pos = t.indexOf(lt);
    if (pos === 0) boost += 2.2;
    else if (pos > 0) boost += 1.1;
  }
  return Math.min(boost, 6);
}

/* ------------------------------------------------------------------ 主检索 */

/**
 * 全局检索。
 * @param {object} p
 * @param {string[]} p.workspaceIds   可访问的知识库 ID
 * @param {string} p.query
 * @param {string[]} [p.types]        ['file','note']
 * @param {string[]} [p.tags]
 * @param {string[]} [p.exts]
 * @param {string} [p.folderId]
 * @param {boolean} [p.starredOnly]
 * @param {string} [p.mode]           'hybrid'|'keyword'|'vector'|'fuzzy'
 * @param {number} [p.limit]
 * @param {number} [p.offset]
 * @param {object} [p.acl]            { allowedFileIds:Set|null, allowedNoteIds:Set|null }
 */
export function searchAll(params) {
  const {
    workspaceIds = [], query = '', types = ['file', 'note'], tags = [], exts = [],
    folderId = null, starredOnly = false, mode = 'hybrid', limit = 30, offset = 0, acl = {}
  } = params;

  const q = String(query || '').trim();
  const wantFiles = types.includes('file');
  const wantNotes = types.includes('note');

  if (!workspaceIds.length) return { total: 0, items: [], mode, took: 0, terms: [] };
  const started = Date.now();

  const tokens = [...new Set(tokenize(q))];
  const terms = queryTerms(q);

  const fileScores = new Map();
  const noteScores = new Map();
  const chunkHits = new Map(); // fileId -> { score, best:[], hits:Set }

  const useKeyword = mode !== 'vector';
  const useVector = (mode === 'hybrid' || mode === 'vector') && q.length >= 2;

  if (useKeyword && tokens.length) {
    if (wantFiles) {
      const m = bm25Scores(tokens, 'file');
      for (const [id, v] of m) fileScores.set(id, { score: v.score, hits: v.hits, chunkScore: 0, bestChunk: null });
      const cm = bm25Scores(tokens, 'chunk', { limit: 20000 });
      if (cm.size) {
        const ids = [...cm.keys()].map(Number).filter(Number.isFinite);
        const rows = ids.length
          ? all(`SELECT id, file_id, text, heading, page FROM chunks WHERE id IN (${placeholdersFor(ids)})`, ...ids)
          : [];
        const byId = new Map(rows.map((r) => [String(r.id), r]));
        for (const [cid, v] of cm) {
          const row = byId.get(String(cid));
          if (!row) continue;
          const fid = row.file_id;
          const entry = chunkHits.get(fid) || { score: 0, best: [], hits: new Set() };
          entry.score += v.score;
          entry.best.push({ chunkId: Number(cid), score: v.score, text: row.text, heading: row.heading, page: Number(row.page || 0) });
          for (const h of v.hits) entry.hits.add(h);
          chunkHits.set(fid, entry);
        }
        for (const [fid, entry] of chunkHits) {
          entry.best.sort((a, b) => b.score - a.score);
          entry.best = entry.best.slice(0, 3);
          const existing = fileScores.get(fid) || { score: 0, hits: new Set(), chunkScore: 0, bestChunk: null };
          existing.chunkScore = entry.score * 0.85;
          existing.bestChunk = entry.best[0] || null;
          for (const h of entry.hits) existing.hits.add(h);
          fileScores.set(fid, existing);
        }
      }
    }
    if (wantNotes) {
      const m = bm25Scores(tokens, 'note');
      for (const [id, v] of m) noteScores.set(id, { score: v.score, hits: v.hits, chunkScore: 0 });
    }
  }

  /* -------- 向量召回合并到文件分数 -------- */
  const vectorUsed = [];
  if (useVector && wantFiles) {
    const vs = vectorSearchChunks(q, workspaceIds, { topK: 80, minScore: 0.08 });
    for (const hit of vs) {
      vectorUsed.push(hit);
      const entry = fileScores.get(hit.fileId) || { score: 0, hits: new Set(), chunkScore: 0, bestChunk: null };
      entry.vectorScore = Math.max(entry.vectorScore || 0, hit.score * 4.2);
      if (!entry.bestChunk || hit.score * 4.2 > (entry.bestChunk.score || 0)) {
        entry.bestChunk = { chunkId: hit.chunkId, score: hit.score * 4.2, text: hit.text, heading: hit.heading, page: hit.page };
      }
      fileScores.set(hit.fileId, entry);
    }
  }

  /* -------- 拉取实体并加权 -------- */
  const items = [];

  if (wantFiles && fileScores.size) {
    const ids = [...fileScores.keys()];
    for (const part of chunkArray(ids, 400)) {
      const rows = all(
        `SELECT f.id, f.name, f.ext, f.mime, f.size, f.folder_id, f.tags, f.starred, f.pinned,
                f.updated_at, f.created_at, f.preview_kind, f.workspace_id,
                t.text AS body, t.status AS text_status, t.page_count AS page_count
           FROM files f LEFT JOIN file_text t ON t.file_id = f.id
          WHERE f.deleted_at IS NULL AND f.id IN (${placeholdersFor(part)})`,
        ...part
      );
      for (const r of rows) {
        if (!workspaceIds.includes(r.workspace_id)) continue;
        if (acl.allowedFileIds && !acl.allowedFileIds.has(r.id)) continue;
        const sc = fileScores.get(r.id);
        if (!sc) continue;
        const rowTags = normalizeTags(r.tags);
        if (tags.length && !tags.some((t) => rowTags.some((x) => x.toLowerCase() === String(t).toLowerCase()))) continue;
        if (exts.length && !exts.includes(String(r.ext || '').toLowerCase())) continue;
        if (folderId !== undefined && folderId !== null && folderId !== 'all' && r.folder_id !== folderId) continue;
        if (starredOnly && !r.starred) continue;

        let score = sc.score + (sc.chunkScore || 0) + (sc.vectorScore || 0);
        score += titleBoost(r.name, terms);
        const matchedTags = rowTags.filter((t) => terms.some((q2) => t.toLowerCase().includes(String(q2).toLowerCase())));
        score += matchedTags.length * 0.9;
        if (r.pinned) score += 0.5;
        if (r.starred) score += 0.3;
        score += recencyBoost(r.updated_at);
        if (score <= 0) continue;

        const srcText = sc.bestChunk?.text || r.body || '';
        const { snippet } = makeSnippet(srcText, terms, { radius: 120, fallback: 220 });
        items.push({
          type: 'file',
          id: r.id,
          workspaceId: r.workspace_id,
          title: r.name,
          ext: r.ext,
          mime: r.mime,
          size: Number(r.size || 0),
          folderId: r.folder_id,
          tags: rowTags,
          starred: !!r.starred,
          pinned: !!r.pinned,
          updatedAt: r.updated_at,
          page: sc.bestChunk?.page || 0,
          heading: sc.bestChunk?.heading || '',
          previewKind: r.preview_kind,
          textStatus: r.text_status || 'pending',
          score: Number(score.toFixed(4)),
          matchedTerms: [...(sc.hits || [])].slice(0, 12),
          snippet: highlight(snippet, terms),
          snippetRaw: snippet
        });
      }
    }
  }

  if (wantNotes && noteScores.size) {
    const ids = [...noteScores.keys()];
    for (const part of chunkArray(ids, 400)) {
      const rows = all(
        `SELECT id, title, text, tags, starred, pinned, updated_at, created_at, workspace_id, folder_id, emoji, word_count
           FROM notes WHERE deleted_at IS NULL AND id IN (${placeholdersFor(part)})`,
        ...part
      );
      for (const r of rows) {
        if (!workspaceIds.includes(r.workspace_id)) continue;
        if (acl.allowedNoteIds && !acl.allowedNoteIds.has(r.id)) continue;
        const sc = noteScores.get(r.id);
        if (!sc) continue;
        const rowTags = normalizeTags(r.tags);
        if (tags.length && !tags.some((t) => rowTags.some((x) => x.toLowerCase() === String(t).toLowerCase()))) continue;
        if (folderId !== undefined && folderId !== null && folderId !== 'all' && r.folder_id !== folderId) continue;
        if (starredOnly && !r.starred) continue;
        if (exts.length) continue;

        let score = sc.score;
        score += titleBoost(r.title, terms) * 1.15;
        const matchedTags = rowTags.filter((t) => terms.some((q2) => t.toLowerCase().includes(String(q2).toLowerCase())));
        score += matchedTags.length * 0.9;
        if (r.pinned) score += 0.5;
        if (r.starred) score += 0.3;
        score += recencyBoost(r.updated_at);
        if (score <= 0) continue;

        const { snippet } = makeSnippet(r.text, terms, { radius: 120, fallback: 220 });
        items.push({
          type: 'note',
          id: r.id,
          workspaceId: r.workspace_id,
          title: r.title,
          emoji: r.emoji || '',
          tags: rowTags,
          starred: !!r.starred,
          pinned: !!r.pinned,
          updatedAt: r.updated_at,
          wordCount: Number(r.word_count || 0),
          folderId: r.folder_id,
          score: Number(score.toFixed(4)),
          matchedTerms: [...(sc.hits || [])].slice(0, 12),
          snippet: highlight(snippet, terms),
          snippetRaw: snippet
        });
      }
    }
  }

  /* -------- 模糊兜底（BM25 与向量皆无结果时走子串匹配） -------- */
  if (items.length === 0 && q.length >= 2 && mode !== 'vector') {
    const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
    if (wantFiles) {
      const rows = all(
        `SELECT f.id, f.name, f.ext, f.mime, f.size, f.folder_id, f.tags, f.starred, f.pinned, f.updated_at,
                f.workspace_id, t.text AS body, t.status AS text_status
           FROM files f JOIN file_text t ON t.file_id = f.id
          WHERE f.deleted_at IS NULL AND f.workspace_id IN (${placeholdersFor(workspaceIds)})
            AND (f.name LIKE ? ESCAPE '\\' OR t.text LIKE ? ESCAPE '\\')
          LIMIT 200`,
        ...workspaceIds, like, like
      );
      for (const r of rows) {
        if (acl.allowedFileIds && !acl.allowedFileIds.has(r.id)) continue;
        const rowTags = normalizeTags(r.tags);
        if (tags.length && !tags.some((t) => rowTags.some((x) => x.toLowerCase() === String(t).toLowerCase()))) continue;
        if (exts.length && !exts.includes(String(r.ext || '').toLowerCase())) continue;
        if (folderId && folderId !== 'all' && r.folder_id !== folderId) continue;
        if (starredOnly && !r.starred) continue;
        const titleHit = String(r.name).toLowerCase().includes(q.toLowerCase());
        const { snippet } = makeSnippet(r.body, terms.length ? terms : [q], { radius: 120, fallback: 220 });
        items.push({
          type: 'file', id: r.id, workspaceId: r.workspace_id, title: r.name, ext: r.ext, mime: r.mime,
          size: Number(r.size || 0), folderId: r.folder_id, tags: rowTags, starred: !!r.starred, pinned: !!r.pinned,
          updatedAt: r.updated_at, previewKind: null, textStatus: r.text_status,
          score: titleHit ? 1.6 : 0.9, matchedTerms: [q],
          snippet: highlight(snippet, terms.length ? terms : [q]), snippetRaw: snippet, fuzzy: true
        });
      }
    }
    if (wantNotes) {
      const rows = all(
        `SELECT id, title, text, tags, starred, pinned, updated_at, workspace_id, folder_id, emoji, word_count
           FROM notes WHERE deleted_at IS NULL AND workspace_id IN (${placeholdersFor(workspaceIds)})
            AND (title LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')
          LIMIT 200`,
        ...workspaceIds, like, like
      );
      for (const r of rows) {
        if (acl.allowedNoteIds && !acl.allowedNoteIds.has(r.id)) continue;
        const rowTags = normalizeTags(r.tags);
        if (tags.length && !tags.some((t) => rowTags.some((x) => x.toLowerCase() === String(t).toLowerCase()))) continue;
        if (folderId && folderId !== 'all' && r.folder_id !== folderId) continue;
        if (starredOnly && !r.starred) continue;
        const titleHit = String(r.title).toLowerCase().includes(q.toLowerCase());
        const { snippet } = makeSnippet(r.text, terms.length ? terms : [q], { radius: 120, fallback: 220 });
        items.push({
          type: 'note', id: r.id, workspaceId: r.workspace_id, title: r.title, emoji: r.emoji || '',
          tags: rowTags, starred: !!r.starred, pinned: !!r.pinned, updatedAt: r.updated_at,
          wordCount: Number(r.word_count || 0), folderId: r.folder_id,
          score: titleHit ? 1.6 : 0.9, matchedTerms: [q],
          snippet: highlight(snippet, terms.length ? terms : [q]), snippetRaw: snippet, fuzzy: true
        });
      }
    }
  }

  items.sort((a, b) => b.score - a.score || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  const total = items.length;
  const page = items.slice(offset, offset + limit);

  return {
    total,
    items: page,
    mode,
    terms,
    tokens,
    took: Date.now() - started,
    vectorUsed: vectorUsed.length
  };
}

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out.length ? out : [[]];
}

/* ------------------------------------------------------------------ 搜索建议 */

export function suggest(workspaceIds, prefix, limit = 8) {
  const p = String(prefix || '').trim();
  if (!p) return { terms: [], titles: [] };
  const like = `%${p.replace(/[%_]/g, (c) => '\\' + c)}%`;
  const ph = placeholdersFor(workspaceIds);
  const titles = all(
    `SELECT name AS title, 'file' AS type, id, updated_at FROM files
      WHERE deleted_at IS NULL AND workspace_id IN (${ph}) AND name LIKE ? ESCAPE '\\'
     UNION ALL
     SELECT title, 'note' AS type, id, updated_at FROM notes
      WHERE deleted_at IS NULL AND workspace_id IN (${ph}) AND title LIKE ? ESCAPE '\\'
     ORDER BY updated_at DESC LIMIT ?`,
    ...workspaceIds, like, ...workspaceIds, like, limit
  );
  const tagRows = all(
    `SELECT name FROM tags WHERE workspace_id IN (${ph}) AND name LIKE ? ESCAPE '\\' LIMIT ?`,
    ...workspaceIds, like, limit
  );
  return {
    titles: titles.map((r) => ({ title: r.title, type: r.type, id: r.id })),
    terms: tagRows.map((r) => r.name)
  };
}

/* ------------------------------------------------------------------ 标签云 */

export function tagCloud(workspaceIds) {
  if (!workspaceIds.length) return [];
  const ph = placeholdersFor(workspaceIds);
  return all(
    `SELECT t.name, t.color,
            (SELECT COUNT(*) FROM entity_tags et WHERE et.tag_id = t.id) AS count
       FROM tags t
      WHERE t.workspace_id IN (${ph})
      ORDER BY count DESC, t.name ASC`,
    ...workspaceIds
  ).map((r) => ({ name: r.name, color: r.color || '', count: Number(r.count || 0) }));
}

/* ------------------------------------------------------------------ 知识关联 */

/** 基于向量相似度发现"相关知识" */
export function relatedFiles(workspaceIds, fileId, limit = 6, acl = null) {
  const self = get(`SELECT id, workspace_id FROM files WHERE id=?`, fileId);
  if (!self) return [];
  const ph = placeholdersFor(workspaceIds);
  const mine = all(
    `SELECT v.vec, v.dim FROM chunk_vectors v JOIN chunks c ON c.id=v.chunk_id
      WHERE c.file_id=? LIMIT 24`, fileId
  );
  if (!mine.length) return [];
  const dim = mine[0].dim;
  const myVecs = mine.map((r) => unpackVec(r.vec, dim));
  const centroid = new Float32Array(dim);
  for (const v of myVecs) for (let i = 0; i < dim; i++) centroid[i] += v[i] / myVecs.length;

  const rows = all(
    `SELECT c.file_id, f.name, f.ext, v.vec, v.dim
       FROM chunk_vectors v
       JOIN chunks c ON c.id = v.chunk_id
       JOIN files f ON f.id = c.file_id
      WHERE c.workspace_id IN (${ph}) AND c.file_id <> ? AND f.deleted_at IS NULL`,
    ...workspaceIds, fileId
  );
  const best = new Map();
  for (const r of rows) {
    const vec = unpackVec(r.vec, r.dim);
    if (vec.length !== dim) continue;
    let dot = 0;
    for (let i = 0; i < dim; i++) dot += vec[i] * centroid[i];
    const prev = best.get(r.file_id);
    if (!prev || dot > prev.score) best.set(r.file_id, { fileId: r.file_id, name: r.name, ext: r.ext, score: dot });
  }
  const allowed = acl && acl.allowedFileIds ? acl.allowedFileIds : null;
  return [...best.values()]
    .filter((r) => !allowed || allowed.has(r.fileId))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
