/**
 * KBPRO — 应用入口：启动、认证、路由、应用壳
 */
import api, { ApiError } from './api.js';
import {
  qs, qsa, el, on, applyIcons, icon, notify, toast, modal, confirmDialog, promptDialog,
  dropdown, closeAllDropdowns, copyText, emptyState, esc, timeAgo, formatBytes, initials, colorFor, debounce
} from './ui.js';
import {
  getState, setState, subscribe, currentWorkspace, canWrite, canManage, isAdmin,
  refreshWorkspaces, restoreUi, persistUi
} from './store.js';
import { uploadFiles, initUploadPanel } from './uploader.js';

/* ================================================================== 路由表 */

const ROUTES = {
  dashboard: { title: '首页', load: () => import('./pages/dashboard.js') },
  files: { title: '文件库', load: () => import('./pages/files.js') },
  notes: { title: '笔记中心', load: () => import('./pages/notes.js') },
  folders: { title: '分类文件夹', load: () => import('./pages/folders.js') },
  chat: { title: '智能问答', load: () => import('./pages/chat.js') },
  search: { title: '全局检索', load: () => import('./pages/search.js') },
  team: { title: '团队协作', load: () => import('./pages/team.js') },
  trash: { title: '回收站', load: () => import('./pages/trash.js') },
  profile: { title: '个人中心', load: () => import('./pages/profile.js') },
  admin: { title: '系统管理', load: () => import('./pages/admin.js') },
  share: { title: '分享的内容', load: () => import('./pages/share.js') }
};

let activePage = null;       // { id, module }
let eventSource = null;

/* ================================================================== 工具 */

function parseHash() {
  const raw = String(location.hash || '#/dashboard').replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const id = segments[0] || 'dashboard';
  const params = segments.slice(1);
  const query = {};
  if (queryPart) {
    for (const [k, v] of new URLSearchParams(queryPart)) query[k] = v;
  }
  return { id, params, query };
}

export function navigate(id, params = [], query = {}) {
  const parts = [id, ...(Array.isArray(params) ? params : [params])].filter(Boolean);
  const qs = Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const hash = `#/${parts.join('/')}${qs ? `?${qs}` : ''}`;
  if (location.hash === hash) handleRoute();
  else location.hash = hash;
}

export function currentRoute() {
  return parseHash();
}

/* ================================================================== 启动 */

async function boot() {
  restoreUi();
  applySidebarState();
  bindGlobalOnce();

  // 分享链接无需登录即可查看
  const pre = parseHash();
  if (pre.id === 'share' && pre.params[0]) {
    showBoot(false);
    await renderStandaloneShare(pre);
    return;
  }

  let me;
  try {
    me = await api.me();
  } catch (err) {
    showBoot(false);
    showAuth('无法连接到服务器，请确认服务已启动');
    return;
  }

  showBoot(false);
  if (!me.user) {
    showAuth();
    return;
  }
  await enterApp(me);
}

/** 独立的分享查看页（隐藏应用壳） */
async function renderStandaloneShare(route) {
  const screen = qs('#auth-screen');
  const app = qs('#app');
  screen.hidden = true;
  app.hidden = false;
  app.classList.add('share-mode');
  qs('.sidebar').hidden = true;
  qs('.topbar').hidden = true;
  qs('#crumbs').innerHTML = '';

  const view = qs('#view');
  view.innerHTML = '';

  try {
    const module = await import('./pages/share.js');
    await module.mount(view, {
      store: getState(),
      params: route.params,
      query: route.query,
      route,
      navigate: (id, params = [], query = {}) => {
        app.classList.remove('share-mode');
        qs('.sidebar').hidden = false;
        qs('.topbar').hidden = false;
        navigate(id, params, query);
      },
      api,
      refreshWorkspaces: () => refreshWorkspaces(api),
      workspace: null,
      reload: () => location.reload()
    });
    applyIcons(view);
  } catch (err) {
    console.error('[share] 渲染失败', err);
    view.innerHTML = `<div class="page">${emptyState({ iconName: 'alert', title: '分享页加载失败', desc: esc(err.message) })}</div>`;
  }
}

