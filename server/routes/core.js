/**
 * KBPRO — 路由：认证 / 用户 / 知识库 / 团队 / 文件夹 / 标签
 */
import { all, get, run, insert, update, tx, nowIso, audit, scalar, tableCounts, dbSizeBytes } from '../db.js';
import { randomId, passwordStrength, encryptText } from '../lib/crypto.js';
import { httpError, sendJson, clientIp, formatBytes } from '../lib/http.js';
import { loadConfig, saveConfig } from '../config.js';
import {
  registerUser, loginUser, createSession, destroySession, destroyAllSessions, requireUser, requireAdmin,
  publicUser, findUserById, findUserByEmail, changePassword, ensurePersonalWorkspace, ensureDefaults,
  accessibleWorkspaces, requireWorkspace, workspacePermission, sharesForResource, createShare, deleteShare,
  TEAM_ROLES, ROLE_TO_PERM, permAtLeast, audit as auditLog, buildSearchAcl, COOKIE_NAME, cookieHeader
} from '../auth.js';
import {
  folderTree, createFolder, moveFolder, deleteFolder, breadcrumb, refreshFolderPaths, isDescendant
} from '../lib/tags.js';
import { workspaceTags, renameTag, deleteTag, cleanupOrphanTags } from '../lib/tags.js';
import { normalizeTags } from '../lib/text.js';
import { probeAi, probeAiConfig, resolveAiConfig, assertSafeAiBaseUrlAsync, baseUrlPolicy } from '../lib/ai.js';

/* ------------------------------------------------------------------ 校验工具 */

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

function setCookie(res, value) {
  res.setHeader('Set-Cookie', value);
}

/* ------------------------------------------------------------------ 注册 */

