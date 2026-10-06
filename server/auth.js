/**
 * KBPRO — 认证、会话、知识库隔离与权限模型
 *
 * 权限等级：view < comment < edit < manage
 * 知识库体系：
 *   · personal —— 个人知识库，仅本人可见（可对单个资源开共享）
 *   · team     —— 团队知识库，按团队成员角色授权
 * 资源级：文件/笔记的 acl_level='private' 时，仅创建者与显式授权者可见。
 */
import { all, get, run, insert, update, tx, nowIso, isoPlusDays, audit } from './db.js';
import { hashPassword, verifyPassword, randomToken, randomId } from './lib/crypto.js';
import { loadConfig } from './config.js';
import { httpError, parseCookies } from './lib/http.js';

export const PERM_RANK = { none: 0, view: 1, comment: 2, edit: 3, manage: 4 };

export function permAtLeast(actual, required) {
  return (PERM_RANK[actual] ?? 0) >= (PERM_RANK[required] ?? 0);
}

export function maxPerm(...perms) {
  let best = 'none';
  for (const p of perms) if ((PERM_RANK[p] ?? 0) > (PERM_RANK[best] ?? 0)) best = p;
  return best;
}

export const ROLE_TO_PERM = {
  owner: 'manage',
  admin: 'manage',
  editor: 'edit',
  commenter: 'comment',
  viewer: 'view',
  member: 'edit'
};

export const TEAM_ROLES = ['owner', 'admin', 'editor', 'commenter', 'viewer'];

/* ------------------------------------------------------------------ 用户 */

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

export function findUserByEmail(email) {
  return get(`SELECT * FROM users WHERE email = ?`, normalizeEmail(email));
}

export function findUserById(id) {
  return id ? get(`SELECT * FROM users WHERE id = ?`, id) : null;
}

export function publicUser(row, { self = false } = {}) {
  if (!row) return null;
  const base = {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    avatar: row.avatar || '',
    title: row.title || '',
    bio: row.bio || '',
    status: row.status,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at
  };
  if (self) {
    base.settings = safeParse(row.settings, {});
    base.aiProvider = row.ai_provider || '';
    base.aiModel = row.ai_model || '';
    base.aiBaseUrl = row.ai_base_url || '';
    base.hasAiKey = !!row.ai_key_enc;
    base.storageUsed = Number(row.storage_used || 0);
    base.storageQuota = Number(row.storage_quota || 0);
  }
  return base;
}

function safeParse(v, fb) {
  try { return v ? JSON.parse(v) : fb; } catch { return fb; }
}

export function registerUser({ email, password, name }) {
  const cfg = loadConfig();
  if (!cfg.allowSignup) throw httpError(403, '当前实例已关闭注册');
  const mail = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw httpError(400, '邮箱格式不正确');
  if (String(password || '').length < 8) throw httpError(400, '密码至少 8 位');
  if (findUserByEmail(mail)) throw httpError(409, '该邮箱已注册');

  const { hash, salt } = hashPassword(password);
  const id = randomId('usr');
  const now = nowIso();
  insert('users', {
    id, email: mail, name: String(name || mail.split('@')[0]).slice(0, 60),
    password_hash: hash, password_salt: salt, role: 'user',
    settings: '{}', created_at: now, updated_at: now
  });
  ensurePersonalWorkspace(id);
  ensureDefaults(id);
  return findUserById(id);
}

export function loginUser({ email, password, ip, ua }) {
  const user = findUserByEmail(email);
  if (!user) throw httpError(401, '邮箱或密码不正确');
  if (user.status !== 'active') throw httpError(403, '账号已被禁用，请联系管理员');
  if (!verifyPassword(password, { hash: user.password_hash, salt: user.password_salt })) {
    audit({ userId: user.id, userName: user.name, action: 'login.failed', resourceType: 'user', resourceId: user.id, ip, ua });
    throw httpError(401, '邮箱或密码不正确');
  }
  update('users', user.id, { last_login_at: nowIso() });
  ensurePersonalWorkspace(user.id);
  ensureDefaults(user.id);
  audit({ userId: user.id, userName: user.name, action: 'login.success', resourceType: 'user', resourceId: user.id, ip, ua });
  return findUserById(user.id);
}

