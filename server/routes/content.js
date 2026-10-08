/**
 * KBPRO — 路由：文件 / 笔记 / 检索 / 共享 / 评论 / 协作 / 资源 / 实时事件
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createReadStream } from 'node:fs';
import {
  all, get, run, insert, update, tx, nowIso, audit, scalar, indexEntity
} from '../db.js';
import { randomId, sha256 } from '../lib/crypto.js';
import {
  httpError, sendJson, sendError, clientIp, contentDisposition, sseStart, sseSend, formatBytes
} from '../lib/http.js';
import { TMP_DIR } from '../config.js';
import { parseMultipart, isMultipart } from '../lib/multipart.js';
import {
  relativeStoragePath, persistUpload, readStored, deleteStored, absoluteStoragePath, humanStoragePath
} from '../lib/storage.js';
import {
  requireUser, requireWorkspace, workspacePermission, resourcePermission, requireResource,
  buildSearchAcl, accessibleWorkspaces, permAtLeast, sharesForResource, createShare, deleteShare,
  shareByToken, maxPerm, audit as auditLog
} from '../auth.js';
import { workspaceTags, syncTags, cleanupOrphanTags, folderTree, breadcrumb } from '../lib/tags.js';
import { searchAll, suggest, tagCloud, relatedFiles } from '../lib/search.js';
import { extractDocument, detectPreviewKind, guessMime } from '../lib/extract.js';
import { enqueueIndex, processFile } from '../lib/pipeline.js';
import { publish, publishWorkspace, publishResource, subscribe, subscriberCount } from '../lib/bus.js';
import {
  normalizeTags, safeFileName, splitExt, htmlToText, wordCount, sanitizeHtml, truncate, escapeHtml, tokenize
} from '../lib/text.js';
import { FILES_DIR } from '../config.js';

/* ------------------------------------------------------------------ 工具 */

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
function requireBody(body, keys) {
  for (const k of keys) {
    if (body[k] === undefined || body[k] === null || body[k] === '') throw httpError(400, `缺少参数：${k}`);
  }
}
function placeholders(arr) {
  return arr.length ? arr.map(() => '?').join(',') : "''";
}

/** 校验分享 token 是否授予指定资源相应权限（用于匿名访问） */
function shareTokenGrants(token, resourceType, resourceId, required = 'view') {
  if (!token) return false;
  const share = shareByToken(String(token));
  if (!share) return false;
  if (share.resource_type !== resourceType || share.resource_id !== resourceId) return false;
  return permAtLeast(share.permission, required);
}

function fileRow(id) {
  return get(
    `SELECT f.*, t.status AS text_status, t.chars AS text_chars, t.page_count AS pages, t.error AS text_error,
            t.engine, t.meta AS text_meta, t.updated_at AS text_updated_at
       FROM files f LEFT JOIN file_text t ON t.file_id = f.id
      WHERE f.id = ?`, id
  );
}

function serializeFile(row, { withText = false } = {}) {
  if (!row) return null;
  const meta = (() => { try { return JSON.parse(row.text_meta || '{}'); } catch { return {}; } })();
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    folderId: row.folder_id,
    name: row.name,
    ext: row.ext,
    mime: row.mime,
    size: Number(row.size || 0),
    sizeText: formatBytes(row.size),
    checksum: row.checksum,
    encrypted: !!row.encrypted,
    isPrivate: row.acl_level === 'private',
    tags: normalizeTags(row.tags),
    starred: !!row.starred,
    pinned: !!row.pinned,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version || 1),
    viewCount: Number(row.view_count || 0),
    downloadCount: Number(row.download_count || 0),
    previewKind: row.preview_kind || detectPreviewKind(row.ext, row.mime),
    text: {
      status: row.text_status || 'pending',
      chars: Number(row.text_chars || 0),
      pages: Number(row.pages || 0),
      error: row.text_error || '',
      engine: row.engine || '',
      warning: meta.warning || '',
      updatedAt: row.text_updated_at || null
    },
    ...(withText ? { extractedText: row.extracted_text || '' } : {})
  };
}

function serializeNote(row) {
  if (!row) return null;
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    folderId: row.folder_id,
    title: row.title,
    html: row.html || '',
    text: row.text || '',
    summary: row.summary || '',
    emoji: row.emoji || '',
    tags: normalizeTags(row.tags),
    starred: !!row.starred,
    pinned: !!row.pinned,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: Number(row.version || 1),
    wordCount: Number(row.word_count || 0),
    readMinutes: Math.max(1, Math.round(Number(row.word_count || 0) / 380)),
    deletedAt: row.deleted_at || null
  };
}

/* ------------------------------------------------------------------ 注册 */