async function enterApp(me) {
  setState({
    user: me.user,
    teams: me.teams || [],
    workspaces: me.workspaces || [],
    ai: me.ai || null,
    ready: true
  }, { silent: true });

  const saved = getState().currentWorkspaceId;
  const list = me.workspaces || [];
  if (!list.some((w) => w.id === saved)) {
    const preferred = list.find((w) => w.kind === 'personal') || list[0];
    setState({ currentWorkspaceId: preferred?.id || '' }, { silent: true });
  }

  qs('#auth-screen').hidden = true;
  qs('#app').hidden = false;

  renderSidebarUser();
  renderWorkspaceSwitch();
  renderNavBadges();
  qs('#nav-admin').hidden = !isAdmin();

  initUploadPanel();
  bindShellEvents();
  connectEvents();

  subscribe(() => {
    renderWorkspaceSwitch();
    renderSidebarUser();
    renderNavBadges();
  });

  if (!location.hash) {
    navigate(ROUTES[getState().ui.lastRoute] ? getState().ui.lastRoute : 'dashboard');
  } else {
    handleRoute();
  }
  window.addEventListener('hashchange', handleRoute);
}

function showBoot(show) {
  const node = qs('#boot');
  if (!node) return;
  if (show) { node.classList.remove('is-done'); node.hidden = false; }
  else node.classList.add('is-done');
}

/* ================================================================== 认证 */

let authMode = 'login';

function showAuth(message = '') {
  const screen = qs('#auth-screen');
  screen.hidden = false;
  qs('#app').hidden = true;

  const demo = qs('#auth-demo');
  demo.hidden = false;
  qs('#auth-fill-demo').addEventListener('click', () => {
    qs('#auth-email').value = 'admin@kbpro.local';
    qs('#auth-password').value = 'admin12345';
    qs('#auth-password').focus();
  });

  if (message) setAuthError(message);

  qsa('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      authMode = tab.getAttribute('data-mode');
      qsa('.auth-tab').forEach((t) => t.classList.toggle('is-active', t === tab));
      qs('[data-field="name"]').hidden = authMode !== 'register';
      qs('#auth-submit').textContent = authMode === 'register' ? '创建账号' : '登录';
      qs('#auth-password').setAttribute('autocomplete', authMode === 'register' ? 'new-password' : 'current-password');
      setAuthError('');
    });
  });

  qs('#auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = qs('#auth-email').value.trim();
    const password = qs('#auth-password').value;
    const name = qs('#auth-name').value.trim();
    const btn = qs('#auth-submit');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = authMode === 'register' ? '创建中…' : '登录中…';
    setAuthError('');
    try {
      const res = authMode === 'register'
        ? await api.register(name, email, password)
        : await api.login(email, password);
      btn.textContent = '进入中…';
      const me = await api.me();
      void res;
      await enterApp(me);
      notify.success(`欢迎回来，${me.user.name}`);
    } catch (err) {
      setAuthError(err.message || '操作失败');
      btn.disabled = false;
      btn.textContent = original;
    }
  });
}

function setAuthError(msg) {
  const node = qs('#auth-error');
  node.hidden = !msg;
  node.textContent = msg || '';
}

/* ================================================================== 壳：侧边栏 */

function applySidebarState() {
  const app = qs('#app');
  if (!app) return;
  app.classList.toggle('sidebar-collapsed', !!getState().ui.sidebarCollapsed);
}

function renderSidebarUser() {
  const user = getState().user;
  if (!user) return;
  const avatar = qs('#user-avatar');
  if (user.avatar && /^(https?:|data:image\/)/i.test(user.avatar)) {
    avatar.innerHTML = `<img src="${esc(user.avatar)}" alt="">`;
    avatar.style.background = 'transparent';
  } else {
    avatar.textContent = initials(user.name);
    avatar.style.background = colorFor(user.name);
  }
  qs('#user-name').textContent = user.name;
  qs('#user-role').textContent = user.title || (user.role === 'admin' ? '管理员' : '成员');
}

function renderWorkspaceSwitch() {
  const ws = currentWorkspace();
  const iconNode = qs('#ws-icon');
  if (iconNode) iconNode.innerHTML = icon(ws?.kind === 'team' ? 'users' : (ws?.icon || 'user'), 14);
  qs('#ws-name').textContent = ws?.name || '选择知识库';
  qs('#ws-kind').textContent = ws?.kind === 'team' ? `团队 · ${ws.role === 'owner' ? '所有者' : ws.role || '成员'}` : '个人';
}