export function changePassword(userId, oldPassword, newPassword) {
  const user = findUserById(userId);
  if (!user) throw httpError(404, '用户不存在');
  if (!verifyPassword(oldPassword, { hash: user.password_hash, salt: user.password_salt })) {
    throw httpError(400, '原密码不正确');
  }
  if (String(newPassword || '').length < 8) throw httpError(400, '新密码至少 8 位');
  const { hash, salt } = hashPassword(newPassword);
  update('users', userId, { password_hash: hash, password_salt: salt, updated_at: nowIso() });
  // 使其它会话失效
  run(`UPDATE sessions SET revoked=1 WHERE user_id=?`, userId);
  return true;
}

/* ------------------------------------------------------------------ 会话 */

export const COOKIE_NAME = 'kbpro_session';

export function createSession(userId, { ip = '', ua = '' } = {}) {
  const cfg = loadConfig();
  const token = randomToken(32);
  const now = new Date();
  const expires = isoPlusDays(cfg.sessionDays || 30);
  insert('sessions', {
    token, user_id: userId, created_at: now.toISOString(),
    expires_at: expires, ip: String(ip).slice(0, 64), ua: String(ua).slice(0, 300), revoked: 0
  });
  return { token, expiresAt: expires };
}

export function getSession(token) {
  if (!token) return null;
  const row = get(`SELECT * FROM sessions WHERE token = ?`, token);
  if (!row || row.revoked) return null;
  if (Date.parse(row.expires_at) < Date.now()) return null;
  return row;
}

export function destroySession(token) {
  if (!token) return;
  run(`UPDATE sessions SET revoked=1 WHERE token=?`, token);
}

export function destroyAllSessions(userId) {
  run(`UPDATE sessions SET revoked=1 WHERE user_id=?`, userId);
}

