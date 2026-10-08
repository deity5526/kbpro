/**
 * KBPRO — 路由：RAG 智能问答 / 文档智能解析 / 会话 / 知识图谱 / 备份恢复 / 审计
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  all, get, run, insert, update, tx, nowIso, audit, scalar, getSetting, setSetting
} from '../db.js';
import { randomId } from '../lib/crypto.js';
import { httpError, sendJson, clientIp, contentDisposition, formatBytes, sseStart, sseSend } from '../lib/http.js';
import { loadConfig } from '../config.js';
import { requireUser, requireAdmin, requireWorkspace, requireResource, accessibleWorkspaces, buildSearchAcl, permAtLeast } from '../auth.js';
import { askKnowledgeBase, analyzeDocument, compareDocuments, retrieveContexts, reembedWorkspace, reindexChunkTerms } from '../lib/rag.js';
import { probeAi, resolveAiConfig } from '../lib/ai.js';
import { enqueueIndex, processFile, reindexWorkspaceFiles, queueState } from '../lib/pipeline.js';
import { publishWorkspace } from '../lib/bus.js';
import { normalizeTags, truncate, escapeHtml, tokenize } from '../lib/text.js';
import { unpackVec, cosine, kmeans, LOCAL_DIM } from '../lib/vector.js';
import { relatedFiles } from '../lib/search.js';
import {
  createBackup, listBackups, deleteBackup, openBackup, inspectBackup, restoreBackup, exportWorkspace
} from '../lib/backup.js';
import { BACKUP_DIR } from '../config.js';

function str(v, def = '', max = 500) {
  if (v === undefined || v === null) return def;
  return String(v).slice(0, max);
}
function int(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : def;
}
function bool(v, def = false) {
  if (v === undefined || v === null) return def;
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

export function registerAiRoutes(router) {

  /* ============================== 状态 ============================== */

  router.get('/api/ai/status', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const status = await probeAi(user);
    const conf = resolveAiConfig(user);
    let indexed = 0;
    let pending = 0;
    let failed = 0;
    const wsIds = accessibleWorkspaces(user.id).map((w) => w.id);
    if (wsIds.length) {
      const ph = wsIds.map(() => '?').join(',');
      indexed = Number(scalar(`SELECT COUNT(*) FROM file_text WHERE workspace_id IN (${ph}) AND status='ok'`, ...wsIds) || 0);
      pending = Number(scalar(`SELECT COUNT(*) FROM file_text WHERE workspace_id IN (${ph}) AND status IN ('pending','processing')`, ...wsIds) || 0);
      failed = Number(scalar(`SELECT COUNT(*) FROM file_text WHERE workspace_id IN (${ph}) AND status='failed'`, ...wsIds) || 0);
    }
    sendJson(res, 200, {
      ok: true,
      status,
      // effective 反映「实际生效」的提供商（考虑自动降级），前端据此决定提示文案
      effective: {
        provider: status.provider,
        model: status.model,
        embedModel: conf.embedModel,
        baseUrl: status.baseUrl || conf.baseUrl
      },
      configured: { provider: conf.provider, model: conf.chatModel, baseUrl: conf.baseUrl },
      index: { indexed, pending, failed, queue: queueState() }
    });
  });

  /* ============================== 智能问答 ============================== */

  /**
   * RAG 问答。默认流式（SSE 风格的 text/event-stream），客户端用 fetch 读取。
   * body: { question, workspaceId, chatId?, fileIds?, topK?, stream? }
   */
  router.post('/api/ai/ask', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const body = ctx.body || {};
    const question = str(body.question, '', 4000).trim();
    if (!question) throw httpError(400, '请输入问题');

    let workspaceIds = [];
    if (body.workspaceId && body.workspaceId !== 'all') {
      requireWorkspace(user.id, body.workspaceId, 'view');
      workspaceIds = [body.workspaceId];
    } else {
      workspaceIds = accessibleWorkspaces(user.id).map((w) => w.id);
    }
    if (!workspaceIds.length) throw httpError(400, '没有可访问的知识库');
    const acl = buildSearchAcl(user.id, workspaceIds);

    // 会话
    let chatId = body.chatId ? str(body.chatId, '', 80) : '';
    let chat = chatId ? get(`SELECT * FROM chats WHERE id=? AND user_id=?`, chatId, user.id) : null;
    if (!chat) {
      chatId = randomId('chat');
      const now = nowIso();
      insert('chats', {
        id: chatId, workspace_id: body.workspaceId && body.workspaceId !== 'all' ? body.workspaceId : workspaceIds[0],
        user_id: user.id, title: truncate(question, 40), scope: body.fileIds?.length ? 'files' : 'workspace',
        scope_id: body.fileIds?.length ? body.fileIds.join(',') : null,
        provider: '', model: '', pinned: 0, created_at: now, updated_at: now
      });
      chat = get(`SELECT * FROM chats WHERE id=?`, chatId);
    } else {
      update('chats', chatId, { updated_at: nowIso() });
    }

    const history = all(
      `SELECT role, content FROM messages WHERE chat_id=? ORDER BY created_at ASC LIMIT 20`, chatId
    );

    insert('messages', {
      id: randomId('msg'), chat_id: chatId, role: 'user', content: question,
      citations: '[]', provider: '', model: '', latency_ms: 0, feedback: 0, created_at: nowIso()
    });

    const stream = body.stream !== false;
    const fileIds = Array.isArray(body.fileIds) && body.fileIds.length ? body.fileIds.slice(0, 50) : null;
    const topK = Math.min(20, int(body.topK, loadConfig().ragTopK || 8));

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    if (!stream) {
      const result = await askKnowledgeBase({
        question, workspaceIds, userRow: user, history, topK, fileIds, acl, signal: controller.signal
      });
      persistAssistantMessage(chatId, result, user);
      return sendJson(res, 200, {
        ok: true, chatId, answer: result.content, citations: result.citations,
        provider: result.provider, model: result.model, fallback: result.fallback,
        general: !!result.general, error: result.error || '', ms: result.ms, contexts: result.contexts.map(publicContext)
      });
    }

    /* ---- 流式 ---- */
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(`retry: 3000\n\n`);
    sseSend(res, 'start', { chatId, question, at: nowIso() });

    // 先推送检索到的引用，让前端立刻呈现"依据"
    const contexts = retrieveContexts({ workspaceIds, query: question, topK, fileIds, acl });
    const citations = contexts.map((c, i) => ({
      index: i + 1, fileId: c.fileId, chunkId: c.chunkId, title: c.title, ext: c.ext,
      page: c.page, heading: c.heading, score: c.score, snippet: truncate(c.text, 260)
    }));
    sseSend(res, 'contexts', { citations, count: citations.length });

    let answer = '';
    try {
      const result = await askKnowledgeBase({
        question, workspaceIds, userRow: user, history, topK, fileIds, acl,
        signal: controller.signal,
        onToken: (piece) => {
          answer += piece;
          sseSend(res, 'token', { text: piece });
        }
      });
      answer = result.content || answer;
      const saved = persistAssistantMessage(chatId, { ...result, content: answer }, user);
      sseSend(res, 'done', {
        chatId, messageId: saved.id,
        citations: result.citations?.length ? result.citations : citations,
        provider: result.provider, model: result.model,
        fallback: !!result.fallback, general: !!result.general, error: result.error || '', ms: result.ms
      });
      publishWorkspace(chat.workspace_id, { type: 'chat.updated', chatId });
    } catch (err) {
      sseSend(res, 'error', { message: err?.message || '生成失败' });
    } finally {
      res.end();
    }
  });

  /* ============================== 会话管理 ============================== */

  router.get('/api/chats', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const workspaceId = str(ctx.query.workspaceId && ctx.query.workspaceId !== 'all' ? ctx.query.workspaceId : '', '', 80);
    const rows = all(
      `SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id) AS msg_count,
              (SELECT content FROM messages m WHERE m.chat_id=c.id AND m.role='assistant' ORDER BY m.created_at DESC LIMIT 1) AS last_answer
         FROM chats c WHERE c.user_id=? ${workspaceId ? 'AND c.workspace_id=?' : ''}
        ORDER BY c.pinned DESC, c.updated_at DESC LIMIT 100`,
      ...(workspaceId ? [user.id, workspaceId] : [user.id])
    );
    sendJson(res, 200, { ok: true, chats: rows.map((c) => ({ ...c, last_answer: truncate(c.last_answer || '', 80) })) });
  });

  router.get('/api/chats/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const chat = get(`SELECT * FROM chats WHERE id=? AND user_id=?`, ctx.params.id, user.id);
    if (!chat) throw httpError(404, '会话不存在');
    const messages = all(`SELECT * FROM messages WHERE chat_id=? ORDER BY created_at ASC`, chat.id).map((m) => {
      const meta = (() => { try { return JSON.parse(m.meta || '{}'); } catch { return {}; } })();
      return {
        id: m.id, role: m.role, content: m.content,
        citations: (() => { try { return JSON.parse(m.citations || '[]'); } catch { return []; } })(),
        provider: m.provider, model: m.model, latencyMs: Number(m.latency_ms || 0),
        feedback: Number(m.feedback || 0), createdAt: m.created_at,
        general: !!meta.general, noContext: !!meta.noContext, interrupted: !!meta.interrupted
      };
    });
    sendJson(res, 200, { ok: true, chat, messages });
  });

  router.patch('/api/chats/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const chat = get(`SELECT * FROM chats WHERE id=? AND user_id=?`, ctx.params.id, user.id);
    if (!chat) throw httpError(404, '会话不存在');
    const patch = { updated_at: nowIso() };
    if (ctx.body?.title !== undefined) patch.title = str(ctx.body.title, '', 120);
    if (ctx.body?.pinned !== undefined) patch.pinned = bool(ctx.body.pinned) ? 1 : 0;
    update('chats', chat.id, patch);
    sendJson(res, 200, { ok: true });
  });

  router.delete('/api/chats/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const chat = get(`SELECT * FROM chats WHERE id=? AND user_id=?`, ctx.params.id, user.id);
    if (!chat) throw httpError(404, '会话不存在');
    tx((d) => {
      d.prepare(`DELETE FROM messages WHERE chat_id=?`).run(chat.id);
      d.prepare(`DELETE FROM chats WHERE id=?`).run(chat.id);
    });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/messages/:id/feedback', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const msg = get(
      `SELECT m.* FROM messages m JOIN chats c ON c.id=m.chat_id WHERE m.id=? AND c.user_id=?`,
      ctx.params.id, user.id
    );
    if (!msg) throw httpError(404, '消息不存在');
    update('messages', msg.id, { feedback: int(ctx.body?.feedback, 0) });
    sendJson(res, 200, { ok: true });
  });

  /* ============================== 文档智能解析 ============================== */

  router.post('/api/ai/analyze', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { fileId, kind = 'all', style = 'paragraph', save = true } = ctx.body || {};
    if (!fileId) throw httpError(400, '缺少 fileId');
    const file = get(`SELECT * FROM files WHERE id=? AND deleted_at IS NULL`, fileId);
    if (!file) throw httpError(404, '文件不存在');
    requireResource(user.id, 'file', fileId, 'view');

    const t = get(`SELECT * FROM file_text WHERE file_id=?`, fileId);
    if (!t?.text) {
      // 即时解析一次
      await processFile(fileId, { force: !t });
    }
    const fresh = get(`SELECT * FROM file_text WHERE file_id=?`, fileId);
    if (!fresh?.text) throw httpError(400, '该文件尚未解析出文本内容，无法生成摘要');

    const result = await analyzeDocument({ text: fresh.text, title: file.name, kind, userRow: user, style });

    if (save) {
      const rows = [];
      for (const key of ['summary', 'outline', 'keywords']) {
        const content = result.generated?.[key] || result.local?.[key]?.content || '';
        if (!content) continue;
        const id = randomId('aio');
        insert('ai_outputs', {
          id, workspace_id: file.workspace_id, file_id: fileId, note_id: null, kind: key,
          content, provider: result.generated?.[key] ? result.provider : 'local',
          model: result.generated?.[key] ? result.model : 'local-extractive',
          status: 'ok', error: '', created_by: user.id, created_at: nowIso()
        });
        rows.push({ id, kind: key, content });
      }
      if (result.local?.summary?.content) update('files', fileId, { updated_at: file.updated_at });
      audit({ workspaceId: file.workspace_id, userId: user.id, userName: user.name, action: 'ai.analyze', resourceType: 'file', resourceId: fileId, resourceName: file.name, detail: kind });
      return sendJson(res, 200, { ok: true, result, saved: rows });
    }
    sendJson(res, 200, { ok: true, result, saved: [] });
  });

  router.get('/api/files/:id/analysis', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const file = get(`SELECT * FROM files WHERE id=?`, ctx.params.id);
    if (!file) throw httpError(404, '文件不存在');
    requireResource(user.id, 'file', ctx.params.id, 'view');
    const rows = all(
      `SELECT * FROM ai_outputs WHERE file_id=? ORDER BY created_at DESC LIMIT 40`, ctx.params.id
    );
    const latest = {};
    for (const r of rows) if (!latest[r.kind]) latest[r.kind] = r;
    sendJson(res, 200, {
      ok: true,
      latest: Object.fromEntries(Object.entries(latest).map(([k, v]) => [k, { id: v.id, content: v.content, provider: v.provider, model: v.model, createdAt: v.created_at }])),
      history: rows.map((r) => ({ id: r.id, kind: r.kind, provider: r.provider, model: r.model, createdAt: r.created_at, chars: r.content.length }))
    });
  });

  router.post('/api/ai/compare', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { fileIds = [] } = ctx.body || {};
    if (!Array.isArray(fileIds) || fileIds.length < 2) throw httpError(400, '至少选择 2 个文件进行对比');
    const docs = [];
    for (const id of fileIds.slice(0, 6)) {
      const f = get(`SELECT * FROM files WHERE id=? AND deleted_at IS NULL`, id);
      if (!f) continue;
      requireResource(user.id, 'file', id, 'view');
      const t = get(`SELECT text FROM file_text WHERE file_id=?`, id);
      docs.push({ id: f.id, title: f.name, text: t?.text || '' });
    }
    if (docs.length < 2) throw httpError(400, '可用的文档不足 2 个（需已解析出文本）');
    const result = await compareDocuments({ docs, userRow: user });
    sendJson(res, 200, { ok: true, result, docs: docs.map((d) => ({ id: d.id, title: d.title, chars: d.text.length })) });
  });

  router.post('/api/ai/expand', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { topic, workspaceId, fileIds = [] } = ctx.body || {};
    const q = str(topic, '', 400).trim();
    if (!q) throw httpError(400, '请输入主题');
    const workspaceIds = workspaceId && workspaceId !== 'all'
      ? [workspaceId] : accessibleWorkspaces(user.id).map((w) => w.id);
    requireWorkspace(user.id, workspaceIds[0], 'view');
    const acl = buildSearchAcl(user.id, workspaceIds);
    const contexts = retrieveContexts({ workspaceIds, query: q, topK: 8, fileIds: fileIds.length ? fileIds : null, acl });
    const { localExpand } = await import('../lib/localai.js');
    const base = localExpand(q, contexts);
    let generated = '';
    const conf = resolveAiConfig(user);
    if (conf.provider !== 'local') {
      try {
        const { chatCompletion } = await import('../lib/ai.js');
        const r = await chatCompletion({
          userRow: user,
          messages: [
            { role: 'system', content: '你是知识管理专家。基于给定的知识片段，围绕主题做知识拓展：关联概念、延伸问题、应用场景、潜在风险。使用 Markdown，不得编造片段中不存在的事实。' },
            { role: 'user', content: `【主题】${q}\n\n【知识片段】\n${contexts.map((c, i) => `[${i + 1}] 《${c.title}》\n${c.text}`).join('\n\n---\n\n')}` }
          ],
          maxTokens: 1600
        });
        generated = r.content;
      } catch { /* 回退本地 */ }
    }
    sendJson(res, 200, { ok: true, local: base, generated, contexts: contexts.map(publicContext) });
  });

  router.post('/api/ai/reindex', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { workspaceId, embed = false, fileIds } = ctx.body || {};
    if (!workspaceId) throw httpError(400, '缺少 workspaceId');
    requireWorkspace(user.id, workspaceId, 'edit');

    if (Array.isArray(fileIds) && fileIds.length) {
      const owned = new Set(
        all(`SELECT id FROM files WHERE workspace_id=? AND deleted_at IS NULL`, workspaceId).map((r) => r.id)
      );
      const scoped = fileIds.filter((id) => owned.has(id)).slice(0, 200);
      for (const id of scoped) enqueueIndex(id, { force: true, priority: true });
      return sendJson(res, 202, { ok: true, queued: scoped.length, queue: queueState() });
    }

    if (!embed) {
      // 仅重建倒排/分块索引（后台串行）
      const rows = all(`SELECT id FROM files WHERE workspace_id=? AND deleted_at IS NULL`, workspaceId);
      for (const r of rows) enqueueIndex(r.id, { force: true });
      return sendJson(res, 202, { ok: true, queued: rows.length, queue: queueState() });
    }

    // 使用大模型 embedding 重建向量
    const result = await reembedWorkspace(workspaceId, user, {});
    audit({ workspaceId, userId: user.id, userName: user.name, action: 'ai.reembed', resourceType: 'workspace', resourceId: workspaceId, detail: `${result.updated} chunks · ${result.provider}/${result.model}` });
    sendJson(res, 200, { ok: true, ...result });
  });

  /* ============================== 知识图谱 / 关联 ============================== */

  router.get('/api/workspaces/:id/graph', async (req, res, ctx) => {
    const user = ctx.requireUser();
    requireWorkspace(user.id, ctx.params.id, 'view');
    const wsId = ctx.params.id;
    const limit = Math.max(1, Math.min(80, int(ctx.query.limit, 45)));

    const acl = buildSearchAcl(user.id, [wsId]);
    const fileScope = acl.allowedFileIds
      ? ` AND id IN (${[...acl.allowedFileIds].map(() => '?').join(',') || "''"})` : '';
    const files = all(
      `SELECT id, name, ext, size, updated_at, tags, folder_id FROM files
        WHERE workspace_id=? AND deleted_at IS NULL${fileScope} ORDER BY updated_at DESC LIMIT ?`,
      wsId, ...(acl.allowedFileIds ? [...acl.allowedFileIds] : []), limit
    );
    const nodes = [];
    const vectors = [];
    for (const f of files) {
      const rows = all(
        `SELECT v.vec, v.dim FROM chunk_vectors v JOIN chunks c ON c.id=v.chunk_id WHERE c.file_id=? LIMIT 10`, f.id
      );
      if (!rows.length) continue;
      const dim = rows[0].dim;
      const centroid = new Float32Array(dim);
      for (const r of rows) {
        const v = unpackVec(r.vec, r.dim);
        for (let i = 0; i < dim; i++) centroid[i] += v[i] / rows.length;
      }
      nodes.push({
        id: f.id, label: f.name, ext: f.ext, size: Number(f.size || 0),
        tags: normalizeTags(f.tags), updatedAt: f.updated_at, folderId: f.folder_id
      });
      vectors.push(centroid);
    }

    const edges = [];
    for (let i = 0; i < vectors.length; i++) {
      const scored = [];
      for (let j = 0; j < vectors.length; j++) {
        if (i === j) continue;
        const s = cosine(vectors[i], vectors[j]);
        if (s > 0.18) scored.push({ j, s });
      }
      scored.sort((a, b) => b.s - a.s);
      for (const { j, s } of scored.slice(0, 3)) {
        if (i < j) edges.push({ source: nodes[i].id, target: nodes[j].id, weight: Number(s.toFixed(3)) });
      }
    }

    let clusters = [];
    if (vectors.length >= 3) {
      const k = Math.max(2, Math.min(5, Math.round(Math.sqrt(vectors.length / 2))));
      const km = kmeans(vectors, k, 14);
      clusters = km.centroids.map((_, idx) => ({
        id: idx,
        members: nodes.filter((_, n) => km.assignments[n] === idx).map((n) => n.id),
        label: ''
      })).filter((c) => c.members.length);
      for (const c of clusters) {
        const memberNames = nodes.filter((n) => c.members.includes(n.id)).map((n) => n.label);
        c.label = memberNames.length ? truncate(memberNames[0].replace(/\.[a-z0-9]+$/i, ''), 18) : `主题 ${c.id + 1}`;
      }
    }

    sendJson(res, 200, { ok: true, nodes, edges, clusters, note: edges.length ? '' : '索引数据不足，上传并解析更多文档后可生成关联图谱' });
  });

  /* ============================== 备份 / 恢复 / 导出 ============================== */

  router.get('/api/backups', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const rows = listBackups();
    const visible = user.role === 'admin' ? rows : rows.filter((b) => b.createdBy === user.id);
    const total = visible.reduce((s, b) => s + b.size, 0);
    sendJson(res, 200, { ok: true, backups: visible, total, totalText: formatBytes(total) });
  });

  router.post('/api/backups', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { kind = 'full', workspaceId, password, note = '', encrypt = false } = ctx.body || {};
    if (!['full', 'metadata', 'workspace'].includes(kind)) throw httpError(400, 'kind 不合法');
    if (kind === 'workspace') {
      if (!workspaceId) throw httpError(400, '缺少 workspaceId');
      requireWorkspace(user.id, workspaceId, 'view');
    } else if (user.role !== 'admin') {
      throw httpError(403, '全量备份需要管理员权限');
    }
    const pwd = encrypt ? String(password || '').trim() : '';
    if (encrypt && pwd.length < 6) throw httpError(400, '备份口令至少 6 位');

    const result = await createBackup({ kind, workspaceId, password: pwd || undefined, userId: user.id, note });
    audit({ workspaceId: workspaceId || null, userId: user.id, userName: user.name, action: 'backup.create', resourceType: 'backup', resourceId: result.id, resourceName: result.name, detail: `${kind} ${formatBytes(result.size)}${encrypt ? ' encrypted' : ''}` });
    sendJson(res, 201, {
      ok: true,
      backup: { id: result.id, name: result.name, size: result.size, sizeText: formatBytes(result.size), kind, encrypted: result.encrypted, checksum: result.checksum, ms: result.ms }
    });
  });

  router.get('/api/backups/:id/download', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const row = get(`SELECT * FROM backups WHERE id=?`, ctx.params.id);
    if (!row) throw httpError(404, '备份不存在');
    if (user.role !== 'admin' && row.created_by !== user.id) throw httpError(403, '无权下载该备份');
    const buf = await fsp.readFile(row.path).catch(() => null);
    if (!buf) throw httpError(404, '备份文件已丢失');
    audit({ userId: user.id, userName: user.name, action: 'backup.download', resourceType: 'backup', resourceId: row.id, resourceName: row.name });
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': contentDisposition(row.name, 'attachment'),
      'Content-Length': buf.length
    });
    res.end(buf);
  });

  router.delete('/api/backups/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const row = get(`SELECT * FROM backups WHERE id=?`, ctx.params.id);
    if (!row) throw httpError(404, '备份不存在');
    if (user.role !== 'admin' && row.created_by !== user.id) throw httpError(403, '无权删除该备份');
    deleteBackup(row.id);
    audit({ userId: user.id, userName: user.name, action: 'backup.delete', resourceType: 'backup', resourceId: row.id, resourceName: row.name });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/backups/:id/restore', async (req, res, ctx) => {
    const user = ctx.requireUser();
    if (user.role !== 'admin') throw httpError(403, '恢复备份需要管理员权限');
    const row = get(`SELECT * FROM backups WHERE id=?`, ctx.params.id);
    if (!row) throw httpError(404, '备份不存在');
    const { password, mode = 'merge' } = ctx.body || {};
    const result = await restoreBackup({ filePath: row.path, password, userId: user.id, mode });
    audit({ userId: user.id, userName: user.name, action: 'backup.restore', resourceType: 'backup', resourceId: row.id, resourceName: row.name, detail: JSON.stringify(result.counts || { mode }) });
    sendJson(res, 200, { ok: true, result });
  });

  router.post('/api/backups/upload-restore', async (req, res, ctx) => {
    // 上传备份包并恢复（multipart）；谨慎操作，要求管理员
    const user = ctx.requireUser();
    if (user.role !== 'admin') throw httpError(403, '恢复备份需要管理员权限');
    const { isMultipart } = await import('../lib/multipart.js');
    const { parseMultipart } = await import('../lib/multipart.js');
    if (!isMultipart(req)) throw httpError(400, '请上传备份文件');
    const parsed = await parseMultipart(req, { tmpDir: path.join(BACKUP_DIR, 'tmp'), maxBytes: 4 * 1024 * 1024 * 1024 });
    const f = parsed.files[0];
    if (!f) throw httpError(400, '没有接收到文件');
    const password = parsed.fields.password || '';
    try {
      const result = await restoreBackup({ filePath: f.tmpPath, password, userId: user.id, mode: parsed.fields.mode || 'merge' });
      sendJson(res, 200, { ok: true, result });
    } finally {
      await fsp.unlink(f.tmpPath).catch(() => {});
    }
  });

  router.get('/api/workspaces/:id/export', async (req, res, ctx) => {
    const user = ctx.requireUser();
    requireWorkspace(user.id, ctx.params.id, 'view');
    const includeFiles = req.url.includes('includeFiles=0') ? false : true;
    const { buffer, name, entries } = await exportWorkspace(ctx.params.id, { includeFiles, userId: user.id });
    audit({ workspaceId: ctx.params.id, userId: user.id, userName: user.name, action: 'workspace.export', resourceType: 'workspace', resourceId: ctx.params.id, detail: `${entries} entries` });
    const filename = name.endsWith('.zip') ? name : `${name}.zip`;
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': contentDisposition(filename, 'attachment'),
      'Content-Length': buffer.length
    });
    res.end(buffer);
  });

  /* ============================== 审计日志 ============================== */

  router.get('/api/logs', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const limit = Math.max(1, Math.min(500, int(ctx.query.limit, 120)));
    const offset = Math.max(0, int(ctx.query.offset, 0));
    const where = [];
    const params = [];
    if (user.role !== 'admin') {
      where.push('user_id = ?');
      params.push(user.id);
    }
    if (ctx.query.workspaceId && ctx.query.workspaceId !== 'all') { where.push('workspace_id = ?'); params.push(ctx.query.workspaceId); }
    if (ctx.query.action) { where.push('action LIKE ?'); params.push(`%${ctx.query.action}%`); }
    if (ctx.query.q) {
      where.push('(resource_name LIKE ? OR user_name LIKE ? OR detail LIKE ?)');
      const like = `%${ctx.query.q}%`;
      params.push(like, like, like);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(scalar(`SELECT COUNT(*) FROM access_logs ${whereSql}`, ...params) || 0);
    const rows = all(
      `SELECT * FROM access_logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, ...params, limit, offset
    );
    const actions = all(
      `SELECT action, COUNT(*) AS n FROM access_logs ${user.role === 'admin' ? '' : 'WHERE user_id = ?'} GROUP BY action ORDER BY n DESC LIMIT 25`,
      ...(user.role === 'admin' ? [] : [user.id])
    );
    sendJson(res, 200, { ok: true, total, logs: rows, actions });
  });

  router.delete('/api/logs', async (req, res, ctx) => {
    const admin = requireAdmin(req);
    const before = str(ctx.query.before, '', 40);
    if (before) run(`DELETE FROM access_logs WHERE created_at < ?`, before);
    else run(`DELETE FROM access_logs WHERE action LIKE 'search%'`);
    audit({ userId: admin.id, userName: admin.name, action: 'logs.cleanup', resourceType: 'log' });
    sendJson(res, 200, { ok: true });
  });

  /* ============================== 数据导入（文本粘贴建文件） ============================== */

  router.post('/api/files/text', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { workspaceId, folderId = null, name = '未命名.txt', content = '', tags = [] } = ctx.body || {};
    if (!workspaceId) throw httpError(400, '缺少 workspaceId');
    requireWorkspace(user.id, workspaceId, 'edit');
    const { relativeStoragePath, persistUpload } = await import('../lib/storage.js');
    const { TMP_DIR } = await import('../config.js');
    const { splitExt, safeFileName } = await import('../lib/text.js');
    const fs = await import('node:fs/promises');

    const safeName = safeFileName(name);
    const { ext } = splitExt(safeName);
    const fileId = randomId('file');
    const key = relativeStoragePath(workspaceId, fileId, ext || 'txt');
    const tmp = path.join(TMP_DIR, `txt_${fileId}.tmp`);
    await fsp.mkdir(TMP_DIR, { recursive: true });
    await fsp.writeFile(tmp, String(content ?? ''), 'utf8');
    const saved = await persistUpload(tmp, key, { encrypt: false });
    const now = nowIso();
    insert('files', {
      id: fileId, workspace_id: workspaceId, folder_id: folderId, name: safeName,
      ext: ext || 'txt', mime: 'text/plain', size: saved.size, storage_key: key,
      checksum: saved.checksum, encrypted: 0, private_flag: 0, acl_level: 'inherit',
      tags: JSON.stringify(normalizeTags(tags)), starred: 0, pinned: 0,
      created_by: user.id, updated_by: user.id, created_at: now, updated_at: now,
      version: 1, preview_kind: 'text'
    });
    insert('file_text', { file_id: fileId, workspace_id: workspaceId, text: '', html: '', status: 'pending', error: '', page_count: 0, chars: 0, meta: '{}', engine: '', extract_ms: 0, updated_at: now });
    enqueueIndex(fileId, { priority: true });
    fs.unlink(tmp).catch(() => {});
    sendJson(res, 201, { ok: true, fileId });
  });
}

/* ------------------------------------------------------------------ 内部 */

function persistAssistantMessage(chatId, result, user) {
  const id = randomId('msg');
  insert('messages', {
    id, chat_id: chatId, role: 'assistant', content: result.content || '',
    citations: JSON.stringify(result.citations || []),
    provider: result.provider || '', model: result.model || '',
    latency_ms: Number(result.ms || 0), feedback: 0, created_at: nowIso(),
    // 语义标记：刷新/重新打开会话后仍需保留「未引用知识库」的警示
    meta: JSON.stringify({
      general: !!result.general,
      noContext: !!result.noContext,
      interrupted: !!result.interrupted,
      fallback: !!result.fallback
    })
  });
  const chat = get(`SELECT * FROM chats WHERE id=?`, chatId);
  if (chat) {
    update('chats', chatId, {
      provider: result.provider || '', model: result.model || '', updated_at: nowIso(),
      title: chat.title && chat.title !== '新对话' ? chat.title : truncate(String(result.content || '').replace(/[#*>\-\n]/g, ' ').trim(), 36) || '新对话'
    });
  }
  return { id };
}

function publicContext(c) {
  return {
    chunkId: c.chunkId, fileId: c.fileId, title: c.title, ext: c.ext,
    page: c.page, heading: c.heading, score: c.score,
    snippet: truncate(c.text || '', 320), sources: c.sources
  };
}

export { relatedFiles };