export function registerContentRoutes(router) {

  /* ============================== 实时事件 ============================== */

  router.get('/api/events', async (req, res, ctx) => {
    const user = ctx.requireUser();
    sseStart(res);
    sseSend(res, 'hello', { ok: true, at: nowIso(), user: user.name });

    const unsubs = [];
    const list = accessibleWorkspaces(user.id);
    const ids = list.map((w) => w.id);
    for (const wsId of ids) {
      unsubs.push(subscribe(`ws:${wsId}`, (payload) => sseSend(res, 'workspace', payload)));
    }
    unsubs.push(subscribe(`user:${user.id}`, (payload) => sseSend(res, 'notification', payload)));

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* */ }
    }, 25000);

    const cleanup = () => {
      clearInterval(ping);
      for (const u of unsubs) { try { u(); } catch { /* */ } }
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  /* ============================== 文件 ============================== */

  /**
   * 上传（multipart）。
   * 字段：workspaceId, folderId, tags, encrypt, autoIndex
   */
  router.post('/api/files/upload', async (req, res, ctx) => {
    const user = ctx.requireUser();
    if (!isMultipart(req)) throw httpError(400, '请使用 multipart/form-data 上传');

    const { loadConfig } = await import('../config.js');
    const cfg = loadConfig();
    const maxBytes = Math.min(cfg.maxUploadBytes * 4, 1024 * 1024 * 1024);

    const parsed = await parseMultipart(req, {
      tmpDir: TMP_DIR,
      maxBytes,
      maxFiles: 50,
      onProgress: () => { /* 客户端使用 XHR 上传进度 */ }
    });

    const workspaceId = str(parsed.fields.workspaceId, '', 80);
    if (!workspaceId) throw httpError(400, '缺少 workspaceId');
    requireWorkspace(user.id, workspaceId, 'edit');

    let folderId = parsed.fields.folderId ? str(parsed.fields.folderId, '', 80) : null;
    if (folderId) {
      const folder = get(`SELECT id FROM folders WHERE id=? AND workspace_id=? AND deleted_at IS NULL`, folderId, workspaceId);
      if (!folder) folderId = null;
    }
    const extraTags = normalizeTags(parsed.fields.tags || '');
    const encrypt = bool(parsed.fields.encrypt, false);
    const autoIndex = parsed.fields.autoIndex === undefined ? true : bool(parsed.fields.autoIndex, true);

    if (!parsed.files.length) {
      throw httpError(400, '没有接收到文件');
    }

    const created = [];
    const failed = [];

    // 存储配额：此前只在前端展示、从未真正拦截。
    // 以「已用 + 本次已接受」逐文件累计判断，超额的文件明确拒收并说明原因。
    const quota = Number(user.storage_quota || 0);
    let quotaUsed = Number(user.storage_used || 0);
    const quotaLeft = () => (quota > 0 ? Math.max(0, quota - quotaUsed) : Infinity);

    for (const f of parsed.files) {
      try {
        if (f.size === 0) {
          failed.push({ filename: f.filename, error: '文件为空' });
          await fsp.unlink(f.tmpPath).catch(() => {});
          continue;
        }
        if (f.size > cfg.maxUploadBytes) {
          failed.push({ filename: f.filename, error: `超过单文件上限 ${formatBytes(cfg.maxUploadBytes)}` });
          await fsp.unlink(f.tmpPath).catch(() => {});
          continue;
        }
        if (quota > 0 && quotaUsed + f.size > quota) {
          failed.push({
            filename: f.filename,
            error: `超出存储配额（剩余 ${formatBytes(quotaLeft())}，该文件 ${formatBytes(f.size)}）`
          });
          await fsp.unlink(f.tmpPath).catch(() => {});
          continue;
        }
        // 同名去重：同目录同名自动追加 (2)
        const { base, ext } = splitExt(f.filename);
        let name = safeFileName(f.filename);
        let n = 1;
        while (get(`SELECT id FROM files WHERE workspace_id=? AND deleted_at IS NULL AND name=? AND IFNULL(folder_id,'')=IFNULL(?,'')`,
          workspaceId, name, folderId ?? null)) {
          n++;
          name = `${base} (${n})${ext ? '.' + ext : ''}`;
        }

        const fileId = randomId('file');
        const storageKey = relativeStoragePath(workspaceId, fileId, ext);
        const saved = await persistUpload(f.tmpPath, storageKey, { encrypt });

        const now = nowIso();
        const mime = f.contentType && f.contentType !== 'application/octet-stream'
          ? f.contentType : guessMime(ext);

        insert('files', {
          id: fileId, workspace_id: workspaceId, folder_id: folderId, name, ext, mime,
          size: saved.size, storage_key: storageKey, checksum: saved.checksum || f.checksum || sha256(String(fileId)),
          encrypted: encrypt ? 1 : 0, private_flag: encrypt ? 1 : 0,
          acl_level: encrypt ? 'private' : 'inherit',
          tags: JSON.stringify(extraTags), starred: 0, pinned: 0,
          created_by: user.id, updated_by: user.id, created_at: now, updated_at: now,
          version: 1, preview_kind: detectPreviewKind(ext, mime)
        });
        insert('file_text', {
          file_id: fileId, workspace_id: workspaceId, text: '', html: '', status: 'pending',
          error: '', page_count: 0, chars: 0, meta: '{}', engine: '', extract_ms: 0, updated_at: now
        });
        if (extraTags.length) syncTags(workspaceId, 'file', fileId, extraTags, user.id);
        run(`UPDATE users SET storage_used = storage_used + ? WHERE id=?`, saved.size, user.id);
        quotaUsed += saved.size;

        audit({ workspaceId, userId: user.id, userName: user.name, action: 'file.upload', resourceType: 'file', resourceId: fileId, resourceName: name, detail: formatBytes(saved.size), ip: clientIp(req) });
        created.push(serializeFile(fileRow(fileId)));
        if (autoIndex) enqueueIndex(fileId, { priority: true });
      } catch (err) {
        failed.push({ filename: f.filename, error: err?.message || String(err) });
        await fsp.unlink(f.tmpPath).catch(() => {});
      }
    }

    if (created.length) publishWorkspace(workspaceId, { type: 'files.uploaded', count: created.length, ids: created.map((c) => c.id) });

    sendJson(res, created.length ? 201 : 400, {
      ok: created.length > 0,
      files: created,
      failed,
      message: created.length
        ? `成功上传 ${created.length} 个文件${failed.length ? `，${failed.length} 个失败` : ''}`
        : '上传失败'
    });
  });

  /** 新建纯文本文档（Markdown / TXT 等），供在线新建与批量导入使用 */
  router.post('/api/files/text', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const body = ctx.body || {};
    const workspaceId = str(body.workspaceId, '', 80);
    if (!workspaceId) throw httpError(400, '缺少 workspaceId');
    requireWorkspace(user.id, workspaceId, 'edit');

    let content = String(body.content ?? body.text ?? '');
    if (!content.trim()) throw httpError(400, '内容不能为空');
    if (content.length > 4 * 1024 * 1024) content = content.slice(0, 4 * 1024 * 1024);

    // 存储配额：与上传路径一致，超额必须明确拒收
    const quota = Number(user.storage_quota || 0);
    const incoming = Buffer.byteLength(content, 'utf8');
    if (quota > 0 && Number(user.storage_used || 0) + incoming > quota) {
      throw httpError(413, `超出存储配额（剩余 ${formatBytes(Math.max(0, quota - Number(user.storage_used || 0)))}，本次需要 ${formatBytes(incoming)}）`);
    }

    let folderId = body.folderId ? str(body.folderId, '', 80) : null;
    if (folderId) {
      const folder = get(`SELECT id FROM folders WHERE id=? AND workspace_id=? AND deleted_at IS NULL`, folderId, workspaceId);
      if (!folder) folderId = null;
    }
    const encrypt = bool(body.encrypt, false);
    const extraTags = normalizeTags(body.tags || []);
    let name = safeFileName(str(body.name, '', 200).trim() || '未命名.md');
    const { base, ext: rawExt } = splitExt(name);
    const ext = (rawExt || 'md').toLowerCase();

    // 同名去重
    let n = 1;
    while (get(`SELECT id FROM files WHERE workspace_id=? AND deleted_at IS NULL AND name=? AND IFNULL(folder_id,'')=IFNULL(?,'')`,
      workspaceId, name, folderId ?? null)) {
      n++;
      name = `${base} (${n}).${ext}`;
    }

    const fileId = randomId('file');
    const storageKey = relativeStoragePath(workspaceId, fileId, ext);
    const tmpPath = path.join(TMP_DIR, `txt_${Date.now().toString(36)}_${randomId('')}`);
    await fsp.writeFile(tmpPath, content, 'utf8');
    const saved = await persistUpload(tmpPath, storageKey, { encrypt });

    const now = nowIso();
    const mime = guessMime(ext);
    insert('files', {
      id: fileId, workspace_id: workspaceId, folder_id: folderId, name, ext, mime,
      size: saved.size, storage_key: storageKey, checksum: saved.checksum || sha256(content),
      encrypted: encrypt ? 1 : 0, private_flag: encrypt ? 1 : 0,
      acl_level: encrypt ? 'private' : 'inherit',
      tags: JSON.stringify(extraTags), starred: 0, pinned: 0,
      created_by: user.id, updated_by: user.id, created_at: now, updated_at: now,
      version: 1, preview_kind: detectPreviewKind(ext, mime)
    });
    insert('file_text', {
      file_id: fileId, workspace_id: workspaceId, text: '', html: '', status: 'pending',
      error: '', page_count: 0, chars: 0, meta: '{}', engine: '', extract_ms: 0, updated_at: now
    });
    if (extraTags.length) syncTags(workspaceId, 'file', fileId, extraTags, user.id);
    run(`UPDATE users SET storage_used = storage_used + ? WHERE id=?`, saved.size, user.id);
    enqueueIndex(fileId, { force: true, priority: true });
    publishWorkspace(workspaceId, { type: 'files.uploaded', count: 1, ids: [fileId] });
    audit({ workspaceId, userId: user.id, userName: user.name, action: 'file.create', resourceType: 'file', resourceId: fileId, resourceName: name, detail: formatBytes(saved.size), ip: clientIp(req) });
    sendJson(res, 201, { ok: true, file: serializeFile(fileRow(fileId)) });
  });

  /** 列出文件 */
  router.get('/api/files', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const workspaceId = str(ctx.query.workspaceId, '', 80);
    if (!workspaceId) throw httpError(400, '缺少 workspaceId');
    requireWorkspace(user.id, workspaceId, 'view');

    const where = ['f.workspace_id = ?'];
    const params = [workspaceId];

    const trash = bool(ctx.query.trash, false);
    where.push(trash ? 'f.deleted_at IS NOT NULL' : 'f.deleted_at IS NULL');

    const folderId = ctx.query.folderId;
    if (folderId === 'root') where.push(`f.folder_id IS NULL`);
    else if (folderId && folderId !== 'all') { where.push('f.folder_id = ?'); params.push(folderId); }

    if (ctx.query.ext) { where.push('f.ext = ?'); params.push(String(ctx.query.ext).toLowerCase()); }
    if (bool(ctx.query.starred)) where.push('f.starred = 1');
    if (bool(ctx.query.pinned)) where.push('f.pinned = 1');
    if (bool(ctx.query.encrypted)) where.push('f.encrypted = 1');

    const tags = normalizeTags(ctx.query.tags || '');
    if (tags.length) {
      where.push(`EXISTS (SELECT 1 FROM entity_tags et JOIN tags tg ON tg.id=et.tag_id
                          WHERE et.entity_type='file' AND et.entity_id=f.id AND tg.name IN (${placeholders(tags)}))`);
      params.push(...tags);
    }

    const q = str(ctx.query.q, '', 120).trim();
    if (q) {
      const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
      where.push(`(f.name LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM file_text ft WHERE ft.file_id=f.id AND ft.text LIKE ? ESCAPE '\\'))`);
      params.push(like, like);
    }

    const sortMap = {
      updated: 'f.updated_at', created: 'f.created_at', name: 'f.name', size: 'f.size', views: 'f.view_count'
    };
    const sort = sortMap[ctx.query.sort] || 'f.updated_at';
    const order = String(ctx.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.max(1, Math.min(200, int(ctx.query.limit, 60)));
    const offset = Math.max(0, int(ctx.query.offset, 0));

    const acl = buildSearchAcl(user.id, [workspaceId]);
    if (acl.allowedFileIds) {
      const ids = [...acl.allowedFileIds];
      where.push(`f.id IN (${placeholders(ids)})`);
      params.push(...ids);
    }

    const whereSql = where.join(' AND ');
    const total = Number(scalar(`SELECT COUNT(*) FROM files f WHERE ${whereSql}`, ...params) || 0);

    const rows = all(
      `SELECT f.*, t.status AS text_status, t.chars AS text_chars, t.page_count AS pages,
              t.error AS text_error, t.engine, t.meta AS text_meta, t.updated_at AS text_updated_at
         FROM files f LEFT JOIN file_text t ON t.file_id=f.id
        WHERE ${whereSql}
        ORDER BY f.pinned DESC, ${sort} ${order}
        LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );

    const folderSummary = all(
      `SELECT folder_id, COUNT(*) AS n FROM files
        WHERE workspace_id=? AND deleted_at IS NULL GROUP BY folder_id`, workspaceId
    ).map((r) => ({ folderId: r.folder_id, count: Number(r.n) }));

    sendJson(res, 200, {
      ok: true, total, limit, offset,
      files: rows.map((r) => serializeFile(r)),
      folders: folderSummary
    });
  });

  /** 单个文件详情 */
  router.get('/api/files/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource, permission } = requireResource(user.id, 'file', ctx.params.id, 'view');
    run(`UPDATE files SET view_count = view_count + 1 WHERE id=?`, resource.id);
    const row = fileRow(resource.id);
    sendJson(res, 200, {
      ok: true,
      file: serializeFile(row, { withText: true }),
      permission,
      shares: sharesForResource('file', resource.id),
      related: relatedFiles([resource.workspace_id], resource.id, 6, buildSearchAcl(user.id, [resource.workspace_id])),
      breadcrumb: resource.folder_id ? breadcrumb(resource.folder_id) : []
    });
  });

  /** 抽取出的文本与结构化内容 */
  router.get('/api/files/:id/text', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'file', ctx.params.id, 'view');
    const row = get(`SELECT * FROM file_text WHERE file_id=?`, resource.id);
    if (!row) return sendJson(res, 200, { ok: true, status: 'pending', text: '', html: '' });
    sendJson(res, 200, {
      ok: true,
      status: row.status,
      text: row.text || '',
      html: row.html || '',
      pages: Number(row.page_count || 0),
      chars: Number(row.chars || 0),
      engine: row.engine || '',
      error: row.error || '',
      meta: (() => { try { return JSON.parse(row.meta || '{}'); } catch { return {}; } })()
    });
  });

  /** 触发（重新）解析 */
  router.post('/api/files/:id/reindex', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'file', ctx.params.id, 'edit');
    const sync = bool((ctx.body || {}).sync, false);
    if (sync) {
      const r = await processFile(resource.id, { force: true });
      return sendJson(res, 200, { ok: true, result: r, file: serializeFile(fileRow(resource.id)) });
    }
    enqueueIndex(resource.id, { force: true, priority: true });
    sendJson(res, 202, { ok: true, queued: true });
  });

  /** 原文件内容（在线预览 / 下载），支持 Range */
  router.get('/api/files/:id/content', async (req, res, ctx) => {
    const user = ctx.user;
    let resource;
    let permission = 'view';
    if (user) {
      ({ resource, permission } = requireResource(user.id, 'file', ctx.params.id, 'view'));
    } else if (shareTokenGrants(ctx.query.token, 'file', ctx.params.id, 'view')) {
      resource = get(`SELECT * FROM files WHERE id=?`, ctx.params.id);
      if (!resource) throw httpError(404, '资源不存在');
    } else {
      throw httpError(401, '未登录或会话已过期');
    }
    const inline = bool(ctx.query.inline, false) || String(req.headers['sec-fetch-dest'] || '') === 'iframe';
    const download = bool(ctx.query.download, false);

    let buf;
    try {
      buf = await readStored(resource.storage_key, !!resource.encrypted);
    } catch (err) {
      return sendError(res, 404, `文件内容不可用：${err.message}`);
    }

    if (download) {
      run(`UPDATE files SET download_count = download_count + 1 WHERE id=?`, resource.id);
      if (user) {
        audit({ workspaceId: resource.workspace_id, userId: user.id, userName: user.name, action: 'file.download', resourceType: 'file', resourceId: resource.id, resourceName: resource.name, ip: clientIp(req) });
      } else {
        audit({ workspaceId: resource.workspace_id, userId: null, userName: '匿名访客', action: 'file.download', resourceType: 'file', resourceId: resource.id, resourceName: resource.name, ip: clientIp(req) });
      }
    }

    const headers = {
      'Content-Type': resource.mime || 'application/octet-stream',
      'Content-Disposition': contentDisposition(resource.name, download ? 'attachment' : 'inline'),
      'Cache-Control': 'private, max-age=60',
      'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff'
    };

    // 加密文件不支持 Range（需整体解密）
    const range = !resource.encrypted ? String(req.headers.range || '') : '';
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
        if (start <= end && start < buf.length) {
          res.writeHead(206, {
            ...headers,
            'Content-Range': `bytes ${start}-${end}/${buf.length}`,
            'Content-Length': end - start + 1
          });
          res.end(buf.subarray(start, end + 1));
          return;
        }
      }
    }
    res.writeHead(200, { ...headers, 'Content-Length': buf.length });
    if (req.method === 'HEAD') { res.end(); return; }
    res.end(buf);
  });

  /** 预览数据（应用内渲染） */
  router.get('/api/files/:id/preview', async (req, res, ctx) => {
    const user = ctx.user;
    let resource;
    if (user) {
      ({ resource } = requireResource(user.id, 'file', ctx.params.id, 'view'));
    } else if (shareTokenGrants(ctx.query.token, 'file', ctx.params.id, 'view')) {
      resource = get(`SELECT * FROM files WHERE id=?`, ctx.params.id);
      if (!resource) throw httpError(404, '资源不存在');
    } else {
      throw httpError(401, '未登录或会话已过期');
    }
    const kind = resource.preview_kind || detectPreviewKind(resource.ext, resource.mime);
    const row = get(`SELECT * FROM file_text WHERE file_id=?`, resource.id);

    let html = row?.html || '';
    let text = row?.text || '';
    if (!text && ['pdf', 'docx', 'xlsx', 'pptx'].includes(kind) === false && kind !== 'binary') {
      try {
        const buf = await readStored(resource.storage_key, !!resource.encrypted);
        const r = await extractDocument(buf, { ext: resource.ext, mime: resource.mime, name: resource.name });
        html = r.html || '';
        text = r.text || '';
      } catch { /* ignore */ }
    }

    sendJson(res, 200, {
      ok: true,
      kind,
      html,
      text,
      pages: Number(row?.page_count || 0),
      status: row?.status || 'pending',
      warning: (() => { try { return JSON.parse(row?.meta || '{}').warning || ''; } catch { return ''; } })(),
      streamUrl: `/api/files/${resource.id}/content?inline=1${!user && ctx.query.token ? `&token=${encodeURIComponent(String(ctx.query.token))}` : ''}`,
      downloadUrl: `/api/files/${resource.id}/content?download=1${!user && ctx.query.token ? `&token=${encodeURIComponent(String(ctx.query.token))}` : ''}`
    });
  });

  /** 更新文件元数据：重命名 / 移动 / 标签 / 收藏 / 置顶 / 私密 */
  router.patch('/api/files/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'file', ctx.params.id, 'edit');
    const body = ctx.body || {};
    const patch = { updated_at: nowIso(), updated_by: user.id };

    if (body.name !== undefined) {
      const { base, ext } = splitExt(resource.name);
      let n = str(body.name, '', 200).trim();
      if (!n) throw httpError(400, '文件名不能为空');
      const guessed = splitExt(n);
      if (!guessed.ext && ext) n = `${n}.${ext}`;
      const dup = get(
        `SELECT id FROM files WHERE workspace_id=? AND deleted_at IS NULL AND name=? AND IFNULL(folder_id,'')=IFNULL(?,'') AND id<>?`,
        resource.workspace_id, n, resource.folder_id ?? null, resource.id
      );
      if (dup) throw httpError(409, '该目录下已存在同名文件');
      patch.name = safeFileName(n);
      patch.ext = splitExt(patch.name).ext || resource.ext;
    }
    if (body.folderId !== undefined) {
      if (body.folderId) {
        const folder = get(`SELECT id FROM folders WHERE id=? AND workspace_id=? AND deleted_at IS NULL`, body.folderId, resource.workspace_id);
        if (!folder) throw httpError(404, '目标文件夹不存在');
      }
      patch.folder_id = body.folderId || null;
    }
    if (body.starred !== undefined) patch.starred = bool(body.starred) ? 1 : 0;
    if (body.pinned !== undefined) patch.pinned = bool(body.pinned) ? 1 : 0;
    if (body.private !== undefined) {
      patch.acl_level = bool(body.private) ? 'private' : 'inherit';
      patch.private_flag = bool(body.private) ? 1 : 0;
    }
    if (body.tags !== undefined) {
      const list = syncTags(resource.workspace_id, 'file', resource.id, body.tags, user.id);
      patch.tags = JSON.stringify(list);
      cleanupOrphanTags(resource.workspace_id);
    }
    update('files', resource.id, patch);

    audit({ workspaceId: resource.workspace_id, userId: user.id, userName: user.name, action: 'file.update', resourceType: 'file', resourceId: resource.id, resourceName: patch.name || resource.name, detail: Object.keys(patch).join(',') });
    publishResource('file', resource.id, { type: 'file.updated', fileId: resource.id });
    publishWorkspace(resource.workspace_id, { type: 'file.updated', fileId: resource.id });
    sendJson(res, 200, { ok: true, file: serializeFile(fileRow(resource.id)) });
  });

  /** 删除（软删除 / 彻底删除） */
  router.delete('/api/files/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'file', ctx.params.id, 'edit');
    const hard = bool(ctx.query.hard, false);
    if (hard) {
      requireResource(user.id, 'file', ctx.params.id, 'manage');
      await hardDeleteFile(resource, user);
      return sendJson(res, 200, { ok: true, hard: true });
    }
    update('files', resource.id, { deleted_at: nowIso(), updated_by: user.id });
    audit({ workspaceId: resource.workspace_id, userId: user.id, userName: user.name, action: 'file.delete', resourceType: 'file', resourceId: resource.id, resourceName: resource.name });
    publishWorkspace(resource.workspace_id, { type: 'file.deleted', fileId: resource.id });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/files/:id/restore', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'file', ctx.params.id, 'edit', { allowDeleted: true });
    update('files', resource.id, { deleted_at: null, updated_at: nowIso() });
    sendJson(res, 200, { ok: true, file: serializeFile(fileRow(resource.id)) });
  });

  /** 批量操作 */
  router.post('/api/files/batch', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { action, ids = [] } = ctx.body || {};
    if (!Array.isArray(ids) || !ids.length) throw httpError(400, '缺少 ids');
    const list = ids.slice(0, 500);
    const results = { ok: 0, failed: 0, errors: [] };
    const touchWorkspaces = new Set();

    for (const id of list) {
      try {
        const file = get(`SELECT * FROM files WHERE id=?`, id);
        if (!file) throw new Error('文件不存在');
        const perm = resourcePermission(user.id, 'file', file);
        if (!permAtLeast(perm, ['delete', 'restore'].includes(action) ? 'edit' : 'edit')) throw new Error('权限不足');

        switch (action) {
          case 'delete': update('files', id, { deleted_at: nowIso() }); break;
          case 'restore': update('files', id, { deleted_at: null, updated_at: nowIso() }); break;
          case 'hard-delete': {
            if (!permAtLeast(perm, 'manage')) throw new Error('需要管理权限');
            await hardDeleteFile(file, user);
            break;
          }
          case 'move': {
            const target = (ctx.body.targetFolderId || null);
            if (target) {
              const f = get(`SELECT id FROM folders WHERE id=? AND workspace_id=? AND deleted_at IS NULL`, target, file.workspace_id);
              if (!f) throw new Error('目标文件夹不存在');
            }
            update('files', id, { folder_id: target, updated_at: nowIso() });
            break;
          }
          case 'star': update('files', id, { starred: 1 }); break;
          case 'unstar': update('files', id, { starred: 0 }); break;
          case 'pin': update('files', id, { pinned: 1 }); break;
          case 'unpin': update('files', id, { pinned: 0 }); break;
          case 'tag': {
            const merged = [...new Set([...normalizeTags(file.tags), ...normalizeTags(ctx.body.tags || [])])];
            update('files', id, { tags: JSON.stringify(syncTags(file.workspace_id, 'file', id, merged, user.id)) });
            break;
          }
          case 'untag': {
            const remove = normalizeTags(ctx.body.tags || []).map((t) => t.toLowerCase());
            const kept = normalizeTags(file.tags).filter((t) => !remove.includes(t.toLowerCase()));
            update('files', id, { tags: JSON.stringify(syncTags(file.workspace_id, 'file', id, kept, user.id)) });
            break;
          }
          case 'reindex': enqueueIndex(id, { force: true }); break;
          default: throw new Error(`不支持的操作：${action}`);
        }
        touchWorkspaces.add(file.workspace_id);
        results.ok++;
      } catch (err) {
        results.failed++;
        results.errors.push({ id, error: err.message });
      }
    }
    for (const ws of touchWorkspaces) publishWorkspace(ws, { type: 'files.batch', action, count: results.ok });
    audit({ userId: user.id, userName: user.name, action: `file.batch.${action}`, resourceType: 'file', detail: `ok=${results.ok} failed=${results.failed}` });
    sendJson(res, 200, { ok: true, ...results });
  });

  /** 相关知识 */
  router.get('/api/files/:id/related', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'file', ctx.params.id, 'view');
    const limit = Math.max(1, Math.min(20, int(ctx.query.limit, 8)));
    sendJson(res, 200, { ok: true, related: relatedFiles([resource.workspace_id], resource.id, limit, buildSearchAcl(user.id, [resource.workspace_id])) });
  });

  /* ============================== 笔记 ============================== */

  router.get('/api/notes', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const workspaceId = str(ctx.query.workspaceId, '', 80);
    if (!workspaceId) throw httpError(400, '缺少 workspaceId');
    requireWorkspace(user.id, workspaceId, 'view');

    const where = ['workspace_id = ?'];
    const params = [workspaceId];
    const trash = bool(ctx.query.trash, false);
    where.push(trash ? 'deleted_at IS NOT NULL' : 'deleted_at IS NULL');

    const folderId = ctx.query.folderId;
    if (folderId === 'root') where.push(`folder_id IS NULL`);
    else if (folderId && folderId !== 'all') { where.push('folder_id = ?'); params.push(folderId); }

    if (bool(ctx.query.starred)) where.push('starred = 1');
    if (bool(ctx.query.pinned)) where.push('pinned = 1');

    const tags = normalizeTags(ctx.query.tags || '');
    if (tags.length) {
      where.push(`EXISTS (SELECT 1 FROM entity_tags et JOIN tags tg ON tg.id=et.tag_id
                          WHERE et.entity_type='note' AND et.entity_id=notes.id AND tg.name IN (${placeholders(tags)}))`);
      params.push(...tags);
    }
    const q = str(ctx.query.q, '', 120).trim();
    if (q) {
      const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
      where.push(`(title LIKE ? ESCAPE '\\' OR text LIKE ? ESCAPE '\\')`);
      params.push(like, like);
    }

    const sortMap = { updated: 'updated_at', created: 'created_at', title: 'title', words: 'word_count' };
    const sort = sortMap[ctx.query.sort] || 'updated_at';
    const order = String(ctx.query.order || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
    const limit = Math.max(1, Math.min(500, int(ctx.query.limit, 200)));
    const offset = Math.max(0, int(ctx.query.offset, 0));

    const acl = buildSearchAcl(user.id, [workspaceId]);
    if (acl.allowedNoteIds) {
      const ids = [...acl.allowedNoteIds];
      where.push(`id IN (${placeholders(ids)})`);
      params.push(...ids);
    }

    const whereSql = where.join(' AND ');
    const total = Number(scalar(`SELECT COUNT(*) FROM notes WHERE ${whereSql}`, ...params) || 0);
    const rows = all(
      `SELECT * FROM notes WHERE ${whereSql} ORDER BY pinned DESC, ${sort} ${order} LIMIT ? OFFSET ?`,
      ...params, limit, offset
    );
    sendJson(res, 200, { ok: true, total, notes: rows.map(serializeNote) });
  });

  router.post('/api/notes', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { workspaceId, folderId = null, title = '未命名笔记', html = '', emoji = '', tags = [] } = ctx.body || {};
    requireBody(ctx.body || {}, ['workspaceId']);
    requireWorkspace(user.id, workspaceId, 'edit');
    if (folderId) {
      const f = get(`SELECT id FROM folders WHERE id=? AND workspace_id=? AND deleted_at IS NULL`, folderId, workspaceId);
      if (!f) throw httpError(404, '文件夹不存在');
    }
    const now = nowIso();
    const id = randomId('note');
    const cleanHtml = sanitizeHtml(html);
    const text = htmlToText(cleanHtml);
    insert('notes', {
      id, workspace_id: workspaceId, folder_id: folderId,
      title: str(title, '未命名笔记', 200), html: cleanHtml, text, summary: '',
      emoji: str(emoji, '', 8), tags: JSON.stringify(normalizeTags(tags)),
      starred: 0, pinned: 0, created_by: user.id, updated_by: user.id,
      created_at: now, updated_at: now, deleted_at: null, version: 1,
      word_count: wordCount(text), view_count: 0
    });
    syncTags(workspaceId, 'note', id, normalizeTags(tags), user.id);
    const note = get(`SELECT * FROM notes WHERE id=?`, id);
    run(`INSERT INTO note_versions(id,note_id,version,title,html,text,editor_id,summary,chars,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      randomId('nv'), id, 1, note.title, cleanHtml, text, user.id, '创建笔记', text.length, now);
    // 建立笔记检索索引（标题加权）
    indexEntity('note', id, workspaceId, tokenize(`${note.title}\n${note.title}\n${text}`));
    audit({ workspaceId, userId: user.id, userName: user.name, action: 'note.create', resourceType: 'note', resourceId: id, resourceName: note.title });
    publishWorkspace(workspaceId, { type: 'note.created', noteId: id });
    sendJson(res, 201, { ok: true, note: serializeNote(note) });
  });

  router.get('/api/notes/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource, permission } = requireResource(user.id, 'note', ctx.params.id, 'view');
    run(`UPDATE notes SET view_count = view_count + 1 WHERE id=?`, resource.id);
    const versions = all(`SELECT id, version, title, editor_id, summary, chars, created_at FROM note_versions WHERE note_id=? ORDER BY version DESC LIMIT 50`, resource.id);
    sendJson(res, 200, {
      ok: true,
      note: serializeNote(get(`SELECT * FROM notes WHERE id=?`, resource.id)),
      permission,
      versions,
      shares: sharesForResource('note', resource.id),
      breadcrumb: resource.folder_id ? breadcrumb(resource.folder_id) : []
    });
  });

  /** 自动保存（PUT 全量内容） */
  router.put('/api/notes/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.id, 'edit');
    const body = ctx.body || {};
    const patch = { updated_at: nowIso(), updated_by: user.id };

    let contentChanged = false;
    if (body.html !== undefined) {
      const cleanHtml = sanitizeHtml(body.html);
      const text = htmlToText(cleanHtml);
      if (cleanHtml !== (resource.html || '')) contentChanged = true;
      patch.html = cleanHtml;
      patch.text = text;
      patch.word_count = wordCount(text);
    }
    if (body.title !== undefined) {
      const t = str(body.title, '未命名笔记', 200).trim() || '未命名笔记';
      if (t !== resource.title) contentChanged = true;
      patch.title = t;
    }
    if (body.folderId !== undefined) {
      if (body.folderId) {
        const f = get(`SELECT id FROM folders WHERE id=? AND workspace_id=? AND deleted_at IS NULL`, body.folderId, resource.workspace_id);
        if (!f) throw httpError(404, '文件夹不存在');
      }
      patch.folder_id = body.folderId || null;
    }
    if (body.emoji !== undefined) patch.emoji = str(body.emoji, '', 8);
    if (body.starred !== undefined) patch.starred = bool(body.starred) ? 1 : 0;
    if (body.pinned !== undefined) patch.pinned = bool(body.pinned) ? 1 : 0;
    if (body.tags !== undefined) {
      const list = syncTags(resource.workspace_id, 'note', resource.id, body.tags, user.id);
      patch.tags = JSON.stringify(list);
      cleanupOrphanTags(resource.workspace_id);
    }
    if (body.summary !== undefined) patch.summary = str(body.summary, '', 800);

    let newVersion = Number(resource.version || 1);
    if (contentChanged) {
      newVersion = Number(resource.version || 1) + 1;
      patch.version = newVersion;
    }
    patch.updated_at = nowIso();
    update('notes', resource.id, patch);

    // 版本策略：内容变化且（距上次版本 > 40s 或变化量 > 400 字符 或显式要求）
    const lastVersion = get(`SELECT * FROM note_versions WHERE note_id=? ORDER BY version DESC LIMIT 1`, resource.id);
    const prevText = lastVersion?.text || '';
    const nextText = patch.text ?? resource.text ?? '';
    const delta = Math.abs(nextText.length - prevText.length);
    const elapsed = lastVersion ? Date.now() - Date.parse(lastVersion.created_at) : Infinity;
    const forceVersion = bool(body.createVersion, false);
    if (contentChanged && (forceVersion || elapsed > 40000 || delta > 400)) {
      run(`INSERT INTO note_versions(id,note_id,version,title,html,text,editor_id,summary,chars,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        randomId('nv'), resource.id, newVersion,
        patch.title ?? resource.title, patch.html ?? resource.html, nextText,
        user.id, str(body.versionSummary || '自动保存', '', 120), nextText.length, nowIso());
      // 限制版本数量，保留最近 30 个
      const excess = all(`SELECT id FROM note_versions WHERE note_id=? ORDER BY version DESC LIMIT -1 OFFSET 30`, resource.id);
      for (const e of excess) run(`DELETE FROM note_versions WHERE id=?`, e.id);
    }

    // 更新检索索引
    if (contentChanged) {
      const { indexEntity } = await import('../db.js');
      const { tokenize } = await import('../lib/text.js');
      const fresh = get(`SELECT * FROM notes WHERE id=?`, resource.id);
      indexEntity('note', resource.id, resource.workspace_id, tokenize(`${fresh.title}\n${fresh.title}\n${fresh.text}`));
      publishWorkspace(resource.workspace_id, { type: 'note.updated', noteId: resource.id });
    }

    sendJson(res, 200, {
      ok: true,
      note: serializeNote(get(`SELECT * FROM notes WHERE id=?`, resource.id)),
      version: newVersion,
      savedAt: nowIso()
    });
  });

  router.delete('/api/notes/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.id, 'edit');
    const hard = bool(ctx.query.hard, false);
    if (hard) {
      requireResource(user.id, 'note', ctx.params.id, 'manage');
      tx((d) => {
        d.prepare(`DELETE FROM note_versions WHERE note_id=?`).run(resource.id);
        d.prepare(`DELETE FROM entity_tags WHERE entity_type='note' AND entity_id=?`).run(resource.id);
        d.prepare(`DELETE FROM notes WHERE id=?`).run(resource.id);
      });
      return sendJson(res, 200, { ok: true, hard: true });
    }
    update('notes', resource.id, { deleted_at: nowIso() });
    publishWorkspace(resource.workspace_id, { type: 'note.deleted', noteId: resource.id });
    sendJson(res, 200, { ok: true });
  });

  router.post('/api/notes/:id/restore', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.id, 'edit', { allowDeleted: true });
    update('notes', resource.id, { deleted_at: null, updated_at: nowIso() });
    sendJson(res, 200, { ok: true, note: serializeNote(get(`SELECT * FROM notes WHERE id=?`, resource.id)) });
  });

  /* -------- 版本历史 -------- */

  router.get('/api/notes/:id/versions', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.id, 'view');
    const rows = all(
      `SELECT nv.id, nv.version, nv.title, nv.summary, nv.chars, nv.created_at, nv.editor_id, u.name AS editor_name
         FROM note_versions nv LEFT JOIN users u ON u.id = nv.editor_id
        WHERE nv.note_id=? ORDER BY nv.version DESC LIMIT 100`,
      resource.id
    );
    sendJson(res, 200, { ok: true, versions: rows, current: Number(resource.version || 1) });
  });

  router.get('/api/notes/:id/versions/:version', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.id, 'view');
    const v = int(ctx.params.version, 0);
    const row = get(`SELECT * FROM note_versions WHERE note_id=? AND version=?`, resource.id, v);
    if (!row) throw httpError(404, '该版本不存在');
    sendJson(res, 200, { ok: true, version: { id: row.id, version: row.version, title: row.title, html: row.html, text: row.text, summary: row.summary, createdAt: row.created_at, chars: Number(row.chars || 0) } });
  });

  router.post('/api/notes/:id/versions/:version/restore', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.id, 'edit');
    const v = int(ctx.params.version, 0);
    const row = get(`SELECT * FROM note_versions WHERE note_id=? AND version=?`, resource.id, v);
    if (!row) throw httpError(404, '该版本不存在');
    const current = get(`SELECT * FROM notes WHERE id=?`, resource.id);
    // 先把当前内容存为版本，防止误操作丢失
    run(`INSERT INTO note_versions(id,note_id,version,title,html,text,editor_id,summary,chars,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
      randomId('nv'), resource.id, Number(current.version || 1) + 1, current.title, current.html,
      current.text, user.id, `恢复前快照（来自 v${v}）`, (current.text || '').length, nowIso());
    update('notes', resource.id, {
      title: row.title, html: row.html, text: row.text,
      word_count: wordCount(row.text || ''), version: Number(current.version || 1) + 2, updated_at: nowIso(), updated_by: user.id
    });
    const { indexEntity } = await import('../db.js');
    const { tokenize } = await import('../lib/text.js');
    const fresh = get(`SELECT * FROM notes WHERE id=?`, resource.id);
    indexEntity('note', resource.id, resource.workspace_id, tokenize(`${fresh.title}\n${fresh.title}\n${fresh.text}`));
    audit({ workspaceId: resource.workspace_id, userId: user.id, userName: user.name, action: 'note.version.restore', resourceType: 'note', resourceId: resource.id, detail: `v${v}` });
    sendJson(res, 200, { ok: true, note: serializeNote(fresh) });
  });

  router.post('/api/notes/:id/duplicate', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.id, 'view');
    requireWorkspace(user.id, resource.workspace_id, 'edit');
    const now = nowIso();
    const id = randomId('note');
    insert('notes', {
      id, workspace_id: resource.workspace_id, folder_id: resource.folder_id,
      title: `${resource.title} 副本`, html: resource.html, text: resource.text,
      summary: '', emoji: resource.emoji, tags: resource.tags, starred: 0, pinned: 0,
      created_by: user.id, updated_by: user.id, created_at: now, updated_at: now,
      version: 1, word_count: Number(resource.word_count || 0), view_count: 0
    });
    sendJson(res, 201, { ok: true, note: serializeNote(get(`SELECT * FROM notes WHERE id=?`, id)) });
  });

  router.post('/api/notes/batch', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { action, ids = [] } = ctx.body || {};
    if (!Array.isArray(ids) || !ids.length) throw httpError(400, '缺少 ids');
    const results = { ok: 0, failed: 0, errors: [] };
    for (const id of ids.slice(0, 500)) {
      try {
        const note = get(`SELECT * FROM notes WHERE id=?`, id);
        if (!note) throw new Error('笔记不存在');
        if (!permAtLeast(resourcePermission(user.id, 'note', note), 'edit')) throw new Error('权限不足');
        switch (action) {
          case 'delete': update('notes', id, { deleted_at: nowIso() }); break;
          case 'restore': update('notes', id, { deleted_at: null }); break;
          case 'move': update('notes', id, { folder_id: ctx.body.targetFolderId || null, updated_at: nowIso() }); break;
          case 'star': update('notes', id, { starred: 1 }); break;
          case 'unstar': update('notes', id, { starred: 0 }); break;
          case 'pin': update('notes', id, { pinned: 1 }); break;
          case 'unpin': update('notes', id, { pinned: 0 }); break;
          case 'tag': {
            const merged = [...new Set([...normalizeTags(note.tags), ...normalizeTags(ctx.body.tags || [])])];
            update('notes', id, { tags: JSON.stringify(syncTags(note.workspace_id, 'note', id, merged, user.id)) });
            break;
          }
          default: throw new Error(`不支持的操作：${action}`);
        }
        results.ok++;
      } catch (err) {
        results.failed++;
        results.errors.push({ id, error: err.message });
      }
    }
    sendJson(res, 200, { ok: true, ...results });
  });

  /* ============================== 检索 ============================== */

  router.get('/api/search', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const q = str(ctx.query.q, '', 300).trim();
    let workspaceIds = [];
    if (ctx.query.workspaceId && ctx.query.workspaceId !== 'all') {
      requireWorkspace(user.id, ctx.query.workspaceId, 'view');
      workspaceIds = [ctx.query.workspaceId];
    } else {
      workspaceIds = accessibleWorkspaces(user.id).map((w) => w.id);
    }
    if (!workspaceIds.length) return sendJson(res, 200, { ok: true, total: 0, items: [], terms: [] });
    if (!q) return sendJson(res, 200, { ok: true, total: 0, items: [], terms: [], hint: '请输入检索关键词' });

    const types = normalizeTags(ctx.query.types || 'file,note');
    const tags = normalizeTags(ctx.query.tags || '');
    const exts = normalizeTags(ctx.query.exts || '').map((e) => e.toLowerCase());
    const acl = buildSearchAcl(user.id, workspaceIds);

    const result = searchAll({
      workspaceIds, query: q, types, tags, exts,
      folderId: ctx.query.folderId && ctx.query.folderId !== 'all' ? ctx.query.folderId : null,
      starredOnly: bool(ctx.query.starred, false),
      mode: ['hybrid', 'keyword', 'vector', 'fuzzy'].includes(ctx.query.mode) ? ctx.query.mode : 'hybrid',
      limit: Math.max(1, Math.min(100, int(ctx.query.limit, 30))),
      offset: Math.max(0, int(ctx.query.offset, 0)),
      acl
    });

    audit({ userId: user.id, userName: user.name, action: 'search', resourceType: 'query', resourceName: q, detail: `${result.total} results in ${result.took}ms` });
    sendJson(res, 200, { ok: true, query: q, ...result });
  });

  router.get('/api/search/suggest', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const q = str(ctx.query.q, '', 120);
    let workspaceIds;
    if (ctx.query.workspaceId && ctx.query.workspaceId !== 'all') {
      requireWorkspace(user.id, ctx.query.workspaceId, 'view');
      workspaceIds = [ctx.query.workspaceId];
    } else {
      workspaceIds = accessibleWorkspaces(user.id).map((w) => w.id);
    }
    if (!workspaceIds.length || !q.trim()) return sendJson(res, 200, { ok: true, titles: [], terms: [] });
    sendJson(res, 200, { ok: true, ...suggest(workspaceIds, q, 8) });
  });

  router.get('/api/workspaces/:id/tagcloud', async (req, res, ctx) => {
    const user = ctx.requireUser();
    requireWorkspace(user.id, ctx.params.id, 'view');
    sendJson(res, 200, { ok: true, tags: tagCloud([ctx.params.id]) });
  });

  /* ============================== 共享 / 权限 ============================== */

  router.get('/api/shares', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const resourceType = str(ctx.query.resourceType, '', 20);
    const resourceId = str(ctx.query.resourceId, '', 80);
    if (!['file', 'note'].includes(resourceType)) throw httpError(400, 'resourceType 不合法');
    requireResource(user.id, resourceType, resourceId, 'view');
    sendJson(res, 200, { ok: true, shares: sharesForResource(resourceType, resourceId) });
  });

  router.post('/api/shares', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resourceType, resourceId, granteeType = 'user', granteeId = null, permission = 'view', expiresInDays = null } = ctx.body || {};
    requireBody(ctx.body || {}, ['resourceType', 'resourceId']);
    if (!['file', 'note', 'folder'].includes(resourceType)) throw httpError(400, 'resourceType 不合法');
    const { resource } = requireResource(user.id, resourceType, resourceId, 'manage');

    const expiresAt = expiresInDays ? new Date(Date.now() + Number(expiresInDays) * 86400000).toISOString() : null;
    const share = createShare({
      workspaceId: resource.workspace_id, resourceType, resourceId, ownerId: user.id,
      granteeType, granteeId: granteeType === 'link' ? null : granteeId,
      permission, expiresAt
    });
    if (granteeType === 'user' && granteeId) {
      insert('notifications', {
        id: randomId('ntf'), user_id: granteeId, kind: 'share',
        title: `有人向你共享了${resourceType === 'file' ? '文件' : '笔记'}`,
        body: resource.name || resource.title || '', link: `/share/${share.token || ''}`,
        read: 0, created_at: nowIso()
      });
      publish(`user:${granteeId}`, { type: 'share.created', resourceType, resourceId });
    }
    audit({ workspaceId: resource.workspace_id, userId: user.id, userName: user.name, action: 'share.create', resourceType, resourceId, resourceName: resource.name || resource.title, permission, detail: `${granteeType}:${granteeId || ''}` });
    sendJson(res, 201, { ok: true, share: sharesForResource(resourceType, resourceId) });
  });

  router.delete('/api/shares/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    deleteShare(user.id, ctx.params.id);
    sendJson(res, 200, { ok: true });
  });

  /** 通过分享链接读取资源 */
  router.get('/api/share/:token', async (req, res, ctx) => {
    const { shareByToken, publicUser } = await import('../auth.js');
    const share = shareByToken(ctx.params.token);
    if (!share) throw httpError(404, '分享链接不存在或已过期');
    const table = share.resource_type === 'file' ? 'files' : 'notes';
    const resource = get(`SELECT * FROM ${table} WHERE id=?`, share.resource_id);
    if (!resource) throw httpError(404, '资源已被删除');
    const owner = get(`SELECT id,name,avatar FROM users WHERE id=?`, share.owner_id);
    sendJson(res, 200, {
      ok: true,
      permission: share.permission,
      owner: owner ? { id: owner.id, name: owner.name, avatar: owner.avatar } : null,
      resourceType: share.resource_type,
      resource: share.resource_type === 'file' ? serializeFile(fileRow(resource.id)) : serializeNote(resource)
    });
  });

  /* ============================== 评论 / 协作 ============================== */

  router.get('/api/comments', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const resourceType = str(ctx.query.resourceType, '', 20);
    const resourceId = str(ctx.query.resourceId, '', 80);
    requireResource(user.id, resourceType === 'file' ? 'file' : 'note', resourceId, 'view');
    const rows = all(
      `SELECT c.*, u.name AS user_name, u.avatar AS user_avatar
         FROM comments c LEFT JOIN users u ON u.id=c.user_id
        WHERE c.resource_type=? AND c.resource_id=? ORDER BY c.created_at ASC`,
      resourceType, resourceId
    );
    sendJson(res, 200, {
      ok: true,
      comments: rows.map((r) => ({
        id: r.id, body: r.body, parentId: r.parent_id, resolved: !!r.resolved,
        userId: r.user_id, userName: r.user_name || '已注销用户', userAvatar: r.user_avatar || '',
        createdAt: r.created_at, updatedAt: r.updated_at
      }))
    });
  });

  router.post('/api/comments', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resourceType, resourceId, body, parentId = null } = ctx.body || {};
    requireBody(ctx.body || {}, ['resourceType', 'resourceId', 'body']);
    const { resource, permission } = requireResource(user.id, resourceType === 'file' ? 'file' : 'note', resourceId, 'comment');
    const id = randomId('cmt');
    const now = nowIso();
    insert('comments', {
      id, workspace_id: resource.workspace_id, resource_type: resourceType, resource_id: resourceId,
      user_id: user.id, body: str(body, '', 4000), parent_id: parentId, resolved: 0,
      created_at: now, updated_at: now
    });
    const payload = { type: 'comment.created', id, resourceType, resourceId, userId: user.id, userName: user.name, body: str(body, '', 4000), createdAt: now };
    publishResource(resourceType, resourceId, payload);
    sendJson(res, 201, { ok: true, comment: { id, ...payload, permission } });
  });

  router.patch('/api/comments/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const c = get(`SELECT * FROM comments WHERE id=?`, ctx.params.id);
    if (!c) throw httpError(404, '评论不存在');
    if (c.user_id !== user.id) throw httpError(403, '只能修改自己的评论');
    const patch = { updated_at: nowIso() };
    if (ctx.body?.body !== undefined) patch.body = str(ctx.body.body, '', 4000);
    if (ctx.body?.resolved !== undefined) patch.resolved = bool(ctx.body.resolved) ? 1 : 0;
    update('comments', c.id, patch);
    publishResource(c.resource_type, c.resource_id, { type: 'comment.updated', id: c.id });
    sendJson(res, 200, { ok: true });
  });

  router.delete('/api/comments/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const c = get(`SELECT * FROM comments WHERE id=?`, ctx.params.id);
    if (!c) throw httpError(404, '评论不存在');
    if (c.user_id !== user.id) throw httpError(403, '只能删除自己的评论');
    run(`DELETE FROM comments WHERE id=?`, c.id);
    publishResource(c.resource_type, c.resource_id, { type: 'comment.deleted', id: c.id });
    sendJson(res, 200, { ok: true });
  });

  /** 协作实时通道 */
  router.get('/api/collab/:resourceType/:resourceId/stream', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.resourceId, 'view');
    sseStart(res);
    sseSend(res, 'presence', { userId: user.id, name: user.name, avatar: user.avatar || '', at: nowIso() });

    const unsub = subscribe(`res:note:${ctx.params.resourceId}`, (payload) => {
      if (payload.userId === user.id) return;
      sseSend(res, payload.type || 'message', payload);
    });
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* */ } }, 20000);
    const cleanup = () => { clearInterval(ping); unsub(); };
    req.on('close', cleanup);
    req.on('error', cleanup);
  });

  /** 协作编辑期间的内容广播（轻量 OT：后写覆盖 + 冲突提示） */
  router.post('/api/collab/:resourceType/:resourceId/patch', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.resourceId, 'edit');
    const payload = {
      type: 'note.patch', noteId: resource.id, userId: user.id, userName: user.name,
      version: int(ctx.body?.version, resource.version), at: nowIso()
    };
    publishResource('note', resource.id, payload);
    publishWorkspace(resource.workspace_id, { type: 'note.activity', noteId: resource.id, userName: user.name });
    sendJson(res, 200, { ok: true, peers: subscriberCount(`res:note:${resource.id}`) });
  });

  /** 编辑锁：避免多人同时编辑同一笔记 */
  router.post('/api/locks/:resourceType/:resourceId', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.resourceId, 'edit');
    const existing = get(`SELECT * FROM locks WHERE resource_type=? AND resource_id=?`, ctx.params.resourceType, ctx.params.resourceId);
    if (existing && existing.user_id !== user.id && Date.parse(existing.expires_at) > Date.now()) {
      return sendJson(res, 200, { ok: true, locked: true, holder: { id: existing.user_id, name: existing.holder_name }, expiresAt: existing.expires_at });
    }
    const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    run(`INSERT INTO locks(id,resource_type,resource_id,user_id,holder_name,acquired_at,expires_at) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT(resource_type,resource_id) DO UPDATE SET user_id=excluded.user_id, holder_name=excluded.holder_name, acquired_at=excluded.acquired_at, expires_at=excluded.expires_at`,
      randomId('lck'), ctx.params.resourceType, ctx.params.resourceId, user.id, user.name, nowIso(), expires);
    publishResource(ctx.params.resourceType, ctx.params.resourceId, { type: 'lock', userId: user.id, userName: user.name, expiresAt: expires });
    sendJson(res, 200, { ok: true, locked: false, expiresAt: expires });
  });

  router.delete('/api/locks/:resourceType/:resourceId', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const lock = get(`SELECT * FROM locks WHERE resource_type=? AND resource_id=?`, ctx.params.resourceType, ctx.params.resourceId);
    if (lock && lock.user_id === user.id) {
      run(`DELETE FROM locks WHERE id=?`, lock.id);
      publishResource(ctx.params.resourceType, ctx.params.resourceId, { type: 'unlock', userId: user.id });
    }
    sendJson(res, 200, { ok: true });
  });

  /* ============================== 笔记内嵌资源 ============================== */

  router.post('/api/uploads/asset', async (req, res, ctx) => {
    const user = ctx.requireUser();
    if (!isMultipart(req)) throw httpError(400, '请使用 multipart/form-data 上传');
    const parsed = await parseMultipart(req, { tmpDir: TMP_DIR, maxBytes: 30 * 1024 * 1024, maxFiles: 10 });
    const workspaceId = str(parsed.fields.workspaceId, '', 80) || null;
    const noteId = str(parsed.fields.noteId, '', 80) || null;
    if (workspaceId) requireWorkspace(user.id, workspaceId, 'edit');
    if (noteId) requireResource(user.id, 'note', noteId, 'edit');
    if (!parsed.files.length) throw httpError(400, '没有接收到文件');
    const out = [];
    for (const f of parsed.files) {
      if (!/^image\//.test(f.contentType)) {
        await fsp.unlink(f.tmpPath).catch(() => {});
        throw httpError(400, `仅支持图片资源，收到：${f.contentType}`);
      }
      const id = randomId('asset');
      const { ext } = splitExt(f.filename);
      const key = path.posix.join('assets', String(workspaceId || 'common'), `${id}${ext ? '.' + ext : ''}`);
      const saved = await persistUpload(f.tmpPath, key, { encrypt: false });
      insert('assets', {
        id, workspace_id: workspaceId, note_id: noteId, user_id: user.id,
        name: f.filename, mime: f.contentType, size: saved.size, storage_key: key, created_at: nowIso()
      });
      out.push({ id, url: `/api/assets/${id}`, name: f.filename, size: saved.size, mime: f.contentType });
    }
    sendJson(res, 201, { ok: true, assets: out, url: out[0]?.url });
  });

  router.get('/api/assets/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const asset = get(`SELECT * FROM assets WHERE id=?`, ctx.params.id);
    if (!asset) throw httpError(404, '资源不存在');
    if (asset.note_id) requireResource(user.id, 'note', asset.note_id, 'view');
    else if (asset.workspace_id) requireWorkspace(user.id, asset.workspace_id, 'view');
    else if (asset.user_id !== user.id) throw httpError(403, '无权访问该资源');
    const buf = await readStored(asset.storage_key, false).catch(() => null);
    if (!buf) throw httpError(404, '资源文件缺失');
    res.writeHead(200, {
      'Content-Type': asset.mime,
      'Content-Length': buf.length,
      'Cache-Control': 'private, max-age=86400'
    });
    res.end(buf);
  });

  /* ============================== 导出 ============================== */

  router.get('/api/files/:id/export', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'file', ctx.params.id, 'view');
    const format = String(ctx.query.format || 'md');
    const row = get(`SELECT * FROM file_text WHERE file_id=?`, resource.id);
    if (!row?.text) throw httpError(400, '该文件尚未解析出文本内容');

    let body = '';
    let mime = 'text/markdown; charset=utf-8';
    let filename = `${splitExt(resource.name).base}.${format}`;

    if (format === 'txt') {
      body = row.text;
      mime = 'text/plain; charset=utf-8';
      filename = `${splitExt(resource.name).base}.txt`;
    } else if (format === 'html') {
      body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(resource.name)}</title>
