/**
 * KBPRO — 团队协作
 * 团队成员与角色权限、团队知识库、协作动态与访问记录、共享设置。
 */
import {
  qs, qsa, on, icon, notify, modal, dropdown, confirmDialog, promptDialog,
  emptyState, esc, timeAgo, formatDate, formatNumber, avatarHtml, badge, skeleton,
  roleLabel, permissionLabel, debounce
} from '../ui.js';

export const meta = { title: '团队协作', icon: 'users' };

/* ------------------------------------------------------------------ 常量 */

/** 角色能力矩阵：true 表示具备该能力 */
const CAPS = [
  { key: 'view', label: '查看', roles: { owner: 1, admin: 1, editor: 1, commenter: 1, viewer: 1 } },
  { key: 'comment', label: '评论', roles: { owner: 1, admin: 1, editor: 1, commenter: 1, viewer: 0 } },
  { key: 'edit', label: '编辑', roles: { owner: 1, admin: 1, editor: 1, commenter: 0, viewer: 0 } },
  { key: 'member', label: '成员管理', roles: { owner: 1, admin: 1, editor: 0, commenter: 0, viewer: 0 } },
  { key: 'workspace', label: '知识库管理', roles: { owner: 1, admin: 1, editor: 0, commenter: 0, viewer: 0 } },
  { key: 'transfer', label: '转让所有权', roles: { owner: 1, admin: 0, editor: 0, commenter: 0, viewer: 0 } }
];

const MATRIX_ROLES = ['owner', 'admin', 'editor', 'commenter', 'viewer'];

const ROLE_CHOICES = [
  { value: 'admin', label: '管理员' },
  { value: 'editor', label: '编辑者' },
  { value: 'commenter', label: '评论者' },
  { value: 'viewer', label: '只读' }
];

const ROLE_PERM = { owner: 'manage', admin: 'manage', editor: 'edit', commenter: 'comment', viewer: 'view' };

const ACTION_LABEL = {
  create: '创建', update: '更新', delete: '删除', restore: '恢复',
  move: '移动', upload: '上传', share: '共享', unshare: '取消共享',
  index: '重建索引', read: '查看', download: '下载', login: '登录',
  grant: '授权', invite: '邀请', remove: '移出', batch: '批量操作'
};

const ICON_CHOICES = ['folder', 'layers', 'book', 'bulb', 'target', 'chart', 'users', 'shield', 'globe', 'file'];

/* ------------------------------------------------------------------ 状态 */

let page = null;

function newPageState() {
  return {
    offs: [],
    timers: [],
    teams: [],
    teamId: '',
    team: null,
    members: [],
    myRole: '',
    workspaces: [],
    activity: [],
    shares: [],
    sharesCapped: false,
    sharesSkipped: 0,
    root: null
  };
}

function addOff(fn) {
  if (typeof fn === 'function') page.offs.push(fn);
}

/** 页面内查询：优先在当前页面容器内查找，避免依赖全局 document */
function qsIn(selector, root) {
  return qs(selector, root || page?.root || document);
}

function later(fn, ms) {
  const id = setTimeout(fn, ms);
  page.timers.push(id);
  return id;
}

/** 当前用户在本团队的能力判断 */
function canManageTeam() {
  return page?.myRole === 'owner' || page?.myRole === 'admin';
}

function isTeamOwner() {
  return page?.myRole === 'owner';
}

/** 给出「为什么被禁用」的可读原因，空字符串表示有权限 */
function denyReason(what) {
  if (!page?.team) return '请先选择团队';
  const role = roleLabel(page.myRole || 'member');
  if (canManageTeam()) return '';
  return `当前角色「${role}」不能${what}，需要团队管理员或所有者权限`;
}

/* ------------------------------------------------------------------ 挂载 */