export function registerCoreRoutes(router) {

  /* ============================== 认证 ============================== */

  router.post('/api/auth/register', async (req, res, ctx) => {
    const { name, email, password } = ctx.body || {};
    requireBody(ctx.body || {}, ['email', 'password']);
    const user = registerUser({ name, email, password });
    const { token, expiresAt } = createSession(user.id, { ip: clientIp(req), ua: req.headers['user-agent'] || '' });
    setCookie(res, cookieHeader(token));
    audit({ userId: user.id, userName: user.name, action: 'user.register', resourceType: 'user', resourceId: user.id, ip: clientIp(req) });
    sendJson(res, 201, { ok: true, user: publicUser(user, { self: true }), token, expiresAt });
  });

  router.post('/api/auth/login', async (req, res, ctx) => {
    const { email, password } = ctx.body || {};
    requireBody(ctx.body || {}, ['email', 'password']);
    const user = loginUser({ email, password, ip: clientIp(req), ua: req.headers['user-agent'] || '' });
    const { token, expiresAt } = createSession(user.id, { ip: clientIp(req), ua: req.headers['user-agent'] || '' });
    setCookie(res, cookieHeader(token));
    sendJson(res, 200, { ok: true, user: publicUser(user, { self: true }), token, expiresAt });
  });

  router.post('/api/auth/logout', async (req, res, ctx) => {
    const token = ctx.token || '';
    destroySession(token);
    setCookie(res, cookieHeader('', { clear: true }));
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/auth/me', async (req, res, ctx) => {
    const user = ctx.user;
    if (!user) return sendJson(res, 200, { ok: true, user: null, workspaces: [], teams: [], ai: null });
    const workspaces = accessibleWorkspaces(user.id);
    const teams = all(
      `SELECT t.*, tm.role AS my_role FROM teams t
         JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=? AND tm.status='active'
        ORDER BY t.created_at`,
      user.id
    ).map((t) => ({ id: t.id, name: t.name, slug: t.slug, description: t.description, role: t.my_role, plan: t.plan }));
    let ai = null;
    try { ai = await probeAi(user); } catch (e) { ai = { provider: 'local', available: true, note: e.message }; }
    sendJson(res, 200, { ok: true, user: publicUser(user, { self: true }), workspaces, teams, ai });
  });

  /* ============================== 个人中心 ============================== */

  router.patch('/api/users/me', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { name, title, bio, avatar, settings } = ctx.body || {};
    const patch = { updated_at: nowIso() };
    if (name !== undefined) {
      const n = str(name, '', 60).trim();
      if (!n) throw httpError(400, '昵称不能为空');
      patch.name = n;
    }
    if (title !== undefined) patch.title = str(title, '', 80);
    if (bio !== undefined) patch.bio = str(bio, '', 500);
    if (avatar !== undefined) patch.avatar = str(avatar, '', 400000);
    if (settings !== undefined && typeof settings === 'object') patch.settings = JSON.stringify(settings).slice(0, 20000);
    update('users', user.id, patch);
    sendJson(res, 200, { ok: true, user: publicUser(findUserById(user.id), { self: true }) });
  });

  router.post('/api/users/me/password', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { oldPassword, newPassword } = ctx.body || {};
    requireBody(ctx.body || {}, ['oldPassword', 'newPassword']);
    changePassword(user.id, oldPassword, newPassword);
    // 重新签发当前会话
    const { token } = createSession(user.id, { ip: clientIp(req), ua: req.headers['user-agent'] || '' });
    setCookie(res, cookieHeader(token));
    audit({ userId: user.id, userName: user.name, action: 'user.password.change', resourceType: 'user', resourceId: user.id });
    sendJson(res, 200, { ok: true, token, strength: passwordStrength(newPassword) });
  });

  router.get('/api/users/me/storage', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const used = Number(scalar(`SELECT IFNULL(SUM(size),0) FROM files WHERE created_by=? AND deleted_at IS NULL`, user.id) || 0);
    const trashed = Number(scalar(`SELECT IFNULL(SUM(size),0) FROM files WHERE created_by=? AND deleted_at IS NOT NULL`, user.id) || 0);
    const byType = all(
      `SELECT ext, COUNT(*) AS n, IFNULL(SUM(size),0) AS bytes FROM files
        WHERE created_by=? AND deleted_at IS NULL GROUP BY ext ORDER BY bytes DESC LIMIT 12`,
      user.id
    );
    sendJson(res, 200, {
      ok: true,
      used, trashed, quota: Number(user.storage_quota || 0),
      usedText: formatBytes(used), trashedText: formatBytes(trashed),
      byType: byType.map((r) => ({ ext: r.ext || '—', count: Number(r.n), bytes: Number(r.bytes), text: formatBytes(r.bytes) }))
    });
  });

  router.get('/api/users/me/ai', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const conf = resolveAiConfig(user);
    const status = await probeAi(user);
    sendJson(res, 200, {
      ok: true,
      status,
      config: {
        provider: user.ai_provider || '', model: user.ai_model || '',
        baseUrl: user.ai_base_url || '', hasKey: Boolean(user.ai_key_enc),
        effective: { provider: conf.provider, model: conf.chatModel, baseUrl: conf.baseUrl }
      },
      global: (() => { const c = loadConfig(); return { provider: c.ai.provider, baseUrl: c.ai.baseUrl, chatModel: c.ai.chatModel, hasKey: Boolean(c.ai.apiKey), ollamaUrl: c.ai.ollamaUrl }; })()
    });
  });

  /**
   * 测试连接：用表单当前值（未保存也可）探测，不写库。
   * body: { provider, model, baseUrl, apiKey }
   */
  router.post('/api/users/me/ai/test', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { provider, model, baseUrl, apiKey } = ctx.body || {};
    if (provider !== undefined && provider !== null && provider !== ''
      && !['auto', 'ollama', 'openai', 'local'].includes(String(provider).toLowerCase())) {
      throw httpError(400, '不支持的 AI 提供商');
    }
    if (baseUrl !== undefined && baseUrl !== null && baseUrl !== ''
      && !/^https?:\/\//i.test(String(baseUrl).trim())) {
      throw httpError(400, 'Base URL 必须以 http:// 或 https:// 开头');
    }
    // SSRF 防护：Base URL 指向哪里，服务端就会去请求哪里，必须在这里拦下来
    if (baseUrl) {
      const verdict = await assertSafeAiBaseUrlAsync(String(baseUrl).trim(), baseUrlPolicy());
      if (!verdict.ok) throw httpError(400, verdict.reason);
    }
    // 以「已保存配置」为底，表单值覆盖；密钥留空则沿用已保存的
    const effectiveUser = {
      ai_provider: provider ?? user.ai_provider,
      ai_model: model ?? user.ai_model,
      ai_base_url: baseUrl ?? user.ai_base_url,
      ai_key_enc: apiKey ? encryptText(String(apiKey).slice(0, 500)) : user.ai_key_enc
    };
    // 表单未提供 baseUrl 时，也要校验已保存的值
    if (!baseUrl && effectiveUser.ai_base_url) {
      const verdict = await assertSafeAiBaseUrlAsync(String(effectiveUser.ai_base_url).trim(), baseUrlPolicy());
      if (!verdict.ok) throw httpError(400, verdict.reason);
    }
    const conf = resolveAiConfig(effectiveUser);
    const status = await probeAiConfig(conf);
    sendJson(res, 200, { ok: true, status });
  });

  router.put('/api/users/me/ai', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { provider, model, baseUrl, apiKey, clearKey } = ctx.body || {};
    const patch = { updated_at: nowIso() };
    if (provider !== undefined) {
      const p = String(provider).toLowerCase();
      if (!['auto', 'ollama', 'openai', 'local', ''].includes(p)) throw httpError(400, '不支持的 AI 提供商');
      patch.ai_provider = p;
    }
    if (model !== undefined) patch.ai_model = str(model, '', 120);
    if (baseUrl !== undefined) {
      const u = str(baseUrl, '', 300).trim();
      if (u && !/^https?:\/\//i.test(u)) throw httpError(400, 'Base URL 必须以 http(s):// 开头');
      // SSRF 防护：保存下来的地址会在后续每次对话时由服务端发起请求
      if (u) {
        const verdict = await assertSafeAiBaseUrlAsync(u, baseUrlPolicy());
        if (!verdict.ok) throw httpError(400, verdict.reason);
      }
      patch.ai_base_url = u;
    }
    if (clearKey) patch.ai_key_enc = '';
    else if (apiKey) patch.ai_key_enc = encryptText(String(apiKey).slice(0, 500));
    update('users', user.id, patch);
    audit({ userId: user.id, userName: user.name, action: 'user.ai.config', resourceType: 'user', resourceId: user.id, detail: `provider=${patch.ai_provider ?? ''}` });
    const status = await probeAi(findUserById(user.id));
    sendJson(res, 200, { ok: true, status });
  });

  router.get('/api/users/search', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const q = str(ctx.query.q, '', 120).trim();
    if (!q) return sendJson(res, 200, { ok: true, users: [] });
    const like = `%${q.replace(/[%_]/g, (c) => '\\' + c)}%`;
    const rows = all(
      `SELECT id, name, email, title, avatar FROM users
        WHERE status='active' AND id<>? AND (name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
        LIMIT 12`,
      user.id, like, like
    );
    sendJson(res, 200, { ok: true, users: rows });
  });

  /* ============================== 知识库 ============================== */

  router.get('/api/workspaces', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const list = accessibleWorkspaces(user.id);
    const enriched = list.map((w) => {
      const files = Number(scalar(`SELECT COUNT(*) FROM files WHERE workspace_id=? AND deleted_at IS NULL`, w.id) || 0);
      const notes = Number(scalar(`SELECT COUNT(*) FROM notes WHERE workspace_id=? AND deleted_at IS NULL`, w.id) || 0);
      const folders = Number(scalar(`SELECT COUNT(*) FROM folders WHERE workspace_id=? AND deleted_at IS NULL`, w.id) || 0);
      const bytes = Number(scalar(`SELECT IFNULL(SUM(size),0) FROM files WHERE workspace_id=? AND deleted_at IS NULL`, w.id) || 0);
      const members = w.teamId ? Number(scalar(`SELECT COUNT(*) FROM team_members WHERE team_id=? AND status='active'`, w.teamId) || 0) : 1;
      return { ...w, stats: { files, notes, folders, bytes, members, sizeText: formatBytes(bytes) } };
    });
    sendJson(res, 200, { ok: true, workspaces: enriched });
  });

  router.post('/api/workspaces', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { name, kind = 'personal', teamId = null, description = '', color = '#1F2937', icon = 'folder' } = ctx.body || {};
    const clean = str(name, '', 60).trim();
    if (!clean) throw httpError(400, '知识库名称不能为空');
    if (!['personal', 'team'].includes(kind)) throw httpError(400, 'kind 只能是 personal 或 team');

    if (kind === 'team') {
      if (!teamId) throw httpError(400, '团队知识库必须指定团队');
      const member = get(`SELECT * FROM team_members WHERE team_id=? AND user_id=? AND status='active'`, teamId, user.id);
      if (!member || !permAtLeast(ROLE_TO_PERM[member.role], 'manage')) throw httpError(403, '需要团队管理员权限');
    }

    const now = nowIso();
    const id = randomId('ws');
    insert('workspaces', {
      id, name: clean, kind, owner_id: user.id, team_id: kind === 'team' ? teamId : null,
      description: str(description, '', 300), color: str(color, '#1F2937', 20), icon: str(icon, 'folder', 40),
      is_default: 0, created_at: now, updated_at: now
    });
    const { createDefaultFolders } = await import('../auth.js');
    createDefaultFolders(id, user.id);
    audit({ workspaceId: id, userId: user.id, userName: user.name, action: 'workspace.create', resourceType: 'workspace', resourceId: id, resourceName: clean });
    sendJson(res, 201, { ok: true, workspace: get(`SELECT * FROM workspaces WHERE id=?`, id) });
  });

  router.patch('/api/workspaces/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { workspace } = requireWorkspace(user.id, ctx.params.id, 'manage');
    const { name, description, color, icon } = ctx.body || {};
    const patch = { updated_at: nowIso() };
    if (name !== undefined) {
      const n = str(name, '', 60).trim();
      if (!n) throw httpError(400, '名称不能为空');
      patch.name = n;
    }
    if (description !== undefined) patch.description = str(description, '', 300);
    if (color !== undefined) patch.color = str(color, '#1F2937', 20);
    if (icon !== undefined) patch.icon = str(icon, 'folder', 40);
    update('workspaces', workspace.id, patch);
    sendJson(res, 200, { ok: true, workspace: get(`SELECT * FROM workspaces WHERE id=?`, workspace.id) });
  });

  router.delete('/api/workspaces/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { workspace } = requireWorkspace(user.id, ctx.params.id, 'manage');
    if (workspace.owner_id !== user.id && user.role !== 'admin') throw httpError(403, '只有创建者可删除知识库');
    const total = Number(scalar(`SELECT COUNT(*) FROM workspaces WHERE owner_id=? AND kind='personal'`, user.id) || 0);
    if (workspace.kind === 'personal' && total <= 1) throw httpError(400, '至少需要保留一个个人知识库');
    const now = nowIso();
    tx((d) => {
      d.prepare(`UPDATE files SET deleted_at=? WHERE workspace_id=?`).run(now, workspace.id);
      d.prepare(`UPDATE notes SET deleted_at=? WHERE workspace_id=?`).run(now, workspace.id);
      d.prepare(`UPDATE folders SET deleted_at=? WHERE workspace_id=?`).run(now, workspace.id);
      d.prepare(`DELETE FROM workspaces WHERE id=?`).run(workspace.id);
    });
    audit({ workspaceId: workspace.id, userId: user.id, userName: user.name, action: 'workspace.delete', resourceType: 'workspace', resourceId: workspace.id, resourceName: workspace.name });
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/workspaces/:id/overview', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { workspace } = requireWorkspace(user.id, ctx.params.id, 'view');
    const wsId = workspace.id;
    const files = Number(scalar(`SELECT COUNT(*) FROM files WHERE workspace_id=? AND deleted_at IS NULL`, wsId) || 0);
    const notes = Number(scalar(`SELECT COUNT(*) FROM notes WHERE workspace_id=? AND deleted_at IS NULL`, wsId) || 0);
    const folders = Number(scalar(`SELECT COUNT(*) FROM folders WHERE workspace_id=? AND deleted_at IS NULL`, wsId) || 0);
    const bytes = Number(scalar(`SELECT IFNULL(SUM(size),0) FROM files WHERE workspace_id=? AND deleted_at IS NULL`, wsId) || 0);
    const chunks = Number(scalar(`SELECT COUNT(*) FROM chunks WHERE workspace_id=?`, wsId) || 0);
    const parseOk = Number(scalar(`SELECT COUNT(*) FROM file_text WHERE workspace_id=? AND status='ok'`, wsId) || 0);
    const parsePending = Number(scalar(`SELECT COUNT(*) FROM file_text WHERE workspace_id=? AND status IN ('pending','processing')`, wsId) || 0);
    const parseFailed = Number(scalar(`SELECT COUNT(*) FROM file_text WHERE workspace_id=? AND status='failed'`, wsId) || 0);
    const starred = Number(scalar(`SELECT COUNT(*) FROM files WHERE workspace_id=? AND starred=1 AND deleted_at IS NULL`, wsId) || 0);
    const pinned = Number(scalar(`SELECT COUNT(*) FROM files WHERE workspace_id=? AND pinned=1 AND deleted_at IS NULL`, wsId) || 0);
    const chats = Number(scalar(`SELECT COUNT(*) FROM chats WHERE workspace_id=?`, wsId) || 0);
    const members = workspace.team_id
      ? all(`SELECT u.id,u.name,u.email,u.avatar,tm.role FROM team_members tm JOIN users u ON u.id=tm.user_id
              WHERE tm.team_id=? AND tm.status='active' ORDER BY tm.joined_at LIMIT 12`, workspace.team_id)
      : [];

    const acl = buildSearchAcl(user.id, [wsId]);
    const fileScope = acl.allowedFileIds
      ? ` AND id IN (${[...acl.allowedFileIds].map(() => '?').join(',') || "''"})` : '';
    const noteScope = acl.allowedNoteIds
      ? ` AND id IN (${[...acl.allowedNoteIds].map(() => '?').join(',') || "''"})` : '';
    const fileScopeParams = acl.allowedFileIds ? [...acl.allowedFileIds] : [];
    const noteScopeParams = acl.allowedNoteIds ? [...acl.allowedNoteIds] : [];

    const recentFiles = all(
      `SELECT id, name, ext, size, updated_at, starred, pinned FROM files
        WHERE workspace_id=? AND deleted_at IS NULL${fileScope} ORDER BY updated_at DESC LIMIT 8`,
      wsId, ...fileScopeParams
    );
    const recentNotes = all(
      `SELECT id, title, emoji, updated_at, word_count FROM notes
        WHERE workspace_id=? AND deleted_at IS NULL${noteScope} ORDER BY updated_at DESC LIMIT 8`,
      wsId, ...noteScopeParams
    );
    const topTags = workspaceTags(wsId).sort((a, b) => b.count - a.count).slice(0, 14);
    const byExt = all(
      `SELECT ext, COUNT(*) AS n FROM files WHERE workspace_id=? AND deleted_at IS NULL${fileScope} GROUP BY ext ORDER BY n DESC LIMIT 8`,
      wsId, ...fileScopeParams
    );

    const trend = [];
    for (let i = 13; i >= 0; i--) {
      const day = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const fc = Number(scalar(`SELECT COUNT(*) FROM files WHERE workspace_id=? AND substr(created_at,1,10)=?`, wsId, day) || 0);
      const nc = Number(scalar(`SELECT COUNT(*) FROM notes WHERE workspace_id=? AND substr(created_at,1,10)=?`, wsId, day) || 0);
      trend.push({ date: day, files: fc, notes: nc });
    }

    sendJson(res, 200, {
      ok: true,
      workspace,
      stats: {
        files, notes, folders, chunks, bytes, sizeText: formatBytes(bytes),
        parse: { ok: parseOk, pending: parsePending, failed: parseFailed },
        starred, pinned, chats, members: members.length
      },
      recentFiles, recentNotes, topTags, byExt, trend, members
    });
  });

  router.get('/api/workspaces/:id/activity', async (req, res, ctx) => {
    const user = ctx.requireUser();
    requireWorkspace(user.id, ctx.params.id, 'view');
    const limit = Math.max(1, Math.min(200, int(ctx.query.limit, 60)));
    const rows = all(
      `SELECT id, user_id, user_name, action, resource_type, resource_id, resource_name, created_at, detail
         FROM access_logs WHERE workspace_id=? ORDER BY id DESC LIMIT ?`, ctx.params.id, limit
    );
    sendJson(res, 200, { ok: true, activity: rows });
  });

  /* ============================== 团队 ============================== */

  router.get('/api/teams', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const rows = all(
      `SELECT t.*, tm.role AS my_role,
              (SELECT COUNT(*) FROM team_members m WHERE m.team_id=t.id AND m.status='active') AS member_count,
              (SELECT COUNT(*) FROM workspaces w WHERE w.team_id=t.id) AS workspace_count
         FROM teams t JOIN team_members tm ON tm.team_id=t.id AND tm.user_id=?
        WHERE tm.status='active' ORDER BY t.created_at`, user.id
    );
    sendJson(res, 200, { ok: true, teams: rows.map((t) => ({ ...t, my_role: t.my_role })) });
  });

  router.post('/api/teams', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { name, description = '' } = ctx.body || {};
    const clean = str(name, '', 60).trim();
    if (!clean) throw httpError(400, '团队名称不能为空');
    const now = nowIso();
    const id = randomId('team');
    let slug = clean.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-|-$/g, '') || 'team';
    if (get(`SELECT id FROM teams WHERE slug=?`, slug)) slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
    insert('teams', { id, name: clean, slug, description: str(description, '', 300), owner_id: user.id, plan: 'team', created_at: now, updated_at: now });
    insert('team_members', { team_id: id, user_id: user.id, role: 'owner', status: 'active', invited_by: user.id, joined_at: now });
    const wsId = randomId('ws');
    insert('workspaces', {
      id: wsId, name: `${clean}知识库`, kind: 'team', owner_id: user.id, team_id: id,
      description: '团队共享知识库', color: '#374151', icon: 'users', is_default: 0, created_at: now, updated_at: now
    });
    const { createDefaultFolders } = await import('../auth.js');
    createDefaultFolders(wsId, user.id);
    audit({ workspaceId: wsId, userId: user.id, userName: user.name, action: 'team.create', resourceType: 'team', resourceId: id, resourceName: clean });
    sendJson(res, 201, { ok: true, team: get(`SELECT * FROM teams WHERE id=?`, id), workspaceId: wsId });
  });

  router.patch('/api/teams/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const team = get(`SELECT * FROM teams WHERE id=?`, ctx.params.id);
    if (!team) throw httpError(404, '团队不存在');
    const member = get(`SELECT * FROM team_members WHERE team_id=? AND user_id=? AND status='active'`, team.id, user.id);
    if (!member || !permAtLeast(ROLE_TO_PERM[member.role], 'manage')) throw httpError(403, '需要团队管理员权限');
    const { name, description } = ctx.body || {};
    const patch = { updated_at: nowIso() };
    if (name !== undefined) {
      const n = str(name, '', 60).trim();
      if (!n) throw httpError(400, '名称不能为空');
      patch.name = n;
    }
    if (description !== undefined) patch.description = str(description, '', 300);
    update('teams', team.id, patch);
    sendJson(res, 200, { ok: true, team: get(`SELECT * FROM teams WHERE id=?`, team.id) });
  });

  router.get('/api/teams/:id/members', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const team = get(`SELECT * FROM teams WHERE id=?`, ctx.params.id);
    if (!team) throw httpError(404, '团队不存在');
    const member = get(`SELECT * FROM team_members WHERE team_id=? AND user_id=? AND status='active'`, team.id, user.id);
    if (!member) throw httpError(403, '你不是该团队成员');
    const rows = all(
      `SELECT u.id, u.name, u.email, u.avatar, u.title, tm.role, tm.status, tm.joined_at
         FROM team_members tm JOIN users u ON u.id=tm.user_id
        WHERE tm.team_id=? ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'editor' THEN 2 WHEN 'commenter' THEN 3 ELSE 4 END, u.name`,
      team.id
    );
    sendJson(res, 200, { ok: true, members: rows, myRole: member.role });
  });

  router.post('/api/teams/:id/members', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const team = get(`SELECT * FROM teams WHERE id=?`, ctx.params.id);
    if (!team) throw httpError(404, '团队不存在');
    const member = get(`SELECT * FROM team_members WHERE team_id=? AND user_id=? AND status='active'`, team.id, user.id);
    if (!member || !permAtLeast(ROLE_TO_PERM[member.role], 'manage')) throw httpError(403, '需要团队管理员权限');

    const { email, role = 'editor' } = ctx.body || {};
    if (!TEAM_ROLES.includes(role)) throw httpError(400, '角色不合法');
    if (role === 'owner') throw httpError(400, '不能通过邀请转移团队所有权');
    const target = findUserByEmail(email);
    if (!target) throw httpError(404, '该邮箱尚未注册 KBPRO 账号，请先让对方注册');

    const existing = get(`SELECT * FROM team_members WHERE team_id=? AND user_id=?`, team.id, target.id);
    if (existing) {
      run(`UPDATE team_members SET role=?, status='active' WHERE team_id=? AND user_id=?`, role, team.id, target.id);
    } else {
      insert('team_members', { team_id: team.id, user_id: target.id, role, status: 'active', invited_by: user.id, joined_at: nowIso() });
    }
    insert('notifications', {
      id: randomId('ntf'), user_id: target.id, kind: 'team',
      title: `你已加入团队「${team.name}」`, body: `角色：${role}`,
      link: `/team/${team.id}`, read: 0, created_at: nowIso()
    });
    audit({ workspaceId: null, userId: user.id, userName: user.name, action: 'team.member.add', resourceType: 'team', resourceId: team.id, resourceName: team.name, detail: `${email} as ${role}` });
    sendJson(res, 200, { ok: true, member: { id: target.id, name: target.name, email: target.email, role } });
  });

  router.patch('/api/teams/:id/members/:userId', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const team = get(`SELECT * FROM teams WHERE id=?`, ctx.params.id);
    if (!team) throw httpError(404, '团队不存在');
    const me = get(`SELECT * FROM team_members WHERE team_id=? AND user_id=? AND status='active'`, team.id, user.id);
    if (!me || !permAtLeast(ROLE_TO_PERM[me.role], 'manage')) throw httpError(403, '需要团队管理员权限');
    const targetId = ctx.params.userId;
    const target = get(`SELECT * FROM team_members WHERE team_id=? AND user_id=?`, team.id, targetId);
    if (!target) throw httpError(404, '该成员不存在');
    if (target.role === 'owner') throw httpError(400, '不能修改团队所有者的角色');
    const { role } = ctx.body || {};
    if (!TEAM_ROLES.includes(role) || role === 'owner') throw httpError(400, '角色不合法');
    run(`UPDATE team_members SET role=? WHERE team_id=? AND user_id=?`, role, team.id, targetId);
    sendJson(res, 200, { ok: true });
  });

  router.delete('/api/teams/:id/members/:userId', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const team = get(`SELECT * FROM teams WHERE id=?`, ctx.params.id);
    if (!team) throw httpError(404, '团队不存在');
    const me = get(`SELECT * FROM team_members WHERE team_id=? AND user_id=? AND status='active'`, team.id, user.id);
    const targetId = ctx.params.userId;
    const isSelf = targetId === user.id;
    if (!isSelf && (!me || !permAtLeast(ROLE_TO_PERM[me.role], 'manage'))) throw httpError(403, '需要团队管理员权限');
    const target = get(`SELECT * FROM team_members WHERE team_id=? AND user_id=?`, team.id, targetId);
    if (!target) throw httpError(404, '该成员不存在');
    if (target.role === 'owner') throw httpError(400, '不能移除团队所有者');
    run(`DELETE FROM team_members WHERE team_id=? AND user_id=?`, team.id, targetId);
    sendJson(res, 200, { ok: true });
  });

  /* ============================== 文件夹 ============================== */

  router.get('/api/workspaces/:id/folders', async (req, res, ctx) => {
    const user = ctx.requireUser();
    requireWorkspace(user.id, ctx.params.id, 'view');
    const { tree, flat } = folderTree(ctx.params.id);
    sendJson(res, 200, {
      ok: true, tree,
      flat: flat.map((f) => ({ id: f.id, name: f.name, parentId: f.parentId, path: f.path, icon: f.icon, color: f.color, totalCount: f.totalCount }))
    });
  });

  router.post('/api/folders', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { workspaceId, parentId = null, name, icon = '', color = '' } = ctx.body || {};
    requireBody(ctx.body || {}, ['workspaceId', 'name']);
    requireWorkspace(user.id, workspaceId, 'edit');
    const folder = createFolder({ workspaceId, parentId, name, icon, color, createdBy: user.id });
    audit({ workspaceId, userId: user.id, userName: user.name, action: 'folder.create', resourceType: 'folder', resourceId: folder.id, resourceName: folder.name });
    sendJson(res, 201, { ok: true, folder });
  });

  router.patch('/api/folders/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const folder = get(`SELECT * FROM folders WHERE id=? AND deleted_at IS NULL`, ctx.params.id);
    if (!folder) throw httpError(404, '文件夹不存在');
    requireWorkspace(user.id, folder.workspace_id, 'edit');
    const { name, icon, color, sortOrder } = ctx.body || {};
    const patch = { updated_at: nowIso() };
    if (name !== undefined) {
      const n = str(name, '', 80).trim();
      if (!n) throw httpError(400, '名称不能为空');
      const dup = get(
        `SELECT id FROM folders WHERE workspace_id=? AND deleted_at IS NULL AND name=? AND IFNULL(parent_id,'')=IFNULL(?,'') AND id<>?`,
        folder.workspace_id, n, folder.parent_id ?? null, folder.id
      );
      if (dup) throw httpError(409, '同级下已存在同名文件夹');
      patch.name = n;
    }
    if (icon !== undefined) patch.icon = str(icon, '', 40);
    if (color !== undefined) patch.color = str(color, '', 20);
    if (sortOrder !== undefined) patch.sort_order = int(sortOrder, 0);
    update('folders', folder.id, patch);
    refreshFolderPaths(folder.workspace_id);
    sendJson(res, 200, { ok: true, folder: get(`SELECT * FROM folders WHERE id=?`, folder.id) });
  });

  router.post('/api/folders/:id/move', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const folder = get(`SELECT * FROM folders WHERE id=? AND deleted_at IS NULL`, ctx.params.id);
    if (!folder) throw httpError(404, '文件夹不存在');
    requireWorkspace(user.id, folder.workspace_id, 'edit');
    const { parentId = null } = ctx.body || {};
    const moved = moveFolder({ workspaceId: folder.workspace_id, folderId: folder.id, targetParentId: parentId });
    sendJson(res, 200, { ok: true, folder: moved });
  });

  router.delete('/api/folders/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const folder = get(`SELECT * FROM folders WHERE id=? AND deleted_at IS NULL`, ctx.params.id);
    if (!folder) throw httpError(404, '文件夹不存在');
    requireWorkspace(user.id, folder.workspace_id, 'edit');
    const mode = ['move-to-root', 'cascade'].includes(ctx.query.mode) ? ctx.query.mode : 'move-to-root';
    const result = deleteFolder({ workspaceId: folder.workspace_id, folderId: folder.id, mode });
    audit({ workspaceId: folder.workspace_id, userId: user.id, userName: user.name, action: 'folder.delete', resourceType: 'folder', resourceId: folder.id, resourceName: folder.name, detail: mode });
    sendJson(res, 200, { ok: true, ...result });
  });

  router.get('/api/folders/:id/breadcrumb', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const folder = get(`SELECT * FROM folders WHERE id=? AND deleted_at IS NULL`, ctx.params.id);
    if (!folder) throw httpError(404, '文件夹不存在');
    requireWorkspace(user.id, folder.workspace_id, 'view');
    sendJson(res, 200, { ok: true, breadcrumb: breadcrumb(folder.id) });
  });

  /* ============================== 标签 ============================== */

  router.get('/api/workspaces/:id/tags', async (req, res, ctx) => {
    const user = ctx.requireUser();
    requireWorkspace(user.id, ctx.params.id, 'view');
    sendJson(res, 200, { ok: true, tags: workspaceTags(ctx.params.id) });
  });

  router.patch('/api/tags/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const tag = get(`SELECT * FROM tags WHERE id=?`, ctx.params.id);
    if (!tag) throw httpError(404, '标签不存在');
    requireWorkspace(user.id, tag.workspace_id, 'edit');
    const { name, color } = ctx.body || {};
    if (color !== undefined) update('tags', tag.id, { color: str(color, '', 20) });
    const updated = name !== undefined ? renameTag(user.id, tag.id, name) : get(`SELECT * FROM tags WHERE id=?`, tag.id);
    sendJson(res, 200, { ok: true, tag: updated });
  });

  router.delete('/api/tags/:id', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const tag = get(`SELECT * FROM tags WHERE id=?`, ctx.params.id);
    if (!tag) throw httpError(404, '标签不存在');
    requireWorkspace(user.id, tag.workspace_id, 'edit');
    deleteTag(user.id, tag.id);
    sendJson(res, 200, { ok: true });
  });

  /* ============================== 通知 ============================== */

  router.get('/api/notifications', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const rows = all(`SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 40`, user.id);
    const unread = Number(scalar(`SELECT COUNT(*) FROM notifications WHERE user_id=? AND read=0`, user.id) || 0);
    sendJson(res, 200, { ok: true, notifications: rows, unread });
  });

  router.post('/api/notifications/read', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const { ids } = ctx.body || {};
    if (Array.isArray(ids) && ids.length) {
      const ph = ids.map(() => '?').join(',');
      run(`UPDATE notifications SET read=1 WHERE user_id=? AND id IN (${ph})`, user.id, ...ids);
    } else {
      run(`UPDATE notifications SET read=1 WHERE user_id=?`, user.id);
    }
    sendJson(res, 200, { ok: true });
  });

  /* ============================== 实例设置（管理员） ============================== */

  router.get('/api/settings', async (req, res, ctx) => {
    const user = ctx.requireUser();
    if (user.role !== 'admin') throw httpError(403, '需要管理员权限');
    const cfg = loadConfig();
    sendJson(res, 200, {
      ok: true,
      settings: {
        maxUploadBytes: cfg.maxUploadBytes, allowSignup: cfg.allowSignup, sessionDays: cfg.sessionDays,
        ragTopK: cfg.ragTopK, ragChunkSize: cfg.ragChunkSize, ragChunkOverlap: cfg.ragChunkOverlap,
        ai: { provider: cfg.ai.provider, baseUrl: cfg.ai.baseUrl, chatModel: cfg.ai.chatModel, embedModel: cfg.ai.embedModel, ollamaUrl: cfg.ai.ollamaUrl, hasKey: Boolean(cfg.ai.apiKey), temperature: cfg.ai.temperature, maxTokens: cfg.ai.maxTokens }
      }
    });
  });

  router.patch('/api/settings', async (req, res, ctx) => {
    const admin = requireAdmin(req);
    const body = ctx.body || {};
    const patch = {};
    for (const k of ['maxUploadBytes', 'allowSignup', 'sessionDays', 'ragTopK', 'ragChunkSize', 'ragChunkOverlap', 'searchLimit']) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (body.ai && typeof body.ai === 'object') {
      patch.ai = {};
      for (const k of ['provider', 'baseUrl', 'chatModel', 'embedModel', 'ollamaUrl', 'temperature', 'maxTokens']) {
        if (body.ai[k] !== undefined) patch.ai[k] = body.ai[k];
      }
      if (body.ai.apiKey) patch.ai.apiKey = String(body.ai.apiKey).slice(0, 500);
    }
    saveConfig(patch);
    audit({ userId: admin.id, userName: admin.name, action: 'settings.update', resourceType: 'settings', detail: Object.keys(patch).join(',') });
    sendJson(res, 200, { ok: true });
  });

  router.get('/api/system/stats', async (req, res, ctx) => {
    const user = ctx.requireUser();
    const counts = tableCounts();
    const cfg = loadConfig();
    const uptime = Math.round(process.uptime());
    const aiStatus = await probeAi(user);
    sendJson(res, 200, {
      ok: true,
      counts,
      database: { bytes: dbSizeBytes(), sizeText: formatBytes(dbSizeBytes()) },
      runtime: {
        node: process.version, platform: process.platform, pid: process.pid,
        uptime, uptimeText: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
        memoryMB: Math.round(process.memoryUsage().rss / 1048576),
        dataDir: cfg ? '' : ''
      },
      ai: aiStatus,
      version: '1.0.0'
    });
  });
}

export { isDescendant, sharesForResource, createShare, deleteShare, cleanupOrphanTags, normalizeTags };
