/**
 * KBPRO — 回收站
 *
 * 已删除的文档与笔记集中在这里，可单项或批量恢复 / 彻底删除。
 * 结构参考 pages/dashboard.js：模板字符串 + el() + 委托 on()。
 */
import {
  qs, qsa, on, icon, notify, confirmDialog,
  esc, emptyState, skeleton, timeAgo, formatBytes, formatNumber, fileIconHtml
} from '../ui.js';

export const meta = { title: '回收站', icon: 'trash' };

/* ------------------------------------------------------------------ 模块状态 */

let cleanup = [];
let dom = {};
let ctxRef = null;
let runId = 0;

let state = freshState();

function freshState() {
  return {
    tab: 'files',
    files: [],
    notes: [],
    folderMap: new Map(),
    selected: new Set()
  };
}

const TAB_LABELS = { files: '文档', notes: '笔记' };

/* ================================================================== 挂载 */

export async function mount(container, ctx) {
  ctxRef = ctx;
  cleanup = [];
  dom = {};
  runId = 0;
  state = freshState();

  const { workspace } = ctx;
  if (!workspace) {
    container.innerHTML = `<div class="page">${emptyState({
      iconName: 'trash',
      title: '还没有知识库',
      desc: '请先在左上角创建一个知识库，回收站会按知识库分别管理。'
    })}</div>`;
    return;
  }

  container.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">回收站</div>
        <div class="page-desc">已删除的文档与笔记会保留在这里，确认不再需要后再彻底删除。</div>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" type="button" data-refresh>${icon('refresh', 15)}<span>刷新</span></button>
      </div>
    </div>

    <div class="card mb-5" style="border-color:var(--c-warn);background:var(--c-warn-bg)">
      <div class="card-pad" style="display:flex;gap:12px;align-items:flex-start;padding:14px 18px">
        <span style="width:18px;height:18px;flex:none;color:var(--c-warn)">${icon('alert', 18)}</span>
        <div style="min-width:0">
          <div class="text-sm" style="font-weight:600;color:var(--c-warn)">回收站中的内容不会被自动清理，直到你手动彻底删除</div>
          <div class="text-xs text-2" style="line-height:1.75;margin-top:3px">
            「彻底删除」会立即清除文件本体、解析文本、标签关联与笔记版本记录，<strong>操作不可恢复</strong>。
            如果不确定，请先「恢复」到原位置，稍后再决定。
          </div>
        </div>
      </div>
    </div>

    <div class="tabs" id="trash-tabs">
      <button class="tab is-active" type="button" data-tab="files">文档 <span class="badge" data-count="files">0</span></button>
      <button class="tab" type="button" data-tab="notes">笔记 <span class="badge" data-count="notes">0</span></button>
    </div>

    <div id="trash-body">${skeleton(4)}</div>
  </div>`;

  dom = {
    body: qs('#trash-body', container),
    tabs: qs('#trash-tabs', container)
  };

  bind(container);
  await loadAll();
}

export function unmount() {
  for (const off of cleanup) {
    try { if (typeof off === 'function') off(); } catch { /* 忽略单个解绑失败 */ }
  }
  cleanup = [];
  runId++;
  dom = {};
  ctxRef = null;
  state = freshState();
}

/* ================================================================== 数据 */

function currentList() {
  return state.tab === 'files' ? state.files : state.notes;
}

async function loadAll() {
  if (!ctxRef || !dom.body) return;
  const api = ctxRef.api;
  const workspaceId = ctxRef.workspace.id;
  const myRun = ++runId;

  dom.body.innerHTML = skeleton(4);

  try {
    const [filesRes, notesRes, folderRes] = await Promise.all([
      api.files({ workspaceId, trash: 1, limit: 200, sort: 'updated' }),
      api.notes({ workspaceId, trash: 1, limit: 200, sort: 'updated' }),
      api.folders(workspaceId).catch(() => null)
    ]);
    if (!ctxRef || myRun !== runId) return;

    state.files = Array.isArray(filesRes?.files) ? filesRes.files : [];
    state.notes = Array.isArray(notesRes?.notes) ? notesRes.notes : [];
    state.folderMap = new Map();
    for (const folder of folderRes?.flat || []) {
      state.folderMap.set(folder.id, folder.name);
    }
    state.selected.clear();
    render();
  } catch (err) {
    if (!ctxRef || myRun !== runId) return;
    dom.body.innerHTML = `<div class="card">${emptyState({
      iconName: 'alert',
      title: '加载失败',
      desc: esc(err?.message || '请稍后重试'),
      actions: '<button class="btn btn-default" data-refresh>重试</button>'
    })}</div>`;
  }
}

/* ================================================================== 渲染 */

function miniIcon(name, size = 12) {
  return `<span style="display:inline-flex;align-items:center;width:${size}px;height:${size}px;vertical-align:-2px;flex:none">${icon(name, size)}</span>`;
}

function updateTabs() {
  if (!dom.tabs) return;
  qsa('[data-tab]', dom.tabs).forEach((node) => {
    const tab = node.getAttribute('data-tab');
    node.classList.toggle('is-active', tab === state.tab);
    const badge = qs(`[data-count="${tab}"]`, node);
    if (badge) badge.textContent = formatNumber(tab === 'files' ? state.files.length : state.notes.length);
  });
}

function render() {
  if (!dom.body) return;
  updateTabs();

  const list = currentList();
  const tabLabel = TAB_LABELS[state.tab] || '内容';

  if (!list.length) {
    dom.body.innerHTML = `<div class="card">${emptyState({
      iconName: 'trash',
      title: '回收站是空的',
      desc: state.tab === 'files'
        ? '当前没有已删除的文档。删除的文档会先进入这里，可随时恢复。'
        : '当前没有已删除的笔记。删除的笔记会先进入这里，可随时恢复。'
    })}</div>`;
    return;
  }

  // 文件接口暂不返回 deletedAt，此时退化为展示 updatedAt 并标注为「更新时间」
  const hasDeletedAt = list.every((item) => !!item.deletedAt);
  const timeLabel = hasDeletedAt ? '删除时间' : '更新时间';

  const allChecked = list.every((item) => state.selected.has(item.id));
  const someChecked = !allChecked && list.some((item) => state.selected.has(item.id));

  dom.body.innerHTML = `
    ${state.selected.size ? batchBarHtml() : ''}
    <div class="card">
      <table class="table">
        <thead>
          <tr>
            <th style="width:38px">
              <span class="checkbox${allChecked ? ' is-checked' : someChecked ? ' is-indeterminate' : ''}"
                    data-check-all role="checkbox" tabindex="0"
                    aria-label="全选${esc(tabLabel)}" aria-checked="${allChecked}"></span>
            </th>
            <th>名称</th>
            <th style="width:190px">原位置</th>
            <th class="num" style="width:110px">${state.tab === 'files' ? '大小' : '字数'}</th>
            <th style="width:130px">${timeLabel}</th>
            <th style="width:190px"></th>
          </tr>
        </thead>
        <tbody>${list.map((item) => rowHtml(item, timeLabel)).join('')}</tbody>
      </table>
    </div>
    <div class="text-xs text-muted" style="margin-top:10px">
      共 ${formatNumber(list.length)} 项${timeLabel === '更新时间' ? '（文件删除时间未单独记录，这里显示最近更新时间）' : ''} · 回收站内容不会被自动清理，彻底删除后无法恢复。
    </div>`;
}

function rowHtml(item, timeLabel) {
  const isFile = state.tab === 'files';
  const checked = state.selected.has(item.id);
  const title = isFile ? item.name : item.title;
  const folderName = item.folderId ? (state.folderMap.get(item.folderId) || '未知文件夹') : '根目录';
  const when = item.deletedAt || item.updatedAt;
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const sub = isFile
    ? (String(item.ext || '').toUpperCase() || 'FILE')
    : `${formatNumber(item.wordCount)} 字`;
  const sizeCell = isFile ? formatBytes(item.size) : `${formatNumber(item.wordCount)} 字`;

  return `<tr data-row-id="${esc(item.id)}"${checked ? ' class="is-selected"' : ''}>
    <td>
      <span class="checkbox${checked ? ' is-checked' : ''}" data-check role="checkbox" tabindex="0"
            aria-checked="${checked}" aria-label="选择「${esc(title)}」"></span>
    </td>
    <td>
      <div class="flex gap-3" style="align-items:center;min-width:0">
        ${isFile
          ? fileIconHtml(item.ext)
          : `<span class="file-ico f-md" style="background:var(--c-ink-100);color:var(--c-ink-700);font-size:16px">${esc(item.emoji || 'NOTE')}</span>`}
        <div class="file-main" style="min-width:0">
          <div class="file-name">${esc(title)}</div>
          <div class="file-meta">
            <span class="fm-item">${esc(sub)}</span>
            ${tags.length ? `<span class="fm-item">${esc(tags.slice(0, 3).join(' · '))}${tags.length > 3 ? ` +${tags.length - 3}` : ''}</span>` : ''}
          </div>
        </div>
      </div>
    </td>
    <td class="text-sm text-muted">${miniIcon('folder')} ${esc(folderName)}</td>
    <td class="num">${esc(sizeCell)}</td>
    <td class="text-sm text-muted" title="${esc(when || '')} ${esc(timeLabel)}">${esc(timeAgo(when))}</td>
    <td>
      <div class="flex gap-2" style="justify-content:flex-end">
        <button class="btn btn-sm btn-default" type="button" data-act="restore">${icon('restore', 13)}<span>恢复</span></button>
        <button class="btn btn-sm btn-danger" type="button" data-act="purge">${icon('trash', 13)}<span>彻底删除</span></button>
      </div>
    </td>
  </tr>`;
}

function batchBarHtml() {
  const n = state.selected.size;
  const list = currentList();
  const allChecked = list.length > 0 && list.every((item) => state.selected.has(item.id));
  return `<div class="batch-bar">
    <span class="bb-count">已选择 ${formatNumber(n)} 项</span>
    <span class="vr"></span>
    <button class="btn btn-sm" type="button" data-batch="all">${icon('check', 13)}<span>${allChecked ? '取消全选' : '全选本页'}</span></button>
    <button class="btn btn-sm" type="button" data-batch="restore">${icon('restore', 13)}<span>批量恢复</span></button>
    <button class="btn btn-sm btn-danger" type="button" data-batch="purge">${icon('trash', 13)}<span>批量彻底删除</span></button>
    <span class="spacer"></span>
    <button class="btn btn-sm" type="button" data-batch="clear">${icon('close', 13)}<span>取消选择</span></button>
  </div>`;
}

/* ================================================================== 操作 */

function rowIdFrom(node) {
  return node.closest('[data-row-id]')?.getAttribute('data-row-id') || '';
}

function itemLabel(id) {
  const item = currentList().find((it) => it.id === id);
  if (!item) return '该项目';
  return state.tab === 'files' ? item.name : item.title;
}

async function restoreOne(id) {
  if (!ctxRef || !id) return;
  const api = ctxRef.api;
  try {
    if (state.tab === 'files') await api.restoreFile(id);
    else await api.restoreNote(id);
    state.selected.delete(id);
    notify.success('已恢复到原位置');
    await loadAll();
  } catch (err) {
    notify.error(err?.message || '恢复失败');
  }
}

async function purgeOne(id) {
  if (!ctxRef || !id) return;

  const confirmed = await confirmDialog({
    title: '彻底删除',
    message: `确定要彻底删除「${esc(itemLabel(id))}」吗？<br><br>这会永久清除内容本体、解析文本与版本记录，<strong>无法恢复</strong>。`,
    confirmText: '彻底删除',
    danger: true
  });
  if (!confirmed || !ctxRef) return;

  const api = ctxRef.api;
  try {
    if (state.tab === 'files') await api.deleteFile(id, true);
    else await api.deleteNote(id, true);
    state.selected.delete(id);
    notify.success('已彻底删除');
    await loadAll();
  } catch (err) {
    notify.error(err?.message || '彻底删除失败');
  }
}

/** 汇报批量结果：{ ok, failed, errors } */
function reportBatch(res, verb) {
  const ok = Number(res?.ok || 0);
  const failed = Number(res?.failed || 0);
  if (failed > 0) {
    const first = res?.errors?.[0]?.error || '';
    notify.error(`${verb}完成 ${ok} 项，${failed} 项失败${first ? `：${first}` : ''}`);
  } else if (ok > 0) {
    notify.success(`已${verb} ${formatNumber(ok)} 项`);
  } else {
    notify.warn(`没有可${verb}的项目`);
  }
}

async function batchRestore() {
  if (!ctxRef) return;
  const ids = [...state.selected];
  if (!ids.length) return;
  const api = ctxRef.api;
  try {
    const res = state.tab === 'files'
      ? await api.batchFiles('restore', ids)
      : await api.batchNotes('restore', ids);
    reportBatch(res, '恢复');
    state.selected.clear();
    await loadAll();
  } catch (err) {
    notify.error(err?.message || '批量恢复失败');
  }
}

async function batchPurge() {
  if (!ctxRef) return;
  const ids = [...state.selected];
  if (!ids.length) return;
  const isFiles = state.tab === 'files';

  const confirmed = await confirmDialog({
    title: '批量彻底删除',
    message: `即将彻底删除 <strong>${formatNumber(ids.length)}</strong> 项内容。<br><br>内容本体、解析文本与版本记录都会被永久清除，<strong>无法恢复</strong>，请谨慎操作。`,
    confirmText: `彻底删除 ${ids.length} 项`,
    danger: true
  });
  if (!confirmed || !ctxRef) return;

  const api = ctxRef.api;
  const result = { ok: 0, failed: 0, errors: [] };

  try {
    if (isFiles) {
      const res = await api.batchFiles('hard-delete', ids);
      result.ok = Number(res?.ok || 0);
      result.failed = Number(res?.failed || 0);
      result.errors = Array.isArray(res?.errors) ? res.errors : [];
    } else {
      // 笔记批量接口暂不支持 hard-delete，逐条彻底删除并汇总失败项
      for (const id of ids) {
        try {
          await api.deleteNote(id, true);
          result.ok++;
        } catch (err) {
          result.failed++;
          result.errors.push({ id, error: err?.message || '删除失败' });
        }
      }
    }
    reportBatch(result, '彻底删除');
    state.selected.clear();
    await loadAll();
  } catch (err) {
    notify.error(err?.message || '批量彻底删除失败');
  }
}

/* ================================================================== 事件 */

function bind(container) {
  const push = (off) => cleanup.push(off);

  push(on(container, 'click', '[data-refresh]', () => {
    void loadAll();
  }));

  push(on(container, 'click', '[data-tab]', (e, node) => {
    const tab = node.getAttribute('data-tab');
    if (tab === state.tab) return;
    state.tab = tab;
    state.selected.clear();
    render();
  }));

  push(on(dom.body, 'click', '[data-check-all]', () => {
    const list = currentList();
    const allChecked = list.length > 0 && list.every((item) => state.selected.has(item.id));
    if (allChecked) state.selected.clear();
    else list.forEach((item) => state.selected.add(item.id));
    render();
  }));

  push(on(dom.body, 'click', '[data-check]', (e, node) => {
    const id = rowIdFrom(node);
    if (!id) return;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    render();
  }));

  push(on(dom.body, 'keydown', '[data-check], [data-check-all]', (e, node) => {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    node.click();
  }));

  push(on(dom.body, 'click', '[data-act="restore"]', (e, node) => {
    const id = rowIdFrom(node);
    if (id) restoreOne(id);
  }));

  push(on(dom.body, 'click', '[data-act="purge"]', (e, node) => {
    const id = rowIdFrom(node);
    if (id) purgeOne(id);
  }));

  push(on(dom.body, 'click', '[data-batch]', (e, node) => {
    const action = node.getAttribute('data-batch');
    if (action === 'restore') { void batchRestore(); return; }
    if (action === 'purge') { void batchPurge(); return; }
    if (action === 'all') {
      const list = currentList();
      const allChecked = list.length > 0 && list.every((item) => state.selected.has(item.id));
      if (allChecked) state.selected.clear();
      else list.forEach((item) => state.selected.add(item.id));
      render();
      return;
    }
    state.selected.clear();
    render();
  }));
}

export default { meta, mount, unmount };