export function cookieHeader(token, { maxAgeSeconds, clear = false } = {}) {
  if (clear) return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  const max = maxAgeSeconds ?? (loadConfig().sessionDays || 30) * 86400;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${max}`;
}

/** 从请求解析出用户（Bearer 或 Cookie） */
export function authenticate(req) {
  const auth = String(req.headers.authorization || '');
  let token = '';
  if (auth.toLowerCase().startsWith('bearer ')) token = auth.slice(7).trim();
  if (!token) token = parseCookies(req)[COOKIE_NAME] || '';
  if (!token) return { user: null, token: '', session: null };
  const session = getSession(token);
  if (!session) return { user: null, token: '', session: null };
  const user = findUserById(session.user_id);
  if (!user || user.status !== 'active') return { user: null, token: '', session: null };
  return { user, token, session };
}

export function requireUser(req) {
  const { user, token, session } = authenticate(req);
  if (!user) throw httpError(401, '未登录或会话已过期');
  return { user, token, session };
}

export function requireAdmin(req) {
  const { user } = requireUser(req);
  if (user.role !== 'admin') throw httpError(403, '需要管理员权限');
  return user;
}

/* ------------------------------------------------------------------ 初始化 */

export function ensurePersonalWorkspace(userId) {
  const existing = get(`SELECT * FROM workspaces WHERE owner_id=? AND kind='personal' ORDER BY created_at LIMIT 1`, userId);
  if (existing) return existing;
  const user = findUserById(userId);
  const now = nowIso();
  const id = randomId('ws');
  insert('workspaces', {
    id, name: `${user?.name || '我'}的知识库`, kind: 'personal', owner_id: userId,
    team_id: null, description: '个人知识库 · 私人专属', color: '#1F2937', icon: 'user',
    is_default: 1, created_at: now, updated_at: now
  });
  createDefaultFolders(id, userId);
  return get(`SELECT * FROM workspaces WHERE id=?`, id);
}

export function createDefaultFolders(workspaceId, userId) {
  const now = nowIso();
  const defaults = [
    { name: '学习资料', icon: 'book' },
    { name: '项目文档', icon: 'folder' },
    { name: '会议记录', icon: 'mic' },
    { name: '灵感收集', icon: 'bulb' }
  ];
  const created = [];
  defaults.forEach((d, i) => {
    const id = randomId('fld');
    insert('folders', {
      id, workspace_id: workspaceId, parent_id: null, name: d.name, path: '/',
      color: '', icon: d.icon, sort_order: i, created_by: userId,
      created_at: now, updated_at: now, deleted_at: null
    });
    update('folders', id, { path: `/${id}` });
    created.push(id);
  });
  return created;
}

export function ensureDefaults(userId) {
  // 确保存在默认笔记，方便新用户立刻上手
  const count = Number(get(`SELECT COUNT(*) AS n FROM notes WHERE created_by=?`, userId)?.n || 0);
  if (count > 0) return;
  const ws = get(`SELECT * FROM workspaces WHERE owner_id=? AND kind='personal' ORDER BY created_at LIMIT 1`, userId);
  if (!ws) return;
  const now = nowIso();
  insert('notes', {
    id: randomId('note'), workspace_id: ws.id, folder_id: null,
    title: '欢迎使用 KBPRO 知识库',
    html: `<h1>欢迎使用 KBPRO 👋</h1><p>这是一个 <strong>个人 &amp; 团队轻量化智能知识库</strong>。你可以：</p>
<ul><li>在「文件库」上传 PDF / Word / Excel / PPT / TXT / Markdown，系统会自动解析并建立索引</li>
<li>在「笔记中心」新建富文本笔记，支持图片、代码块、表格</li>
<li>在「智能问答」中基于自己的私有文档提问，答案会自动标注引用来源</li>
<li>启用「团队知识库」，邀请成员协作、设置权限</li></ul>
<h2>快捷上手</h2><ol><li>上传一份文档</li><li>等解析完成后到智能问答里提问</li><li>用 ⌘K / Ctrl+K 打开全局检索</li></ol>
<blockquote>小提示：左侧边栏可以切换个人知识库与团队知识库，两者数据完全隔离。</blockquote>`,
    text: '欢迎使用 KBPRO 知识库 这是一个个人 & 团队轻量化智能知识库 文件库 笔记中心 智能问答 团队知识库 快捷上手 上传一份文档 全局检索 个人知识库与团队知识库数据完全隔离',
    tags: '["入门","使用指南"]',
    emoji: '👋', created_by: userId, updated_by: userId,
    created_at: now, updated_at: now, version: 1, word_count: 120
  });
}

/** 首次启动：创建管理员与示例团队知识库 */
export function bootstrap() {
  const cfg = loadConfig();
  const existing = Number(get(`SELECT COUNT(*) AS n FROM users`)?.n || 0);
  if (existing > 0) return { created: false };

  const { hash, salt } = hashPassword(cfg.bootstrap.password);
  const id = randomId('usr');
  const now = nowIso();
  insert('users', {
    id, email: normalizeEmail(cfg.bootstrap.email), name: cfg.bootstrap.name,
    password_hash: hash, password_salt: salt,
    role: 'admin', settings: '{}', created_at: now, updated_at: now
  });
  const ws = ensurePersonalWorkspace(id);
  ensureDefaults(id);

  // 示例团队知识库
  const teamId = randomId('team');
  insert('teams', {
    id: teamId, name: '示例团队', slug: 'demo-team',
    description: '用于演示团队协作与权限体系', owner_id: id,
    plan: 'team', created_at: now, updated_at: now
  });
  insert('team_members', { team_id: teamId, user_id: id, role: 'owner', status: 'active', invited_by: id, joined_at: now });
  const teamWsId = randomId('ws');
  insert('workspaces', {
    id: teamWsId, name: '示例团队知识库', kind: 'team', owner_id: id, team_id: teamId,
    description: '团队共享资料 · 支持权限管理', color: '#374151', icon: 'users',
    is_default: 0, created_at: now, updated_at: now
  });
  createDefaultFolders(teamWsId, id);

  return {
    created: true,
    admin: { email: cfg.bootstrap.email, password: cfg.bootstrap.password },
    personalWorkspace: ws.id,
    teamWorkspace: teamWsId
  };
}

/* ------------------------------------------------------------------ 知识库访问 */

/**
 * 用户可访问的所有知识库。
 * @returns {{id:string,name:string,kind:string,role:string,permission:string,teamId:string|null,color:string,icon:string}[]}
 */
export function accessibleWorkspaces(userId) {
  const rows = all(
    `SELECT w.id, w.name, w.kind, w.owner_id, w.team_id, w.description, w.color, w.icon, w.created_at,
            CASE WHEN w.owner_id = ? THEN 'owner' ELSE tm.role END AS role
       FROM workspaces w
       LEFT JOIN team_members tm ON tm.team_id = w.team_id AND tm.user_id = ? AND tm.status='active'
      WHERE w.owner_id = ?
         OR (w.kind='team' AND tm.user_id IS NOT NULL)
      ORDER BY w.kind DESC, w.created_at ASC`,
    userId, userId, userId
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    teamId: r.team_id,
    ownerId: r.owner_id,
    description: r.description || '',
    color: r.color || '#1F2937',
    icon: r.icon || 'folder',
    role: r.role,
    permission: ROLE_TO_PERM[r.role] || 'view',
    createdAt: r.created_at
  }));
}

export function workspacePermission(userId, workspaceId) {
  const ws = get(`SELECT * FROM workspaces WHERE id=?`, workspaceId);
  if (!ws) return { workspace: null, role: 'none', permission: 'none' };
  if (ws.owner_id === userId) return { workspace: ws, role: 'owner', permission: 'manage' };
  if (ws.team_id) {
    const tm = get(`SELECT * FROM team_members WHERE team_id=? AND user_id=? AND status='active'`, ws.team_id, userId);
    if (tm) return { workspace: ws, role: tm.role, permission: ROLE_TO_PERM[tm.role] || 'view' };
  }
  // 资源级共享（shares.resource_type='file'|'note'）不授予整个知识库的访问权；
  // 只有显式的 workspace 级共享才在此处生效。资源级权限由 resourcePermission 处理。
  const shared = get(
    `SELECT permission FROM shares
      WHERE workspace_id=? AND resource_type='workspace'
        AND ( (grantee_type='user' AND grantee_id=?)
           OR (grantee_type='team' AND grantee_id IN (SELECT team_id FROM team_members WHERE user_id=? AND status='active')) )
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY CASE permission WHEN 'manage' THEN 4 WHEN 'edit' THEN 3 WHEN 'comment' THEN 2 ELSE 1 END DESC
      LIMIT 1`,
    workspaceId, userId, userId, nowIso()
  );
  if (shared) return { workspace: ws, role: 'guest', permission: shared.permission };
  return { workspace: ws, role: 'none', permission: 'none' };
}

export function requireWorkspace(userId, workspaceId, required = 'view') {
  const { workspace, role, permission } = workspacePermission(userId, workspaceId);
  if (!workspace) throw httpError(404, '知识库不存在');
  if (!permAtLeast(permission, required)) {
    throw httpError(403, role === 'none' ? '无权访问该知识库' : `需要「${required}」及以上权限`);
  }
  return { workspace, role, permission };
}

/* ------------------------------------------------------------------ 共享 */

export function sharesForResource(resourceType, resourceId) {
  return all(
    `SELECT s.*, u.name AS user_name, u.email AS user_email, t.name AS team_name
       FROM shares s
       LEFT JOIN users u ON s.grantee_type='user' AND u.id = s.grantee_id
       LEFT JOIN teams t ON s.grantee_type='team' AND t.id = s.grantee_id
      WHERE s.resource_type=? AND s.resource_id=?
      ORDER BY s.created_at DESC`,
    resourceType, resourceId
  ).map((r) => ({
    id: r.id,
    granteeType: r.grantee_type,
    granteeId: r.grantee_id,
    granteeName: r.user_name || r.team_name || (r.grantee_type === 'link' ? '链接访问' : '未知'),
    granteeEmail: r.user_email || '',
    permission: r.permission,
    token: r.grantee_type === 'link' ? r.token : undefined,
    expiresAt: r.expires_at,
    createdAt: r.created_at
  }));
}

export function createShare({ workspaceId, resourceType, resourceId, ownerId, granteeType, granteeId, permission = 'view', expiresAt = null }) {
  if (!['view', 'comment', 'edit', 'manage'].includes(permission)) throw httpError(400, '权限值不合法');
  if (!['user', 'team', 'link'].includes(granteeType)) throw httpError(400, '授权对象不合法');
  if (granteeType === 'user' && !findUserById(granteeId)) throw httpError(404, '目标用户不存在');
  if (granteeType === 'team' && !get(`SELECT id FROM teams WHERE id=?`, granteeId)) throw httpError(404, '目标团队不存在');

  const existing = get(
    `SELECT * FROM shares WHERE resource_type=? AND resource_id=? AND grantee_type=? AND IFNULL(grantee_id,'')=IFNULL(?,'')`,
    resourceType, resourceId, granteeType, granteeId ?? null
  );
  const token = granteeType === 'link' ? randomToken(18) : null;
  if (existing) {
    update('shares', existing.id, { permission, expires_at: expiresAt });
    return get(`SELECT * FROM shares WHERE id=?`, existing.id);
  }
  const id = randomId('shr');
  insert('shares', {
    id, workspace_id: workspaceId, resource_type: resourceType, resource_id: resourceId,
    owner_id: ownerId, grantee_type: granteeType, grantee_id: granteeId ?? null,
    permission, token, expires_at: expiresAt, created_at: nowIso()
  });
  return get(`SELECT * FROM shares WHERE id=?`, id);
}

export function deleteShare(userId, shareId) {
  const s = get(`SELECT * FROM shares WHERE id=?`, shareId);
  if (!s) throw httpError(404, '共享记录不存在');
  const { permission } = workspacePermission(userId, s.workspace_id);
  if (s.owner_id !== userId && !permAtLeast(permission, 'manage')) throw httpError(403, '无权移除该共享');
  run(`DELETE FROM shares WHERE id=?`, shareId);
  return true;
}

/** 通过分享链接访问 */
export function shareByToken(token) {
  const s = get(`SELECT * FROM shares WHERE token=?`, token);
  if (!s) return null;
  if (s.expires_at && Date.parse(s.expires_at) < Date.now()) return null;
  return s;
}

/* ------------------------------------------------------------------ 资源级权限 */

/**
 * 计算用户对某个文件/笔记的有效权限。
 */
export function resourcePermission(userId, resourceType, resource) {
  if (!resource) return 'none';
  if (resource.created_by === userId) return 'manage';
  const { workspace, permission } = workspacePermission(userId, resource.workspace_id);
  let perm = workspace ? permission : 'none';

  if (resource.acl_level === 'private' && resource.created_by !== userId) {
    // 私有资源只认显式共享
    perm = 'none';
  }

  const share = get(
    `SELECT permission FROM shares
      WHERE resource_type=? AND resource_id=?
        AND ( (grantee_type='user' AND grantee_id=?)
           OR (grantee_type='team' AND grantee_id IN (SELECT team_id FROM team_members WHERE user_id=? AND status='active')) )
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY CASE permission WHEN 'manage' THEN 4 WHEN 'edit' THEN 3 WHEN 'comment' THEN 2 ELSE 1 END DESC
      LIMIT 1`,
    resourceType, resource.id, userId, userId, nowIso()
  );
  const shared = share?.permission || 'none';
  if (resource.acl_level === 'private') return shared;
  return maxPerm(perm, shared);
}

export function requireResource(userId, resourceType, resourceId, required = 'view', opts = {}) {
  const table = resourceType === 'file' ? 'files' : resourceType === 'note' ? 'notes' : resourceType === 'folder' ? 'folders' : null;
  if (!table) throw httpError(400, '不支持的资源类型');
  const resource = get(`SELECT * FROM ${table} WHERE id=?`, resourceId);
  if (!resource) throw httpError(404, '资源不存在');
  if (resource.deleted_at && !opts.allowDeleted) throw httpError(404, '资源不存在或已删除');
  const permission = resourcePermission(userId, resourceType, resource);
  if (!permAtLeast(permission, required)) throw httpError(403, `需要「${required}」及以上权限`);
  return { resource, permission };
}

/* ------------------------------------------------------------------ 检索 ACL */

/**
 * 为检索构建允许集合。返回 null 表示该维度无限制（性能快路径）。
 * @returns {{allowedFileIds:Set<string>|null, allowedNoteIds:Set<string>|null}}
 */
export function buildSearchAcl(userId, workspaceIds) {
  if (!workspaceIds.length) return { allowedFileIds: new Set(), allowedNoteIds: new Set() };

  const ph = workspaceIds.map(() => '?').join(',');

  const restrictedFileCount = Number(get(
    `SELECT COUNT(*) AS n FROM files WHERE acl_level='private' AND workspace_id IN (${ph})`,
    ...workspaceIds
  )?.n || 0);
  const restrictedNoteCount = Number(get(
    `SELECT COUNT(*) AS n FROM notes WHERE acl_level='private' AND workspace_id IN (${ph})`,
    ...workspaceIds
  )?.n || 0);

  // 共享给我的资源（可能位于我可访问的知识库之外）
  const sharedIds = (type) => all(
    `SELECT resource_id FROM shares
      WHERE resource_type=? AND (expires_at IS NULL OR expires_at > ?)
        AND ( (grantee_type='user' AND grantee_id=?)
           OR (grantee_type='team' AND grantee_id IN (SELECT team_id FROM team_members WHERE user_id=? AND status='active')) )`,
    type, nowIso(), userId, userId
  ).map((r) => r.resource_id);

  const build = (table, kind, restricted, sharedResourceIds) => {
    if (restricted === 0 && sharedResourceIds.length === 0) return null;
    const rows = all(
      `SELECT id, created_by, acl_level FROM ${table}
        WHERE workspace_id IN (${ph})`,
      ...workspaceIds
    );
    const set = new Set(sharedResourceIds);
    const teamIds = all(`SELECT team_id FROM team_members WHERE user_id=? AND status='active'`, userId).map((r) => r.team_id);
    const grantRows = teamIds.length
      ? all(
        `SELECT resource_id, grantee_type, grantee_id FROM shares WHERE resource_type=? AND grantee_id IN (${teamIds.map(() => '?').join(',')})`,
        kind, ...teamIds
      )
      : [];
    const teamGranted = new Set(grantRows.map((r) => r.resource_id));
    for (const r of rows) {
      if (r.acl_level !== 'private') { set.add(r.id); continue; }
      if (r.created_by === userId) { set.add(r.id); continue; }
      if (teamGranted.has(r.id)) set.add(r.id);
    }
    return set;
  };

  return {
    allowedFileIds: build('files', 'file', restrictedFileCount, sharedIds('file')),
    allowedNoteIds: build('notes', 'note', restrictedNoteCount, sharedIds('note'))
  };
}

/* ------------------------------------------------------------------ 存储配额 */

export function addStorageUsage(userId, delta) {
  if (!userId || !delta) return;
  run(`UPDATE users SET storage_used = MAX(0, storage_used + ?) WHERE id=?`, delta, userId);
}

export function checkQuota(user, incomingBytes) {
  const quota = Number(user?.storage_quota || 0);
  if (quota <= 0) return true;
  return Number(user.storage_used || 0) + incomingBytes <= quota;
}

export { audit, tx, update, insert, get, all, run, randomId };
