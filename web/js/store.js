/**
 * KBPRO — 轻量响应式状态容器
 */
const listeners = new Set();

const state = {
  ready: false,
  user: null,
  teams: [],
  workspaces: [],
  currentWorkspaceId: '',
  folders: [],
  tags: [],
  ai: null,
  system: null,
  ui: {
    sidebarCollapsed: false,
    filesView: 'list',
    notesSort: 'updated',
    filesSort: 'updated',
    lastRoute: 'dashboard',
    dismissedHints: []
  }
};

/* ------------------------------------------------------------------ 存取 */

export function getState() {
  return state;
}

export function setState(patch, { silent = false } = {}) {
  if (typeof patch === 'function') patch = patch(state);
  if (!patch) return state;
  deepAssign(state, patch);
  persistUi();
  if (!silent) emit(patch);
  return state;
}

function deepAssign(target, source) {
  for (const [k, v] of Object.entries(source)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepAssign(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(patch) {
  for (const fn of [...listeners]) {
    try { fn(state, patch); } catch (e) { console.error('[store] 订阅者异常', e); }
  }
}

/* ------------------------------------------------------------------ 派生 */

export function currentWorkspace() {
  return state.workspaces.find((w) => w.id === state.currentWorkspaceId) || state.workspaces[0] || null;
}

export function currentPermission() {
  const ws = currentWorkspace();
  return ws?.permission || 'none';
}

export function canWrite() {
  return ['edit', 'manage'].includes(currentPermission());
}

export function canManage() {
  return currentPermission() === 'manage';
}

export function isAdmin() {
  return state.user?.role === 'admin';
}

export function workspaceKindLabel(ws) {
  return ws?.kind === 'team' ? '团队知识库' : '个人知识库';
}

/* ------------------------------------------------------------------ 持久化 */

const LS_KEY = 'kbpro.ui.v1';

export function persistUi() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      sidebarCollapsed: state.ui.sidebarCollapsed,
      filesView: state.ui.filesView,
      filesSort: state.ui.filesSort,
      notesSort: state.ui.notesSort,
      currentWorkspaceId: state.currentWorkspaceId,
      lastRoute: state.ui.lastRoute,
      dismissedHints: state.ui.dismissedHints
    }));
  } catch { /* 忽略隐私模式错误 */ }
}

export function restoreUi() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    Object.assign(state.ui, {
      sidebarCollapsed: !!saved.sidebarCollapsed,
      filesView: saved.filesView || 'list',
      filesSort: saved.filesSort || 'updated',
      notesSort: saved.notesSort || 'updated',
      lastRoute: saved.lastRoute || 'dashboard',
      dismissedHints: Array.isArray(saved.dismissedHints) ? saved.dismissedHints : []
    });
    if (saved.currentWorkspaceId) state.currentWorkspaceId = saved.currentWorkspaceId;
  } catch { /* 忽略 */ }
}

export function dismissHint(id) {
  if (!state.ui.dismissedHints.includes(id)) {
    state.ui.dismissedHints.push(id);
    persistUi();
  }
}

export function hintDismissed(id) {
  return state.ui.dismissedHints.includes(id);
}

/* ------------------------------------------------------------------ 刷新 */

/** 重新拉取工作区列表，保持当前选择有效 */
export async function refreshWorkspaces(api) {
  const data = await api.workspaces();
  const list = data.workspaces || [];
  const stillValid = list.some((w) => w.id === state.currentWorkspaceId);
  state.workspaces = list;
  if (!stillValid) {
    const preferred = list.find((w) => w.kind === 'personal') || list[0];
    state.currentWorkspaceId = preferred?.id || '';
  }
  persistUi();
  return list;
}

export { state };
export default { getState, setState, subscribe, currentWorkspace, currentPermission, canWrite, canManage, isAdmin };