export async function mount(container, ctx) {
  const { workspace } = ctx;

  if (!workspace) {
    container.innerHTML = `<div class="page">${emptyState({
      iconName: 'layers',
      title: '还没有知识库',
      desc: '请先在左上角创建一个知识库，团队协作会基于它展开。',
      actions: '<button class="btn btn-primary" data-act="goto-dashboard">回到首页</button>'
    })}</div>`;
    page = newPageState();
    addOff(on(container, 'click', '[data-act="goto-dashboard"]', () => ctx.navigate('dashboard')));
    return;
  }

  page = newPageState();
  page.root = container;
  page.teamId = String(ctx.params?.[0] || '');

  container.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">团队协作</h1>
        <p class="page-desc">统一管理团队成员、角色权限与团队知识库；所有变更实时作用于团队共享内容。</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" data-act="refresh">${icon('refresh')}<span>刷新</span></button>
        <button class="btn btn-primary" data-act="new-team">${icon('plus')}<span>创建团队</span></button>
        <button class="btn btn-default" data-act="invite" disabled title="请先选择团队">${icon('mail')}<span>邀请成员</span></button>
      </div>
    </div>

    <div class="card mb-6" style="border-color:var(--c-border-2)">
      <div class="card-pad flex items-start gap-3">
        <span style="width:18px;height:18px;flex:none;color:var(--c-ink-600);margin-top:1px">${icon('lock')}</span>
        <div class="flex-1">
          <div class="font-semibold">个人知识库与团队知识库完全隔离</div>
          <div class="text-sm text-muted mt-1" style="line-height:1.75">
            个人知识库中的文件、笔记、标签与检索索引仅自己可见，不会出现在任何团队空间；
            团队知识库按成员角色（所有者 / 管理员 / 编辑者 / 评论者 / 只读）逐项授权。
            加入团队不会获得任何成员个人知识库的访问权，退出团队也不会带走团队内容。
          </div>
          <div class="flex flex-wrap gap-2 mt-3">
            <span class="chip">${icon('user', 12)} 个人库：仅自己可见</span>
            <span class="chip">${icon('users', 12)} 团队库：按角色授权</span>
            <span class="chip">${icon('shield', 12)} 数据互不流通</span>
          </div>
        </div>
      </div>
    </div>

    <div id="team-body">${skeleton(6)}</div>
  </div>`;

  bindEvents(container, ctx);

  try {
    await loadAll(ctx);
  } catch (err) {
    notify.error(`加载失败：${err.message}`);
  }
  render(ctx);
}

/* ------------------------------------------------------------------ 数据 */

async function loadAll(ctx) {
  try {
    const res = await ctx.api.teams();
    page.teams = res.teams || [];
  } catch (err) {
    page.teams = [];
    notify.error(`团队列表加载失败：${err.message}`);
  }

  if (page.teams.length) {
    if (!page.teams.some((t) => t.id === page.teamId)) page.teamId = page.teams[0].id;
    page.team = page.teams.find((t) => t.id === page.teamId) || page.teams[0];
    page.teamId = page.team.id;
    await loadTeamDetail(ctx);
  } else {
    page.team = null;
    page.teamId = '';
    page.members = [];
    page.myRole = '';
    page.shares = [];
    page.sharesCapped = false;
  }

  await Promise.all([loadWorkspaces(ctx), loadActivity(ctx)]);
}

async function loadTeamDetail(ctx) {
  page.members = [];
  page.myRole = page.team?.my_role || '';
  if (!page.team) return;
  try {
    const res = await ctx.api.members(page.team.id);
    page.members = res.members || [];
    page.myRole = res.myRole || page.myRole;
  } catch (err) {
    notify.error(`成员加载失败：${err.message}`);
  }
}

async function loadWorkspaces(ctx) {
  try {
    const res = await ctx.api.workspaces();
    page.workspaces = res.workspaces || [];
  } catch (err) {
    page.workspaces = [];
    notify.error(`知识库加载失败：${err.message}`);
  }
}

async function loadActivity(ctx) {
  if (!ctx.workspace) { page.activity = []; return; }
  try {
    const res = await ctx.api.activity(ctx.workspace.id, { limit: 60 });
    page.activity = res.activity || [];
  } catch {
    page.activity = [];
  }
}

/** 共享设置：仅在有管理权限时探测当前知识库的资源级共享 */
async function loadShares(ctx) {
  page.shares = [];
  page.sharesCapped = false;
  page.sharesSkipped = 0;
  if (!ctx.workspace || ctx.workspace.permission !== 'manage') { page.sharesCapped = true; return; }

  let files = [];
  try {
    const res = await ctx.api.files({ workspaceId: ctx.workspace.id, limit: 200 });
    files = res.files || [];
  } catch {
    page.sharesCapped = true;
    return;
  }

  const probe = files.slice(0, 60);
  page.sharesSkipped = Math.max(0, files.length - probe.length);

  const found = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < probe.length; i += CONCURRENCY) {
    const slice = probe.slice(i, i + CONCURRENCY);
    const settled = await Promise.all(slice.map(async (f) => {
      try {
        const r = await ctx.api.shares('file', f.id);
        const list = r.shares || [];
        return list.length ? { file: f, shares: list } : null;
      } catch {
        return null;
      }
    }));
    for (const item of settled) if (item) found.push(item);
  }
  page.shares = found;
  page.sharesCapped = true;
}

/* ------------------------------------------------------------------ 渲染 */

function render(ctx) {
  const host = qsIn('#team-body');
  if (!host) return;

  if (!page.teams.length) {
    host.innerHTML = `<div class="card">${emptyState({
      iconName: 'users',
      title: '还没有团队',
      desc: '创建一个团队，把同事加入进来，即可共享团队知识库。团队成员按角色授权，个人知识库始终仅自己可见。',
      actions: `<button class="btn btn-primary" data-act="new-team">${icon('plus')}<span>创建团队</span></button>`
    })}</div>`;
    syncHead();
    return;
  }

  host.innerHTML = `
    <div class="grid" style="grid-template-columns:minmax(220px,266px) minmax(0,1fr);gap:16px;align-items:start">
      <div class="card">
        <div class="card-pad" style="padding-bottom:10px">
          <div class="section-head" style="margin-bottom:8px">
            <div class="section-title" style="font-size:var(--fs-base)">${icon('layers')} 我的团队</div>
            <span class="text-xs text-muted">${page.teams.length} 个</span>
          </div>
          <div>
            ${page.teams.map(teamRailItem).join('')}
          </div>
        </div>
      </div>
      <div id="team-detail">
        ${teamDetailHtml(ctx)}
      </div>
    </div>`;

  syncHead();
}

function teamRailItem(t) {
  const active = t.id === page.teamId;
  const desc = String(t.description || '').trim();
  return `<div class="list-row" data-team="${esc(t.id)}" title="${esc(desc || t.name)}"
      style="border-radius:var(--r-md);margin-bottom:2px;cursor:pointer${active ? ';background:var(--c-ink-100)' : ''}">
    <span class="avatar sm" style="background:${active ? 'var(--c-ink)' : 'var(--c-ink-200)'};color:${active ? '#fff' : 'var(--c-ink-700)'}">${esc(String(t.name || '?').slice(0, 1))}</span>
    <div class="list-main">
      <div class="list-title">${esc(t.name)}</div>
      <div class="list-sub">${esc(roleLabel(t.my_role))} · ${Number(t.member_count || 0)} 人</div>
    </div>
    ${active ? `<span style="width:14px;height:14px;color:var(--c-ink-500);flex:none">${icon('check')}</span>` : ''}
  </div>`;
}

function teamDetailHtml(ctx) {
  const t = page.team;
  if (!t) {
    return `<div class="card">${emptyState({ iconName: 'users', title: '请选择团队', desc: '从左侧选择一个团队，查看成员、权限与团队知识库。' })}</div>`;
  }

  const myId = ctx.store?.user?.id || '';
  const teamWorkspaces = page.workspaces.filter((w) => w.teamId === t.id);
  const manage = canManageTeam();

  const disabledAttr = (what) => (canManageTeam() ? '' : ` disabled title="${esc(denyReason(what))}"`);

  return `
    <div class="card mb-4">
      <div class="card-pad">
        <div class="section-head">
          <div>
            <div class="section-title" style="font-size:var(--fs-lg)">${esc(t.name)} ${badge(roleLabel(page.myRole), manage ? 'info' : '')}</div>
            <div class="section-sub">${esc(t.description || '暂未填写团队说明')}</div>
          </div>
          <div class="section-actions">
            <button class="btn btn-sm btn-default" data-team-act="edit-team"${disabledAttr('修改团队信息')}>${icon('edit')}<span>编辑团队</span></button>
          </div>
        </div>
        <div class="stat-inline mt-4">
          <div class="stat-inline-item"><span class="stat-inline-value">${Number(t.member_count || page.members.length || 0)}</span><span class="stat-inline-label">团队成员</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value">${teamWorkspaces.length}</span><span class="stat-inline-label">团队知识库</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value">${formatNumber(teamWorkspaces.reduce((n, w) => n + Number(w.stats?.files || 0), 0))}</span><span class="stat-inline-label">共享文档</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value">${formatNumber(teamWorkspaces.reduce((n, w) => n + Number(w.stats?.notes || 0), 0))}</span><span class="stat-inline-label">共享笔记</span></div>
        </div>
      </div>
    </div>

    <div class="card mb-6">
      <div class="card-pad" style="padding-bottom:8px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('users')} 团队成员</div>
            <div class="section-sub">共 ${page.members.length} 位成员 · 角色决定其在团队知识库中的操作范围</div>
          </div>
          <div class="section-actions">
            <button class="btn btn-sm btn-primary" data-team-act="invite"${disabledAttr('邀请成员')}>${icon('mail')}<span>邀请成员</span></button>
          </div>
        </div>
      </div>
      <div style="padding:0 8px 10px">
        ${page.members.length
          ? page.members.map((m) => memberRowHtml(m, { myId, manage })).join('')
          : '<div class="empty" style="padding:28px 16px"><div class="empty-desc">暂时没有成员数据</div></div>'}
      </div>
    </div>

    <div class="card mb-6">
      <div class="card-pad" style="overflow-x:auto">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('shield')} 角色权限矩阵</div>
            <div class="section-sub">团队知识库的每次访问都会校验角色权限，权限粒度如下</div>
          </div>
        </div>
        ${matrixHtml()}
        <div class="text-xs text-muted mt-3" style="line-height:1.75">
          说明：管理员拥有与所有者几乎一致的日常管理能力，但「转让所有权」仅所有者可执行；
          编辑者可创建、编辑与整理内容但不能管理成员；评论者与只读用户对内容仅具备阅读（评论者额外可评论）权限。
        </div>
      </div>
    </div>

    <div class="card mb-6">
      <div class="card-pad" style="padding-bottom:8px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('book')} 团队知识库</div>
            <div class="section-sub">归本团队所有的共享知识库，成员按角色获得访问权限</div>
          </div>
          <div class="section-actions">
            <button class="btn btn-sm btn-default" data-team-act="new-ws"${disabledAttr('新建团队知识库')}>${icon('plus')}<span>新建团队知识库</span></button>
          </div>
        </div>
      </div>
      <div style="padding:0 8px 12px">
        ${teamWorkspaces.length
          ? teamWorkspaces.map((w) => teamWsRowHtml(w, { manage, activeId: ctx.workspace?.id })).join('')
          : `<div class="empty" style="padding:28px 16px">
              <div class="empty-ico">${icon('layers')}</div>
              <div class="empty-desc">本团队还没有知识库，创建一个即可开始沉淀团队资料。</div>
              <div class="empty-actions"><button class="btn btn-primary" data-team-act="new-ws"${disabledAttr('新建团队知识库')}>${icon('plus')}<span>新建团队知识库</span></button></div>
            </div>`}
      </div>
    </div>

    <div class="card mb-6">
      <div class="card-pad" style="padding-bottom:8px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('activity')} 近期协作动态（访问记录）</div>
            <div class="section-sub">来自「${esc(ctx.workspace?.name || '当前知识库')}」的成员操作日志，用于审计追溯</div>
          </div>
          <div class="section-actions">
            <button class="btn btn-sm btn-ghost" data-team-act="reload-activity">${icon('refresh')}<span>刷新</span></button>
          </div>
        </div>
      </div>
      <div style="overflow-x:auto">
        <table class="table">
          <thead>
            <tr><th style="width:150px">时间</th><th style="width:180px">成员</th><th style="width:120px">操作</th><th>对象</th></tr>
          </thead>
          <tbody data-activity-body>
            ${activityRowsHtml()}
          </tbody>
        </table>
      </div>
    </div>

    <div class="card">
      <div class="card-pad" style="padding-bottom:8px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('share')} 共享设置</div>
            <div class="section-sub">当前知识库中已对外共享（用户 / 团队 / 链接）的资源</div>
          </div>
          <div class="section-actions">
            <button class="btn btn-sm btn-ghost" data-team-act="reload-shares">${icon('refresh')}<span>检测共享</span></button>
          </div>
        </div>
      </div>
      <div class="card-pad" style="padding-top:4px" data-shares-body>
        ${sharesHtml(ctx)}
      </div>
    </div>`;
}

function memberRowHtml(m, { myId, manage }) {
  const isOwnerRow = m.role === 'owner';
  const isSelf = m.id === myId;
  const canEditRow = manage && !isOwnerRow;
  const title = isOwnerRow
    ? '团队所有者不可修改角色或移出团队'
    : (canEditRow ? '调整该成员的角色' : denyReason('修改成员角色'));

  return `<div class="member-row" data-member="${esc(m.id)}">
    ${avatarHtml(m, 'sm')}
    <div class="member-main">
      <div class="member-name">${esc(m.name)}${isSelf ? ' <span class="text-xs text-muted">（我）</span>' : ''}</div>
      <div class="member-email">${esc(m.email)}${m.title ? ` · ${esc(m.title)}` : ''}</div>
    </div>
    <div style="width:120px;flex:none">
      <select class="select input-sm" data-role-select="${esc(m.id)}"${canEditRow ? '' : ` disabled title="${esc(title)}"`}>
        ${(isOwnerRow ? [{ value: 'owner', label: '所有者' }] : ROLE_CHOICES)
          .map((o) => `<option value="${esc(o.value)}"${o.value === m.role ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </div>
    <div class="text-xs text-muted nowrap" style="width:96px;flex:none">${esc(formatDate(m.joined_at))}</div>
    <button class="icon-btn sm${canEditRow ? '' : ' is-disabled'}" data-member-menu="${esc(m.id)}"
      aria-label="更多操作" title="${esc(title || '更多操作')}">${icon('moreV')}</button>
  </div>`;
}

function matrixHtml() {
  return `<div style="overflow-x:auto;margin-top:var(--sp-3)">
    <table class="table" style="min-width:660px">
      <thead>
        <tr>
          <th style="width:124px">角色</th>
          ${CAPS.map((c) => `<th class="text-center" style="width:84px">${esc(c.label)}</th>`).join('')}
        </tr>
      </thead>
      <tbody>
        ${MATRIX_ROLES.map((role) => `<tr>
          <td>
            <div class="font-medium">${esc(roleLabel(role))}</div>
            <div class="text-xs text-muted">${esc(permissionLabel(ROLE_PERM[role]))}</div>
          </td>
          ${CAPS.map((c) => `<td class="text-center">${c.roles[role]
            ? `<span style="display:inline-flex;width:16px;height:16px;color:var(--c-success)">${icon('check')}</span>`
            : '<span class="text-muted">—</span>'}</td>`).join('')}
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

function teamWsRowHtml(w, { manage, activeId }) {
  const active = w.id === activeId;
  return `<div class="list-row" style="border-radius:var(--r-md)">
    <span class="file-ico f-md" style="background:var(--c-ink-100);color:var(--c-ink-700);width:30px;height:30px;border-radius:9px">${icon(w.icon || 'layers', 15)}</span>
    <div class="list-main">
      <div class="list-title">${esc(w.name)}${active ? ' <span class="badge badge-info">当前</span>' : ''}</div>
      <div class="list-sub">${Number(w.stats?.files || 0)} 文档 · ${Number(w.stats?.notes || 0)} 笔记 · ${Number(w.stats?.members || 0)} 成员 · ${esc(w.stats?.sizeText || '0 B')}</div>
    </div>
    <button class="btn btn-sm btn-ghost" data-ws-open="${esc(w.id)}">进入</button>
    <button class="btn btn-sm btn-ghost" data-ws-edit="${esc(w.id)}"${manage ? '' : ` disabled title="${esc(denyReason('编辑知识库'))}"`}>${icon('edit')}<span>编辑</span></button>
  </div>`;
}

function activityRowsHtml() {
  const team = page.team;
  const teamWsIds = new Set(page.workspaces.filter((w) => w.teamId === team?.id).map((w) => w.id));
  const rows = page.activity.slice(0, 40);
  if (!rows.length) {
    return '<tr><td colspan="4"><div class="empty" style="padding:24px 16px"><div class="empty-desc">暂无操作记录</div></div></td></tr>';
  }
  return rows.map((row) => {
    const action = String(row.action || '');
    const parts = action.split('.');
    const label = ACTION_LABEL[parts[0]] || ACTION_LABEL[parts[parts.length - 1]] || (action || '操作');
    const related = row.resource_id && teamWsIds.has(row.resource_id);
    return `<tr>
      <td class="text-xs text-muted nowrap" title="${esc(row.created_at || '')}">${esc(timeAgo(row.created_at))}</td>
      <td>${esc(row.user_name || '系统')}</td>
      <td>${badge(label)}</td>
      <td class="text-2">${esc(row.resource_name || row.resource_type || '—')}${related ? ' <span class="text-xs text-muted">（本团队知识库）</span>' : ''}</td>
    </tr>`;
  }).join('');
}

function sharesHtml(ctx) {
  if (!ctx.workspace) return '<div class="text-sm text-muted">请先选择知识库。</div>';
  if (ctx.workspace.permission !== 'manage') {
    return `<div class="text-sm text-muted" style="line-height:1.75">
      当前知识库权限为「${esc(permissionLabel(ctx.workspace.permission || 'none'))}」，无法查看共享设置；共享设置需要知识库管理权限。
    </div>`;
  }
  if (!page.sharesCapped) {
    return '<div class="text-sm text-muted">点击右上角「检测共享」，检查当前知识库中已对外共享的资源。</div>';
  }
  if (!page.shares.length) {
    return `<div class="text-sm text-muted" style="line-height:1.75">
      当前知识库尚无资源级共享。团队知识库成员本身已按角色获得访问权，多数场景无需额外共享。
      ${page.sharesSkipped ? `<br>（本次仅检测了前 60 份文档，另有 ${page.sharesSkipped} 份未检测）` : ''}
    </div>`;
  }
  return `${page.shares.map(({ file, shares }) => `
    <div class="setting-row">
      <div class="setting-main">
        <div class="setting-title">${esc(file.name)}</div>
        <div class="setting-desc">${esc(shares.map((s) =>
          `${s.granteeName}（${s.granteeType === 'team' ? '团队' : s.granteeType === 'link' ? '链接' : '用户'} · ${permissionLabel(s.permission)}）`).join('、'))}</div>
      </div>
      <div class="setting-ctl">
        <button class="btn btn-sm btn-default" data-share-file="${esc(file.id)}">查看详情</button>
      </div>
    </div>`).join('')}
    ${page.sharesSkipped ? `<div class="text-xs text-muted mt-3">另有 ${page.sharesSkipped} 份文档未检测共享状态。</div>` : ''}`;
}

function syncHead() {
  const root = page?.root;
  if (!root) return;
  const inviteBtn = qsIn('[data-act="invite"]', root);
  if (!inviteBtn) return;
  const hasTeam = !!page.team;
  const allowed = hasTeam && canManageTeam();
  inviteBtn.disabled = !allowed;
  inviteBtn.title = !hasTeam ? '请先选择团队' : (allowed ? '邀请成员加入团队' : denyReason('邀请成员'));
}

function refreshDetail(ctx) {
  const host = qsIn('#team-detail', page.root);
  if (host) host.innerHTML = teamDetailHtml(ctx);
  syncHead();
}

/* ------------------------------------------------------------------ 事件 */

function bindEvents(container, ctx) {
  addOff(on(container, 'click', '[data-act="new-team"]', () => createTeam(ctx, container)));
  addOff(on(container, 'click', '[data-act="refresh"]', () => remount(ctx)));
  addOff(on(container, 'click', '[data-act="invite"]', (e, node) => {
    if (node.disabled) return;
    openInvite(ctx, container);
  }));

  addOff(on(container, 'click', '[data-team]', (e, node) => {
    const id = node.getAttribute('data-team');
    if (!id || id === page.teamId) return;
    ctx.navigate('team', [id]);
  }));

  addOff(on(container, 'click', '[data-team-act]', (e, node) => {
    const act = node.getAttribute('data-team-act');
    if (act === 'edit-team') { editTeam(ctx, container); return; }
    if (act === 'new-ws') { createTeamWorkspace(ctx, container); return; }
    if (act === 'invite') { openInvite(ctx, container); return; }
    if (act === 'reload-activity') { reloadActivity(ctx, node); return; }
    if (act === 'reload-shares') { reloadShares(ctx, node); }
  }));

  addOff(on(container, 'change', '[data-role-select]', async (e, node) => {
    const memberId = node.getAttribute('data-role-select');
    const role = node.value;
    const prev = page.members.find((m) => m.id === memberId)?.role || '';
    node.disabled = true;
    try {
      await ctx.api.updateMember(page.team.id, memberId, role);
      notify.success(`已将其角色调整为「${roleLabel(role)}」`);
      await loadTeamDetail(ctx);
      refreshDetail(ctx);
    } catch (err) {
      node.value = prev;
      node.disabled = false;
      notify.error(err.message);
    }
  }));

  addOff(on(container, 'click', '[data-member-menu]', (e, node) => {
    e.stopPropagation();
    const member = page.members.find((m) => m.id === node.getAttribute('data-member-menu'));
    if (member) openMemberMenu(node, member, ctx, container);
  }));

  addOff(on(container, 'click', '[data-ws-open]', async (e, node) => {
    const id = node.getAttribute('data-ws-open');
    node.disabled = true;
    try {
      ctx.store.currentWorkspaceId = id;
      await ctx.refreshWorkspaces();
      ctx.reload();
    } catch (err) {
      node.disabled = false;
      notify.error(err.message);
    }
  }));

  addOff(on(container, 'click', '[data-ws-edit]', (e, node) => {
    if (node.disabled) return;
    const ws = page.workspaces.find((w) => w.id === node.getAttribute('data-ws-edit'));
    if (ws) editWorkspace(ctx, container, ws);
  }));

  addOff(on(container, 'click', '[data-share-file]', (e, node) => {
    const item = page.shares.find((s) => s.file.id === node.getAttribute('data-share-file'));
    if (item) showShareDetail(item);
  }));
}

async function remount(ctx) {
  try {
    const refreshBtn = qsIn('[data-act="refresh"]', page.root);
    if (refreshBtn) refreshBtn.disabled = true;
    await loadAll(ctx);
    render(ctx);
  } catch (err) {
    notify.error(err.message);
  }
}

async function reloadActivity(ctx, btn) {
  btn.disabled = true;
  try {
    await loadActivity(ctx);
    const body = qsIn('[data-activity-body]', page.root);
    if (body) body.innerHTML = activityRowsHtml();
    notify.success('协作动态已刷新');
  } catch (err) {
    notify.error(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function reloadShares(ctx, btn) {
  const body = qsIn('[data-shares-body]', page.root);
  btn.disabled = true;
  if (body) body.innerHTML = '<div class="text-sm text-muted">正在检测共享状态…</div>';
  try {
    await loadShares(ctx);
    if (body) body.innerHTML = sharesHtml(ctx);
    notify.success('共享状态检测完成');
  } catch (err) {
    if (body) body.innerHTML = `<div class="text-sm text-danger">检测失败：${esc(err.message)}</div>`;
    notify.error(err.message);
  } finally {
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ 操作 */

async function createTeam(ctx, container) {
  const name = await promptDialog({
    title: '创建团队',
    label: '团队名称',
    placeholder: '例如：产品研发中心',
    confirmText: '下一步',
    hint: '创建后会自动生成一个团队知识库，你将自动成为团队所有者。'
  });
  if (!name || !String(name).trim()) return;

  const description = await promptDialog({
    title: '团队说明',
    label: '一句话说明（可留空）',
    placeholder: '这个团队主要协作什么？',
    confirmText: '创建',
    hint: '可留空，之后也能随时修改。'
  });
  if (description === null) return;

  try {
    const res = await ctx.api.createTeam({ name: String(name).trim(), description: String(description || '').trim() });
    notify.success(`团队「${name}」已创建`);
    if (typeof ctx.refreshWorkspaces === 'function') {
      try { await ctx.refreshWorkspaces(); } catch { /* 刷新失败不影响团队创建 */ }
    }
    const teamId = res?.team?.id || res?.teamId || '';
    if (teamId) ctx.navigate('team', [teamId]);
    else await remount(ctx);
  } catch (err) {
    notify.error(err.message);
  }
}

function editTeam(ctx, container) {
  if (!page.team) return;
  if (!canManageTeam()) { notify.warn(denyReason('修改团队信息')); return; }

  const m = modal({
    title: '编辑团队',
    sub: '名称与说明对所有团队成员可见',
    size: 'sm',
    body: `<div class="field">
        <label>团队名称</label>
        <input class="input" data-field="name" value="${esc(page.team.name)}" maxlength="60">
      </div>
      <div class="field" style="margin-bottom:0">
        <label>团队说明</label>
        <input class="input" data-field="description" value="${esc(page.team.description || '')}" placeholder="一句话说明团队用途" maxlength="300">
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存',
        primary: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          const name = qsIn('[data-field="name"]', m.body).value.trim();
          const description = qsIn('[data-field="description"]', m.body).value.trim();
          if (!name) { notify.warn('团队名称不能为空'); return; }
          btn.disabled = true;
          try {
            await ctx.api.updateTeam(page.team.id, { name, description });
            notify.success('团队信息已更新');
            close();
            await remount(ctx);
          } catch (err) {
            notify.error(err.message);
          } finally {
            btn.disabled = false;
          }
        }
      }
    ]
  });
}

function openMemberMenu(anchor, member, ctx, container) {
  const isOwnerRow = member.role === 'owner';
  const manage = canManageTeam();
  const blocked = !manage || isOwnerRow;

  const items = [
    { label: isOwnerRow ? '所有者' : '调整角色', header: true },
    ...ROLE_CHOICES.map((choice) => ({
      label: `设为${choice.label}`,
      icon: choice.value === member.role ? 'check' : undefined,
      active: choice.value === member.role,
      disabled: blocked,
      onClick: async () => {
        try {
          await ctx.api.updateMember(page.team.id, member.id, choice.value);
          notify.success(`已将 ${member.name} 设为「${choice.label}」`);
          await loadTeamDetail(ctx);
          refreshDetail(ctx);
        } catch (err) {
          notify.error(err.message);
        }
      }
    })),
    { sep: true },
    {
      label: '转让团队所有权',
      icon: 'shield',
      disabled: blocked,
      onClick: async () => {
        const ok = await confirmDialog({
          title: '转让团队所有权',
          message: `确定把团队的所有权转让给 <strong>${esc(member.name)}</strong>（${esc(member.email)}）吗？<br>`
            + '<span class="text-muted">转让后对方成为所有者，你保留团队管理员身份，仍可管理成员与知识库。</span>',
          confirmText: '转让所有权',
          danger: true
        });
        if (!ok) return;
        try {
          await ctx.api.transferTeam(page.team.id, member.id);
          notify.success(`已把团队所有权转让给 ${member.name}`);
          await loadTeamDetail(ctx);
          refreshDetail(ctx);
        } catch (err) {
          notify.error(err.message);
        }
      }
    },
    {
      label: '移出团队',
      icon: 'trash',
      danger: true,
      disabled: blocked,
      onClick: async () => {
        const ok = await confirmDialog({
          title: '移出团队成员',
          message: `确定将 <strong>${esc(member.name)}</strong>（${esc(member.email)}）移出团队吗？<br>对方将立即失去本团队全部知识库的访问权限，其个人知识库不受影响。`,
          confirmText: '移出团队',
          danger: true
        });
        if (!ok) return;
        try {
          await ctx.api.removeMember(page.team.id, member.id);
          notify.success(`已将 ${member.name} 移出团队`);
          if (typeof ctx.refreshWorkspaces === 'function') {
            try { await ctx.refreshWorkspaces(); } catch { /* 忽略 */ }
          }
          await remount(ctx);
        } catch (err) {
          notify.error(err.message);
        }
      }
    }
  ];

  if (blocked) {
    const why = isOwnerRow ? '团队所有者不可修改角色或移出团队' : denyReason('管理成员');
    items.unshift({ label: why, header: true });
  }

  dropdown(anchor, items, { width: 226 });
}

function openInvite(ctx, container) {
  if (!page.team) { notify.warn('请先选择团队'); return; }
  if (!canManageTeam()) { notify.warn(denyReason('邀请成员')); return; }

  const owner = isTeamOwner();
  const roleOptions = ROLE_CHOICES.filter((r) => r.value !== 'admin' || owner);

  const m = modal({
    title: `邀请成员加入「${page.team.name}」`,
    sub: '邀请后对方立即获得对应角色的团队知识库访问权限',
    body: `
      <div class="field">
        <label>成员邮箱</label>
        <input class="input" data-field="email" placeholder="输入姓名或邮箱搜索" autocomplete="off">
        <div class="field-hint">仅可邀请已注册 KBPRO 账号的邮箱；对方需先自行注册账号。</div>
        <div class="perm-grid mt-2" data-suggest></div>
      </div>
      <div class="field">
        <label>角色</label>
        <select class="select" data-field="role">
          ${roleOptions.map((r) => `<option value="${esc(r.value)}"${r.value === 'editor' ? ' selected' : ''}>${esc(r.label)}</option>`).join('')}
        </select>
        <div class="field-hint">编辑者可编辑内容；评论者仅可评论；只读仅可浏览。${owner ? '管理员拥有成员与知识库管理权限。' : '只有团队所有者可以授予管理员角色。'}</div>
      </div>
      <div class="card" style="background:var(--c-ink-50)">
        <div class="card-pad" style="padding:12px 14px">
          <div class="text-sm text-2 flex items-start gap-2" style="line-height:1.75">
            <span style="width:14px;height:14px;flex:none;margin-top:3px;color:var(--c-ink-500)">${icon('info')}</span>
            <span>邀请前请确认该成员已拥有 KBPRO 账号。加入团队只会获得本团队知识库的授权，<strong>不会</strong>看到任何成员的个人知识库。</span>
          </div>
        </div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '发送邀请',
        primary: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          const email = qsIn('[data-field="email"]', m.body).value.trim();
          const role = qsIn('[data-field="role"]', m.body).value;
          if (!email) { notify.warn('请填写成员邮箱'); return; }
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { notify.warn('邮箱格式不正确'); return; }
          btn.disabled = true;
          try {
            await ctx.api.addMember(page.team.id, email, role);
            notify.success(`已邀请 ${email} 加入团队`);
            close();
            await remount(ctx);
          } catch (err) {
            notify.error(err.message);
          } finally {
            btn.disabled = false;
          }
        }
      }
    ]
  });

  const input = qsIn('[data-field="email"]', m.body);
  const host = qsIn('[data-suggest]', m.body);

  const runSearch = debounce(async (q) => {
    if (!host.isConnected) return;
    if (!q) { host.innerHTML = ''; return; }
    host.innerHTML = '<div class="text-xs text-muted">搜索中…</div>';
    try {
      const res = await ctx.api.searchUsers(q);
      const users = res.users || [];
      if (!host.isConnected) return;
      if (!users.length) {
        host.innerHTML = '<div class="text-xs text-muted">没有匹配到已注册用户，请确认邮箱是否正确。</div>';
        return;
      }
      host.innerHTML = users.map((u) => `<div class="perm-row" style="cursor:pointer" data-suggest-user="${esc(u.email)}">
        ${avatarHtml(u, 'sm')}
        <div class="flex-1">
          <div class="text-sm font-medium truncate">${esc(u.name)}</div>
          <div class="text-xs text-muted truncate">${esc(u.email)}${u.title ? ` · ${esc(u.title)}` : ''}</div>
        </div>
        <span class="text-xs text-muted">选择</span>
      </div>`).join('');
    } catch {
      if (host.isConnected) host.innerHTML = '<div class="text-xs text-muted">搜索失败，可直接输入完整邮箱。</div>';
    }
  }, 280);

  const onInput = () => runSearch(input.value.trim().length >= 1 ? input.value.trim() : '');
  const onClickSuggest = (e) => {
    const target = e.target.closest('[data-suggest-user]');
    if (!target) return;
    input.value = target.getAttribute('data-suggest-user');
    host.innerHTML = '';
    input.focus();
  };
  const onKeydown = (e) => { if (e.key === 'Enter') e.preventDefault(); };

  input.addEventListener('input', onInput);
  host.addEventListener('click', onClickSuggest);
  input.addEventListener('keydown', onKeydown);
  // 页面卸载时取消尚未触发的防抖搜索
  addOff(() => {
    runSearch.cancel?.();
    input.removeEventListener('input', onInput);
    host.removeEventListener('click', onClickSuggest);
    input.removeEventListener('keydown', onKeydown);
  });
  later(() => input.focus(), 60);
}

function createTeamWorkspace(ctx, container) {
  if (!page.team) return;
  if (!canManageTeam()) { notify.warn(denyReason('新建团队知识库')); return; }

  const m = modal({
    title: '新建团队知识库',
    sub: `归属团队：${page.team.name} · 成员按角色自动获得访问权限`,
    size: 'sm',
    body: `<div class="field">
        <label>知识库名称</label>
        <input class="input" data-field="name" placeholder="例如：产品研发资料库" maxlength="60">
      </div>
      <div class="field">
        <label>描述（可选）</label>
        <input class="input" data-field="description" placeholder="一句话说明用途" maxlength="200">
      </div>
      <div class="field" style="margin-bottom:0">
        <label>图标</label>
        <div class="flex flex-wrap gap-2" data-icon-picker>
          ${ICON_CHOICES.map((name, i) => `<button type="button" class="btn btn-sm ${i === 0 ? 'btn-primary' : 'btn-default'}" data-pick-icon="${esc(name)}" title="${esc(name)}" style="width:32px;padding:0;justify-content:center">${icon(name)}</button>`).join('')}
        </div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '创建',
        primary: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          const name = qsIn('[data-field="name"]', m.body).value.trim();
          const description = qsIn('[data-field="description"]', m.body).value.trim();
          const iconName = qsIn('[data-pick-icon].btn-primary', m.body)?.getAttribute('data-pick-icon') || 'layers';
          if (!name) { notify.warn('请填写知识库名称'); return; }
          btn.disabled = true;
          try {
            await ctx.api.createWorkspace({ name, kind: 'team', teamId: page.team.id, description, icon: iconName });
            notify.success(`已创建团队知识库「${name}」`);
            close();
            if (typeof ctx.refreshWorkspaces === 'function') {
              try { await ctx.refreshWorkspaces(); } catch { /* 忽略 */ }
            }
            await remount(ctx);
          } catch (err) {
            notify.error(err.message);
          } finally {
            btn.disabled = false;
          }
        }
      }
    ]
  });

  const picker = qsIn('[data-icon-picker]', m.body);
  picker.addEventListener('click', (e) => {
    const target = e.target.closest('[data-pick-icon]');
    if (!target) return;
    qsa('[data-pick-icon]', picker).forEach((b) => {
      b.classList.toggle('btn-primary', b === target);
      b.classList.toggle('btn-default', b !== target);
    });
  });
}

function editWorkspace(ctx, container, ws) {
  if (ctx.workspace?.id !== ws.id && !canManageTeam()) { notify.warn(denyReason('编辑知识库')); return; }

  const m = modal({
    title: '编辑团队知识库',
    sub: ws.name,
    size: 'sm',
    body: `<div class="field">
        <label>名称</label>
        <input class="input" data-field="name" value="${esc(ws.name)}" maxlength="60">
      </div>
      <div class="field" style="margin-bottom:0">
        <label>描述</label>
        <input class="input" data-field="description" value="${esc(ws.description || '')}" placeholder="一句话说明用途" maxlength="300">
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存',
        primary: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          const name = qsIn('[data-field="name"]', m.body).value.trim();
          const description = qsIn('[data-field="description"]', m.body).value.trim();
          if (!name) { notify.warn('名称不能为空'); return; }
          btn.disabled = true;
          try {
            await ctx.api.updateWorkspace(ws.id, { name, description });
            notify.success('知识库已更新');
            close();
            if (typeof ctx.refreshWorkspaces === 'function') {
              try { await ctx.refreshWorkspaces(); } catch { /* 忽略 */ }
            }
            await remount(ctx);
          } catch (err) {
            notify.error(err.message);
          } finally {
            btn.disabled = false;
          }
        }
      }
    ]
  });
}

function showShareDetail({ file, shares }) {
  modal({
    title: '共享详情',
    sub: file.name,
    size: 'sm',
    body: `<div class="perm-grid">
      ${shares.map((s) => `<div class="perm-row">
        <span style="width:15px;height:15px;flex:none;color:var(--c-ink-500)">${icon(s.granteeType === 'link' ? 'link' : s.granteeType === 'team' ? 'users' : 'user')}</span>
        <div class="flex-1">
          <div class="text-sm font-medium truncate">${esc(s.granteeName)}</div>
          <div class="text-xs text-muted truncate">${esc(s.granteeEmail || (s.granteeType === 'link' ? '持有链接的任何人均可访问' : ''))}</div>
        </div>
        <span class="badge">${esc(permissionLabel(s.permission))}</span>
      </div>`).join('')}
    </div>
    <div class="text-xs text-muted mt-3">如需调整共享对象，请前往「分享的内容」或对应文件详情页操作。</div>`,
    actions: [
      { label: '关闭' },
      { label: '前往分享管理', primary: true, onClick: () => window.location.assign('#/share') }
    ]
  });
}

/* ------------------------------------------------------------------ 卸载 */

export function unmount() {
  if (page) {
    for (const off of page.offs) {
      try { typeof off === 'function' && off(); } catch { /* 忽略 */ }
    }
    for (const id of page.timers) {
      try { clearTimeout(id); } catch { /* 忽略 */ }
    }
  }
  page = null;
}

export default { meta, mount, unmount };
