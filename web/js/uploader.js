/**
 * KBPRO — 全局上传管理器
 * 提供：上传进度面板、并发控制、失败重试、事件通知。
 */
import api from './api.js';
import { notify, qs, qsa, el, applyIcons, icon, formatBytes, fileIconHtml } from './ui.js';
import { getState } from './store.js';

const tasks = [];       // { id, name, size, percent, status, error, file }
let panelVisible = false;

const listeners = new Set();
export function onUploadChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emitChange() {
  for (const fn of [...listeners]) {
    try { fn(tasks); } catch { /* */ }
  }
}

/* ------------------------------------------------------------------ 面板 */

function ensurePanel() {
  const panel = document.getElementById('upload-panel');
  if (!panel) return null;
  if (!panelVisible) {
    panel.hidden = false;
    panelVisible = true;
  }
  return panel;
}

export function hidePanel() {
  const panel = document.getElementById('upload-panel');
  if (panel) panel.hidden = true;
  panelVisible = false;
}

function renderPanel() {
  const panel = ensurePanel();
  if (!panel) return;
  const list = qs('#up-list', panel);
  const title = qs('#up-title', panel);

  const done = tasks.filter((t) => t.status === 'done').length;
  const failed = tasks.filter((t) => t.status === 'error').length;
  const running = tasks.filter((t) => t.status === 'uploading' || t.status === 'indexing').length;

  title.textContent = running
    ? `上传中 ${tasks.length - done - failed}/${tasks.length}`
    : failed
      ? `完成 ${done} 个 · ${failed} 个失败`
      : `已上传 ${done} 个文件`;

  list.innerHTML = tasks.map((t) => `
    <div class="up-item" data-task="${t.id}">
      <div class="up-row">
        ${fileIconHtml(t.ext)}
        <span class="up-name" title="${escapeAttr(t.name)}">${escapeHtml(t.name)}</span>
        <span class="up-status ${t.status === 'error' ? 'is-error' : t.status === 'done' ? 'is-done' : ''}">
          ${t.status === 'error' ? '失败' : t.status === 'done' ? '✓ ' + formatBytes(t.size) : t.status === 'indexing' ? '解析中' : t.percent + '%'}
        </span>
      </div>
      <div class="progress${t.status === 'error' ? ' is-danger' : t.status === 'done' ? ' is-success' : ''}">
        <span style="width:${t.status === 'error' ? 100 : t.status === 'done' ? 100 : t.percent}%"></span>
      </div>
      ${t.status === 'error' ? `<div class="text-xs text-danger" style="margin-top:5px">${escapeHtml(t.error || '上传失败')}</div>` : ''}
      ${t.status === 'error' ? `<button class="btn btn-sm btn-ghost" data-retry="${t.id}" style="margin-top:3px">重试</button>` : ''}
    </div>`).join('');

  applyIcons(panel);

  qsa('[data-retry]', list).forEach((btn) => {
    btn.addEventListener('click', () => retryTask(btn.getAttribute('data-retry')));
  });
}