function renderNavBadges() {
  const ws = currentWorkspace();
  if (!ws) return;
  qs('#nav-badge-files').textContent = ws.stats?.files ? String(ws.stats.files) : '';
  qs('#nav-badge-notes').textContent = ws.stats?.notes ? String(ws.stats.notes) : '';
}

function openWorkspaceMenu(anchor) {
  const state = getState();
  const personal = state.workspaces.filter((w) => w.kind === 'personal');
  const team = state.workspaces.filter((w) => w.kind === 'team');

  const items = [];
  if (personal.length) {
    items.push({ label: '个人知识库', header: true });
    for (const w of personal) {
      items.push({
        icon: w.icon || 'user',
        label: `${w.name}${w.id === state.currentWorkspaceId ? '  ✓' : ''}`,
        hint: w.stats ? `${w.stats.files} 文件` : '',
        onClick: () => switchWorkspace(w.id)
      });
    }
  }
  if (team.length) {
    if (personal.length) items.push({ sep: true });
    items.push({ label: '团队知识库', header: true });
    for (const w of team) {
      items.push({
        icon: 'users',
        label: `${w.name}${w.id === state.currentWorkspaceId ? '  ✓' : ''}`,
        hint: `${w.stats?.members || 0} 人`,
        onClick: () => switchWorkspace(w.id)
      });
    }
  }
  items.push({ sep: true });
  items.push({ icon: 'plus', label: '新建知识库', onClick: () => openCreateWorkspace() });
  items.push({ icon: 'users', label: '团队协作管理', onClick: () => navigate('team') });

  dropdown(anchor, items, { align: 'start', width: 268 });
}

function switchWorkspace(id) {
  if (id === getState().currentWorkspaceId) return;
  const ws = getState().workspaces.find((w) => w.id === id);
  setState({ currentWorkspaceId: id, folders: [], tags: [] });
  toast(`已切换到「${ws?.name || '知识库'}」`, { type: 'info', duration: 1600 });
  handleRoute(true);
}

