/**
 * KBPRO — 文档处理流水线
 *  上传落盘 → 内容抽取（PDF/Word/Excel/PPT/TXT/MD…）→ 结构化 → 分块 → 向量化 → 倒排索引 → 事件通知
 *  带并发限流的后台队列，避免大批量上传时打爆内存。
 */
import { get, all, run, nowIso, insert, update } from '../db.js';
import { readStored } from './storage.js';
import { extractDocument, detectPreviewKind } from './extract.js';
import { indexFile, removeFileIndex } from './rag.js';
import { syncTags } from './tags.js';
import { publishWorkspace, publishResource } from './bus.js';
import { normalizeTags } from './text.js';

const CONCURRENCY = Math.max(1, Number(process.env.KBPRO_INDEX_CONCURRENCY || 2));
const queue = [];
const inflight = new Set();

/* ------------------------------------------------------------------ 队列 */

export function enqueueIndex(fileId, { force = false, priority = false } = {}) {
  if (!fileId) return;
  if (inflight.has(fileId)) return;
  const existing = queue.findIndex((j) => j.fileId === fileId);
  if (existing >= 0) queue.splice(existing, 1);
  const job = { fileId, force };
  if (priority) queue.unshift(job);
  else queue.push(job);
  pump();
}

export function queueState() {
  return { pending: queue.length, running: inflight.size, concurrency: CONCURRENCY };
}

function pump() {
  while (inflight.size < CONCURRENCY && queue.length) {
    const job = queue.shift();
    if (!job || inflight.has(job.fileId)) continue;
    inflight.add(job.fileId);
    processFile(job.fileId, job)
      .catch(() => { /* 内部已记录状态 */ })
      .finally(() => {
        inflight.delete(job.fileId);
        pump();
      });
  }
}

/* ------------------------------------------------------------------ 主流程 */

export async function processFile(fileId, { force = false } = {}) {
  const file = get(`SELECT * FROM files WHERE id=?`, fileId);
  if (!file || file.deleted_at) return { ok: false, reason: 'not-found' };

  const existing = get(`SELECT * FROM file_text WHERE file_id=?`, fileId);
  if (!force && existing && (existing.status === 'ok' || existing.status === 'processing')) {
    if (existing.status === 'ok') return { ok: true, cached: true, chunks: 0 };
  }

  const started = Date.now();
  run(
    `INSERT INTO file_text(file_id, workspace_id, text, html, status, error, page_count, chars, meta, engine, extract_ms, updated_at)
     VALUES(?,?,'','','processing','',0,0,'{}','',0,?)
     ON CONFLICT(file_id) DO UPDATE SET status='processing', error='', updated_at=excluded.updated_at`,
    fileId, file.workspace_id, nowIso()
  );
  publishWorkspace(file.workspace_id, { type: 'file.processing', fileId, name: file.name });

  try {
    const kind = detectPreviewKind(file.ext, file.mime);
    let result = {
      ok: false, text: '', html: '', pages: [], pageCount: 0, meta: {}, engine: 'none',
      warning: '该格式暂不支持内容解析', previewKind: kind
    };

    if (!['binary', 'image', 'audio', 'video', 'archive'].includes(kind)) {
      const buf = await readStored(file.storage_key, !!file.encrypted);
      result = await extractDocument(buf, { ext: file.ext, mime: file.mime, name: file.name });
    }

    const text = String(result.text || '');
    const status = result.ok && text.trim() ? 'ok' : (result.ok ? 'empty' : 'failed');

    // 1) 保存抽取结果
    run(
      `UPDATE file_text SET text=?, html=?, status=?, error=?, page_count=?, chars=?, meta=?, engine=?, extract_ms=?, updated_at=?
       WHERE file_id=?`,
      text.slice(0, 8 * 1024 * 1024), String(result.html || '').slice(0, 8 * 1024 * 1024),
      status, String(result.warning || '').slice(0, 800),
      Number(result.pageCount || result.pages?.length || 0), text.length,
      JSON.stringify({ ...(result.meta || {}), warning: result.warning || '', previewKind: result.previewKind || kind }),
      result.engine || '', Date.now() - started, nowIso(), fileId
    );

    // 2) 建立检索索引（分块 + 向量 + BM25）
    let indexInfo = { chunks: 0, keywords: [] };
    if (text.trim()) {
      try {
        indexInfo = indexFile({
          fileId,
          workspaceId: file.workspace_id,
          title: file.name,
          text,
          pages: result.pages && result.pages.length ? result.pages : undefined,
          tags: normalizeTags(file.tags)
        });
      } catch (err) {
        run(`UPDATE file_text SET error=? WHERE file_id=?`, `索引失败：${err.message}`.slice(0, 500), fileId);
      }
    } else {
      removeFileIndex(fileId);
    }

    // 3) 更新文件元数据
    update('files', fileId, {
      preview_kind: result.previewKind || kind,
      updated_at: file.updated_at || nowIso()
    });

    // 4) 标签同步（解析出的关键词作为标签候选由用户决定，不自动写入）
    syncTags(file.workspace_id, 'file', fileId, normalizeTags(file.tags), file.created_by);

    const payload = {
      type: 'file.indexed',
      fileId,
      workspaceId: file.workspace_id,
      name: file.name,
      status,
      pages: Number(result.pageCount || 0),
      chars: text.length,
      chunks: indexInfo.chunks,
      warning: result.warning || '',
      engine: result.engine || '',
      ms: Date.now() - started
    };
    publishWorkspace(file.workspace_id, payload);
    publishResource('file', fileId, payload);
    if (file.created_by) publishWorkspace(file.workspace_id, { ...payload, type: 'notify' });

    return { ok: status === 'ok', status, pages: payload.pages, chunks: indexInfo.chunks, chars: text.length, warning: result.warning, ms: payload.ms };
  } catch (err) {
    run(
      `UPDATE file_text SET status='failed', error=?, updated_at=? WHERE file_id=?`,
      `解析异常：${err?.message || String(err)}`.slice(0, 500), nowIso(), fileId
    );
    publishWorkspace(file.workspace_id, { type: 'file.failed', fileId, name: file.name, error: err?.message || String(err) });
    return { ok: false, status: 'failed', error: err?.message || String(err) };
  }
}

/** 等待队列空闲（测试用） */
export async function drainQueue(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while ((queue.length || inflight.size) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 60));
  }
  return queueState();
}

/** 批量重建索引 */
export async function reindexWorkspaceFiles(workspaceId, { onProgress } = {}) {
  const rows = all(`SELECT id FROM files WHERE workspace_id=? AND deleted_at IS NULL ORDER BY created_at`, workspaceId);
  let done = 0;
  for (const f of rows) {
    await processFile(f.id, { force: true });
    done++;
    onProgress?.({ done, total: rows.length, fileId: f.id });
  }
  return { total: rows.length, done };
}

export { queueState as indexQueueState };