function escapeHtml(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function escapeAttr(s) { return escapeHtml(s); }

/* ------------------------------------------------------------------ 上传 */

function extOf(name) {
  const i = String(name).lastIndexOf('.');
  return i > 0 ? String(name).slice(i + 1).toLowerCase() : '';
}

/**
 * 上传一组文件到当前知识库。
 * @param {File[]} files
 * @param {{folderId?:string, workspaceId?:string, tags?:string[], encrypt?:boolean, onDone?:Function}} opts
 */
export async function uploadFiles(files, opts = {}) {
  const list = [...files].filter(Boolean);
  if (!list.length) return { files: [], failed: [] };

  const state = getState();
  const workspaceId = opts.workspaceId || state.currentWorkspaceId;
  if (!workspaceId) {
    notify.error('请先选择一个知识库');
    return { files: [], failed: [] };
  }

  const batch = list.map((file, i) => ({
    id: `t${Date.now().toString(36)}${i}`,
    name: file.name,
    ext: extOf(file.name),
    size: file.size,
    percent: 0,
    status: 'uploading',
    error: '',
    file
  }));
  tasks.unshift(...batch);
  renderPanel();
  emitChange();

  let result = { files: [], failed: [] };
  try {
    result = await api.upload(list, {
      workspaceId,
      folderId: opts.folderId,
      tags: opts.tags,
      encrypt: opts.encrypt
    }, (p) => {
      for (const t of batch) t.percent = p.percent;
      renderPanel();
    });

    const okNames = new Set((result.files || []).map((f) => f.name));
    for (const t of batch) {
      if ((result.failed || []).some((f) => f.filename === t.file.name)) {
        t.status = 'error';
        t.error = (result.failed || []).find((f) => f.filename === t.file.name)?.error || '上传失败';
      } else {
        t.status = 'indexing';
        t.percent = 100;
      }
    }
    renderPanel();

    // 后台解析中 → 显示为「解析中」，随后由 SSE 或轮询更新
    for (const f of result.files || []) {
      watchIndexing(f.id, f.name);
    }

    const okCount = (result.files || []).length;
    const failCount = (result.failed || []).length;
    if (okCount) notify.success(`成功上传 ${okCount} 个文件${failCount ? `，${failCount} 个失败` : ''}`);
    if (failCount && !okCount) notify.error(`${failCount} 个文件上传失败`);
    opts.onDone?.(result);
  } catch (err) {
    for (const t of batch) {
      t.status = 'error';
      t.error = err?.message || '上传失败';
    }
    renderPanel();
    notify.error(err?.message || '上传失败');
    emitChange();
    return { files: [], failed: batch, error: err };
  }

  emitChange();
  return result;
}

/** 轮询解析状态，更新面板 */
async function watchIndexing(fileId, name) {
  const task = tasks.find((t) => t.name === name && t.status === 'indexing');
  const deadline = Date.now() + 90000;
  const tick = async () => {
    if (Date.now() > deadline) {
      if (task) { task.status = 'done'; renderPanel(); emitChange(); }
      return;
    }
    try {
      const r = await api.fileText(fileId);
      if (r.status === 'ok' || r.status === 'empty' || r.status === 'failed') {
        if (task) {
          task.status = r.status === 'failed' ? 'error' : 'done';
          task.error = r.status === 'failed' ? (r.error || '解析失败') : '';
          renderPanel();
          emitChange();
        }
        if (r.status === 'ok') {
          document.dispatchEvent(new CustomEvent('kbpro:file-indexed', { detail: { fileId, name } }));
        }
        return;
      }
    } catch { /* 继续重试 */ }
    setTimeout(tick, 1200);
  };
  setTimeout(tick, 900);
}

async function retryTask(id) {
  const task = tasks.find((t) => t.id === id);
  if (!task) return;
  task.status = 'uploading';
  task.error = '';
  task.percent = 0;
  renderPanel();
  const res = await uploadFiles([task.file]);
  if (res.files?.length) {
    tasks.splice(tasks.indexOf(task), 1);
    renderPanel();
    emitChange();
  }
}

export function clearFinishedTasks() {
  for (let i = tasks.length - 1; i >= 0; i--) {
    if (tasks[i].status === 'done') tasks.splice(i, 1);
  }
  renderPanel();
  emitChange();
}

export function taskList() {
  return tasks;
}

/* ------------------------------------------------------------------ 初始化 */

export function initUploadPanel() {
  const panel = document.getElementById('upload-panel');
  if (!panel) return;
  qs('#up-close', panel).addEventListener('click', () => {
    hidePanel();
    clearFinishedTasks();
  });
  applyIcons(panel);

  document.addEventListener('kbpro:file-indexed', (e) => {
    const { name } = e.detail || {};
    if (name) notify.success(`《${name}》解析完成，已可检索与问答`, { duration: 2200 });
  });
  window.addEventListener('kbpro:upload-open', () => ensurePanel());
}

export default { uploadFiles, initUploadPanel, onUploadChange, taskList, hidePanel };