async function openCreateWorkspace() {
  const teams = getState().teams || [];
  const m = modal({
    title: '新建知识库',
    sub: '个人知识库仅自己可见；团队知识库按成员角色授权',
    size: 'sm',
    body: `
      <div class="field">
        <label>名称</label>
        <input class="input" data-field="name" placeholder="例如：产品研发资料库" maxlength="60">
      </div>
      <div class="field">
        <label>类型</label>
        <select class="select" data-field="kind">
          <option value="personal">个人知识库（私有）</option>
          ${teams.length ? '<option value="team">团队知识库</option>' : ''}
        </select>
      </div>
      <div class="field" data-team-wrap hidden>
        <label>归属团队</label>
        <select class="select" data-field="teamId">
          ${teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>描述（可选）</label>
        <input class="input" data-field="description" placeholder="一句话说明用途" maxlength="200">
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '创建',
        primary: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          const name = qs('[data-field="name"]', m.body).value.trim();
          if (!name) { notify.warn('请填写知识库名称'); return; }
          const kind = qs('[data-field="kind"]', m.body).value;
          const teamId = kind === 'team' ? qs('[data-field="teamId"]', m.body)?.value : null;
          btn.disabled = true;
          try {
            const res = await api.createWorkspace({
              name, kind, teamId,
              description: qs('[data-field="description"]', m.body).value.trim()
            });
            await refreshWorkspaces(api);
            setState({ currentWorkspaceId: res.workspace.id });
            close();
            notify.success(`已创建「${name}」`);
            navigate('dashboard');
            handleRoute(true);
          } catch (err) {
            notify.error(err.message);
          } finally {
            btn.disabled = false;
          }
        }
      }
    ]
  });
  const kindSel = qs('[data-field="kind"]', m.body);
  kindSel.addEventListener('change', () => {
    qs('[data-team-wrap]', m.body).hidden = kindSel.value !== 'team';
  });
}

/* ================================================================== 壳：事件 */

let shellBound = false;

function bindGlobalOnce() {
  if (shellBound) return;
  shellBound = true;

  // 全局快捷键
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const typing = /^(input|textarea|select)$/i.test(document.activeElement?.tagName || '')
      || document.activeElement?.isContentEditable;

    if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (mod && e.key.toLowerCase() === 's') {
      if (activePage?.id === 'notes') { e.preventDefault(); document.dispatchEvent(new CustomEvent('kbpro:save-note')); }
      return;
    }
    if (e.key === 'Escape') { closeAllDropdowns(); return; }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); openPalette(); return; }
    if (e.key.toLowerCase() === 'n' && !mod) { e.preventDefault(); document.getElementById('btn-new')?.click(); return; }
    if (e.key.toLowerCase() === 'u' && !mod) { e.preventDefault(); document.getElementById('upload-trigger')?.click(); }
  });
}

function bindShellEvents() {
  // 侧边栏收起（桌面）/ 抽屉（移动）
  qs('#sidebar-collapse').addEventListener('click', () => {
    setState({ ui: { sidebarCollapsed: !getState().ui.sidebarCollapsed } });
    applySidebarState();
  });
  qs('#mobile-menu').addEventListener('click', () => {
    qs('#app').classList.toggle('mobile-nav-open');
  });
  document.addEventListener('click', (e) => {
    const app = qs('#app');
    if (app.classList.contains('mobile-nav-open') && e.target === app) app.classList.remove('mobile-nav-open');
  });

  // 知识库切换
  qs('#ws-current').addEventListener('click', (e) => {
    e.stopPropagation();
    openWorkspaceMenu(qs('#ws-current'));
  });

  // 新建
  qs('#btn-new').addEventListener('click', (e) => {
    e.stopPropagation();
    const inNotes = activePage?.id === 'notes';
    const inFiles = activePage?.id === 'files';
    dropdown(qs('#btn-new'), [
      {
        icon: 'note', label: '新建笔记', hint: 'N',
        onClick: () => document.dispatchEvent(new CustomEvent('kbpro:new-note'))
      },
      {
        icon: 'folder', label: '新建文件夹', hint: '',
        onClick: () => document.dispatchEvent(new CustomEvent('kbpro:new-folder'))
      },
      {
        icon: 'upload', label: '上传文件', hint: 'U',
        onClick: () => document.dispatchEvent(new CustomEvent('kbpro:upload-request'))
      },
      { sep: true },
      { icon: 'layers', label: '新建知识库', onClick: () => openCreateWorkspace() },
      ...(inNotes || inFiles ? [] : [{ icon: 'sparkle', label: '向知识库提问', onClick: () => navigate('chat') }])
    ], { align: 'start', width: 232 });
  });

  // 检索
  qs('#search-trigger').addEventListener('click', openPalette);

  // 上传
  qs('#upload-trigger').addEventListener('click', () => document.dispatchEvent(new CustomEvent('kbpro:upload-request')));

  // 通知
  qs('#notify-trigger').addEventListener('click', (e) => {
    e.stopPropagation();
    openNotifications(qs('#notify-trigger'));
  });

  // AI
  qs('#ai-trigger').addEventListener('click', () => navigate('chat'));

  // 导航
  on(qs('#nav'), 'click', '.nav-item', (e, item) => {
    e.preventDefault();
    const route = item.getAttribute('data-route');
    if (route) {
      navigate(route);
      qs('#app').classList.remove('mobile-nav-open');
    }
  });

  bindDropZone();
}

/* ------------------------------------------------------------------ 拖拽上传 */

function bindDropZone() {
  const veil = qs('#drop-veil');
  let depth = 0;

  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth++;
    if (depth === 1 && !qs('#app').hidden) {
      const ws = currentWorkspace();
      qs('#drop-sub').textContent = ws ? `目标知识库：${ws.name}` : '支持 PDF、Word、Excel、PPT、Markdown、TXT 等';
      veil.hidden = false;
    }
  });
  window.addEventListener('dragover', (e) => { if (isFileDrag(e)) e.preventDefault(); });
  window.addEventListener('dragleave', (e) => {
    if (!isFileDrag(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) veil.hidden = true;
  });
  window.addEventListener('drop', async (e) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth = 0;
    veil.hidden = true;
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    if (!canWrite()) { notify.warn('当前知识库没有上传权限'); return; }
    const folderId = window.__kbproDropFolder || null;
    await uploadFiles(files, { folderId });
    document.dispatchEvent(new CustomEvent('kbpro:files-changed'));
  });
}

/* ------------------------------------------------------------------ 通知 */

async function openNotifications(anchor) {
  let data = { notifications: [], unread: 0 };
  try { data = await api.notifications(); } catch { /* */ }

  if (!data.notifications.length) {
    dropdown(anchor, [{ label: '暂无通知', header: true }, { label: '系统运行正常', icon: 'check', disabled: true }]);
    return;
  }
  const items = [{ label: `${data.unread} 条未读`, header: true }];
  for (const n of data.notifications.slice(0, 12)) {
    items.push({
      icon: n.kind === 'team' ? 'users' : n.kind === 'share' ? 'share' : 'info',
      label: n.title.length > 26 ? `${n.title.slice(0, 26)}…` : n.title,
      onClick: () => {
        if (n.link?.startsWith('/team')) navigate('team');
        else if (n.link?.startsWith('/share')) navigate('share', [n.link.split('/').pop()]);
      }
    });
  }
  items.push({ sep: true });
  items.push({
    icon: 'check', label: '全部标记为已读',
    onClick: async () => {
      await api.readNotifications();
      qs('#notify-dot').hidden = true;
      notify.success('已全部标记为已读');
    }
  });
  dropdown(anchor, items, { width: 300 });
  qs('#notify-dot').hidden = false;
}

/* ------------------------------------------------------------------ SSE */

function connectEvents() {
  if (eventSource) eventSource.close();
  try {
    eventSource = api.events();
  } catch {
    return;
  }
  eventSource.addEventListener('workspace', (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    handleRealtime(payload);
  });
  eventSource.addEventListener('notification', (e) => {
    try {
      const payload = JSON.parse(e.data);
      if (payload.type === 'share.created') notify.info('有人向你共享了新的内容');
    } catch { /* */ }
  });
  eventSource.onerror = () => {
    // EventSource 会自动重连；若会话失效则回到登录
    setTimeout(async () => {
      try {
        const me = await api.me();
        if (!me.user) { eventSource?.close(); location.reload(); }
      } catch { /* */ }
    }, 4000);
  };
}

const debouncedRefreshStats = debounce(() => refreshWorkspacesQuiet(), 1500);

async function refreshWorkspacesQuiet() {
  try {
    await refreshWorkspaces(api);
    setState({}, { silent: false });
  } catch { /* */ }
}

function handleRealtime(payload) {
  if (!payload || typeof payload !== 'object') return;
  switch (payload.type) {
    case 'file.indexed':
      if (payload.status === 'ok') {
        notify.success(`《${payload.name}》解析完成 · ${payload.chunks} 个知识块`, { duration: 2400 });
      } else if (payload.status === 'failed') {
        notify.warn(`《${payload.name}》解析未成功：${payload.warning || '无法提取文本'}`);
      }
      debouncedRefreshStats();
      break;
    case 'file.failed':
      notify.error(`《${payload.name}》索引失败`);
      break;
    case 'files.uploaded':
    case 'file.updated':
    case 'file.deleted':
    case 'note.updated':
    case 'note.deleted':
    case 'files.batch':
      debouncedRefreshStats();
      break;
    default:
      break;
  }
  document.dispatchEvent(new CustomEvent('kbpro:realtime', { detail: payload }));
}

/* ================================================================== 路由处理 */

async function handleRoute(force = false) {
  const route = parseHash();
  if (!ROUTES[route.id]) {
    navigate('dashboard');
    return;
  }
  if (activePage?.id === route.id && !force && activePage.mounted) {
    // 同路由不同参数 → 重新挂载
    const sameParams = JSON.stringify(activePage.params) === JSON.stringify(route.params);
    if (sameParams) return;
  }

  getState().ui.lastRoute = route.id;
  persistUi();

  // 卸载上一个页面
  if (activePage?.module?.unmount) {
    try { activePage.module.unmount(); } catch (e) { console.error('[page] unmount 失败', e); }
  }

  qsa('.nav-item').forEach((n) => n.classList.toggle('is-active', n.getAttribute('data-route') === route.id));
  renderCrumbs(route);

  const view = qs('#view');
  view.scrollTop = 0;
  const token = Symbol('route');
  activePage = { id: route.id, params: route.params, mounted: false, token };

  try {
    view.innerHTML = `<div class="page">${pageSkeleton()}</div>`;
    const module = await ROUTES[route.id].load();
    if (activePage?.token !== token) return; // 路由已切换
    activePage.module = module;
    view.innerHTML = '';
    const ctx = {
      store: getState(),
      params: route.params,
      query: route.query,
      route,
      navigate,
      api,
      refreshWorkspaces: () => refreshWorkspaces(api),
      workspace: currentWorkspace(),
      reload: () => handleRoute(true)
    };
    await module.mount(view, ctx);
    activePage.mounted = true;
    applyIcons(view);
  } catch (err) {
    console.error('[route] 渲染失败', err);
    view.innerHTML = `<div class="page">${emptyState({
      iconName: 'alert',
      title: '页面加载失败',
      desc: esc(err?.message || '未知错误'),
      actions: '<button class="btn btn-default" onclick="location.reload()">重新加载</button>'
    })}</div>`;
  }
}

function pageSkeleton() {
  return `<div class="grid grid-4 mb-6">${
    Array.from({ length: 4 }, () => '<div class="card skel-card"><div class="skel skel-line" style="width:40%"></div><div class="skel" style="width:60%;height:26px"></div></div>').join('')
  }</div><div class="card skel-card"><div class="skel skel-line" style="width:24%;height:16px"></div><div class="skel skel-line" style="width:88%"></div><div class="skel skel-line" style="width:72%"></div></div>`;
}

function renderCrumbs(route) {
  const host = qs('#crumbs');
  const ws = currentWorkspace();
  const parts = [`<span class="crumb">${esc(ws?.name || '知识库')}</span>`];
  if (route.id !== 'dashboard') {
    parts.push('<span class="crumb-sep">/</span>');
    parts.push(`<span class="crumb is-current">${esc(ROUTES[route.id].title)}</span>`);
  } else {
    parts.push('<span class="crumb-sep">/</span>');
    parts.push('<span class="crumb is-current">概览</span>');
  }
  host.innerHTML = parts.join('');
}

/* ================================================================== 命令面板 */

let paletteOpen = false;

export function openPalette(initialQuery = '') {
  if (paletteOpen) return;
  paletteOpen = true;

  const overlay = el(`<div class="palette-overlay">
    <div class="palette">
      <div class="palette-input">
        <span style="width:18px;height:18px;color:var(--c-ink-400);flex:none">${icon('search', 18)}</span>
        <input type="text" placeholder="搜索文档、笔记、标签，或输入命令…" value="${esc(initialQuery)}" spellcheck="false">
      </div>
      <div class="palette-results"></div>
      <div class="palette-foot">
        <span><kbd>↑</kbd><kbd>↓</kbd> 选择</span>
        <span><kbd>Enter</kbd> 打开</span>
        <span><kbd>Esc</kbd> 关闭</span>
      </div>
    </div>
  </div>`);

  const input = qs('input', overlay);
  const results = qs('.palette-results', overlay);
  document.getElementById('palette-root').appendChild(overlay);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    paletteOpen = false;
  };

  const commands = [
    { title: '新建笔记', sub: '在当前知识库创建空白笔记', icon: 'note', run: () => { close(); navigate('notes'); setTimeout(() => document.dispatchEvent(new CustomEvent('kbpro:new-note')), 280); } },
    { title: '上传文件', sub: '支持 PDF / Word / Excel / PPT / Markdown', icon: 'upload', run: () => { close(); document.dispatchEvent(new CustomEvent('kbpro:upload-request')); } },
    { title: '新建文件夹', sub: '建立分类目录', icon: 'folder', run: () => { close(); navigate('files'); setTimeout(() => document.dispatchEvent(new CustomEvent('kbpro:new-folder')), 280); } },
    { title: '向知识库提问', sub: '基于私有文档的 RAG 问答', icon: 'sparkle', run: () => { close(); navigate('chat'); } },
    { title: '文件库', sub: '浏览与管理全部文档', icon: 'file', run: () => { close(); navigate('files'); } },
    { title: '笔记中心', sub: '富文本笔记与历史版本', icon: 'note', run: () => { close(); navigate('notes'); } },
    { title: '全局检索', sub: '关键词 / 标签 / 内容模糊检索', icon: 'search', run: () => { close(); navigate('search'); } },
    { title: '分类文件夹', sub: '分层目录与批量归类', icon: 'folder', run: () => { close(); navigate('folders'); } },
    { title: '团队协作', sub: '成员、权限与共享', icon: 'users', run: () => { close(); navigate('team'); } },
    { title: '回收站', sub: '恢复已删除的文件与笔记', icon: 'trash', run: () => { close(); navigate('trash'); } },
    { title: '个人中心', sub: '资料、安全、AI 引擎、存储', icon: 'user', run: () => { close(); navigate('profile'); } }
  ];
  if (isAdmin()) {
    commands.push({ title: '系统管理', sub: '备份、日志、实例设置', icon: 'shield', run: () => { close(); navigate('admin'); } });
  }

  /** 当前渲染的行（含分组标题），以及可运行项的下标集合 */
  let rows = [];
  let activeIndex = -1;

  function buildRows(query) {
    const q = String(query || '').trim().toLowerCase();
    const matched = q
      ? commands.filter((c) => c.title.toLowerCase().includes(q) || c.sub.toLowerCase().includes(q))
      : commands.slice(0, 6);

    const list = [];
    if (matched.length) {
      list.push({ group: q ? '命令' : '快捷操作' });
      for (const c of matched) list.push({ kind: 'command', ...c });
    }
    list.push({ group: '检索' });
    list.push({
      kind: 'search',
      title: q ? `在所有知识库中检索「${String(query).trim()}」` : '输入关键词开始检索',
      sub: '关键词 · 标题 · 内容 · 标签',
      icon: 'search',
      disabled: !q,
      run: () => { close(); navigate('search', [], { q: String(query).trim() }); }
    });
    return list;
  }

  function render(query) {
    rows = buildRows(query);
    results.innerHTML = rows.map((row, i) => {
      if (row.group) return `<div class="palette-group">${esc(row.group)}</div>`;
      return `<div class="palette-item${row.disabled ? ' is-disabled' : ''}" data-row="${i}">
        <span class="pi-ico">${icon(row.icon || 'file')}</span>
        <span class="pi-main">
          <span class="pi-title">${esc(row.title)}</span>
          ${row.sub ? `<span class="pi-sub">${esc(row.sub)}</span>` : ''}
        </span>
      </div>`;
    }).join('');

    qsa('.palette-item', results).forEach((node) => {
      const row = rows[Number(node.getAttribute('data-row'))];
      if (row.disabled) return;
      node.addEventListener('click', () => { close(); row.run?.(); });
      node.addEventListener('mousemove', () => setActive(Number(node.getAttribute('data-row'))));
    });

    activeIndex = rows.findIndex((r) => !r.group && !r.disabled);
    setActive(activeIndex);
  }

  function setActive(index) {
    const nodes = qsa('.palette-item', results);
    nodes.forEach((n) => n.classList.remove('is-active'));
    if (index < 0) { activeIndex = -1; return; }
    const node = nodes.find((n) => Number(n.getAttribute('data-row')) === index);
    if (node) {
      node.classList.add('is-active');
      node.scrollIntoView({ block: 'nearest' });
      activeIndex = index;
    }
  }

  function move(delta) {
    const runnable = rows.map((r, i) => (!r.group && !r.disabled ? i : -1)).filter((i) => i >= 0);
    if (!runnable.length) return;
    const pos = runnable.indexOf(activeIndex);
    const next = pos < 0
      ? runnable[0]
      : runnable[(pos + delta + runnable.length) % runnable.length];
    setActive(next);
  }

  function activate() {
    const row = rows[activeIndex];
    if (!row || row.disabled) return;
    close();
    row.run?.();
  }

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); activate(); }
  };

  document.addEventListener('keydown', onKey, true);
  input.addEventListener('input', debounce(() => render(input.value), 70));
  input.addEventListener('keydown', (e) => {
    // 面板级 onKey 已处理方向键与 Enter（捕获阶段），此处仅阻止表单默认行为
    if (e.key === 'Enter') e.preventDefault();
  });
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });

  render(initialQuery);
  applyIcons(overlay);
  setTimeout(() => input.focus(), 30);
}

/* ================================================================== 启动 */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

export { ROUTES, applyIcons };
export default { navigate, openPalette, boot };