<style>body{max-width:820px;margin:48px auto;padding:0 24px;font:16px/1.75 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1F2937}
h1,h2,h3{line-height:1.3}pre{background:#F9FAFB;padding:14px;border-radius:8px;overflow:auto}table{border-collapse:collapse;width:100%}
td,th{border:1px solid #E5E7EB;padding:8px 10px}img{max-width:100%}</style></head>
<body><h1>${escapeHtml(resource.name)}</h1>${row.html || `<pre>${escapeHtml(row.text)}</pre>`}</body></html>`;
      mime = 'text/html; charset=utf-8';
      filename = `${splitExt(resource.name).base}.html`;
    } else {
      body = `# ${resource.name}\n\n> 由 KBPRO 导出 · ${nowIso()}\n> 类型：${resource.mime} · 大小：${formatBytes(resource.size)} · 分块页数：${row.page_count || 0}\n\n---\n\n${row.text}`;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Disposition': contentDisposition(filename, 'attachment'),
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  });

  router.get('/api/notes/:id/export', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { resource } = requireResource(user.id, 'note', ctx.params.id, 'view');
    const format = String(ctx.query.format || 'md');
    let body;
    let mime;
    let filename;
    if (format === 'html') {
      body = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(resource.title)}</title>
<style>body{max-width:820px;margin:48px auto;padding:0 24px;font:16px/1.75 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1F2937}
pre{background:#F9FAFB;padding:14px;border-radius:8px;overflow:auto}table{border-collapse:collapse;width:100%}td,th{border:1px solid #E5E7EB;padding:8px 10px}img{max-width:100%}</style></head>
<body><h1>${escapeHtml(resource.title)}</h1>${resource.html}</body></html>`;
      mime = 'text/html; charset=utf-8';
      filename = `${resource.title}.html`;
    } else {
      body = `# ${resource.title}\n\n> 由 KBPRO 导出 · ${nowIso()} · 版本 v${resource.version} · ${resource.word_count} 字\n\n---\n\n${resource.text}`;
      mime = 'text/markdown; charset=utf-8';
      filename = `${resource.title}.md`;
    }
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Disposition': contentDisposition(filename, 'attachment'),
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  });
}

/* ------------------------------------------------------------------ 内部 */

async function hardDeleteFile(file, user) {
  try { await deleteStored(file.storage_key); } catch { /* */ }
  const { removeFileIndex } = await import('../lib/rag.js');
  removeFileIndex(file.id);
  tx((d) => {
    d.prepare(`DELETE FROM file_text WHERE file_id=?`).run(file.id);
    d.prepare(`DELETE FROM entity_tags WHERE entity_type='file' AND entity_id=?`).run(file.id);
    d.prepare(`DELETE FROM shares WHERE resource_type='file' AND resource_id=?`).run(file.id);
    d.prepare(`DELETE FROM comments WHERE resource_type='file' AND resource_id=?`).run(file.id);
    d.prepare(`DELETE FROM files WHERE id=?`).run(file.id);
  });
  run(`UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id=?`, Number(file.size || 0), file.created_by);
  audit({ workspaceId: file.workspace_id, userId: user.id, userName: user.name, action: 'file.delete.hard', resourceType: 'file', resourceId: file.id, resourceName: file.name });
}

export { serializeFile, serializeNote };
