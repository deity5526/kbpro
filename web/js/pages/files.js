/**
 * KBPRO — 文件库
 * 文件夹树 · 上传 · 列表/网格视图 · 批量操作 · 在线预览 · AI 解析 · 共享与评论
 */
import {
  qs, qsa, el, on, applyIcons, icon, notify, toast, modal, confirmDialog, promptDialog,
  drawer, dropdown, contextMenu, copyText, emptyState, esc, skeleton,
  timeAgo, formatDate, formatDateTime, formatBytes, formatNumber,
  fileIconHtml, fileKind, avatarHtml, badge, tagHtml, pickFiles, downloadUrl, debounce,
  highlightText, stripHtml, excerpt
} from '../ui.js';
import { uploadFiles } from '../uploader.js';
import { getState, setState, canWrite } from '../store.js';
import { renderChatMarkdown } from '../md.js';

export const meta = { title: '文件库', icon: 'file' };

let cleanup = [];
let ctxRef = null;
let state = {
  workspaceId: '',
  folderId: 'all',        // 'all' | 'root' | folderId
  files: [],
  folders: { tree: [], flat: [] },
  counts: [],
  selected: new Set(),
  query: '',
  filter: 'all',          // all | starred | pinned | encrypted
  sort: 'updated',
  order: 'desc',
  loading: false,
  openFolders: new Set(),
  treeOpen: false
};

/* ================================================================== 挂载 */

export async function mount(container, ctx) {
  ctxRef = ctx;
  const ws = ctx.workspace;
  if (!ws) {
    container.innerHTML = `<div class="page">${emptyState({ iconName: 'layers', title: '还没有知识库', desc: '请先创建一个知识库' })}</div>`;
    return;
  }

  state.workspaceId = ws.id;
  state.selected = new Set();
  state.query = '';
  state.filter = ctx.query.filter || 'all';
  state.sort = getState().ui.filesSort || 'updated';
  state.folderId = ctx.query.folderId || 'all';
  if (ctx.query.starred === '1') state.filter = 'starred';

  container.innerHTML = shellHtml();
  applyIcons(container);

  bindTree(container, ctx);
  bindToolbar(container, ctx);
  bindList(container, ctx);

  await Promise.all([loadTree(ctx), loadFiles(ctx)]);

  // 深度链接：直接打开某个文件
  if (ctx.query.open) {
    setTimeout(() => openFile(ctx, ctx.query.open), 120);
  }
}

export function unmount() {
  for (const off of cleanup) { try { typeof off === 'function' && off(); } catch { /* */ } }
  cleanup = [];
  ctxRef = null;
}

/* ================================================================== 骨架 */

function shellHtml() {
  return `<div class="files-layout" id="files-layout">
    <aside class="tree-pane">
      <div class="tree-pane-head">
        <span class="tree-pane-title">分类目录</span>
        <div class="flex gap-1">
          <button class="icon-btn sm" data-tree-action="new-folder" title="新建文件夹">${icon('plus')}</button>
          <button class="icon-btn sm only-mobile" data-tree-action="close" title="收起">${icon('close')}</button>
        </div>
      </div>
      <div class="tree-scroll" id="tree-scroll">
        <div class="flex-col gap-1" style="padding:2px 0">
          <div class="skel skel-line" style="width:70%;height:26px"></div>
          <div class="skel skel-line" style="width:56%;height:26px"></div>
          <div class="skel skel-line" style="width:64%;height:26px"></div>
        </div>
      </div>
      <div style="padding:12px;border-top:1px solid var(--c-border)">
        <div class="text-xs text-muted mb-2" id="tree-storage">存储占用 —</div>
        <div class="progress"><span id="tree-storage-bar" style="width:0%"></span></div>
      </div>
    </aside>

    <section class="files-pane">
      <div class="files-pane-head">
        <button class="icon-btn sm only-mobile" data-pane-action="open-tree" title="目录">${icon('folder')}</button>
        <div>
          <div class="files-pane-title" id="pane-title">全部文件</div>
          <div class="files-pane-count" id="pane-count">加载中…</div>
        </div>
        <div class="spacer" style="flex:1"></div>
        <div class="search-box" style="width:220px;max-width:42vw">
          <span class="sb-ico">${icon('search')}</span>
          <input class="input input-sm" id="file-search" placeholder="在文件库中搜索…">
        </div>
        <div class="segmented" id="view-mode">
          <button data-view="list" title="列表视图">${icon('list')}</button>
          <button data-view="grid" title="网格视图">${icon('grid')}</button>
        </div>
        <button class="btn btn-sm btn-default" data-pane-action="sort">${icon('sort')}<span id="sort-label">最近更新</span></button>
        <button class="btn btn-sm btn-default" data-pane-action="filter">${icon('filter')}<span id="filter-label">全部</span></button>
        <button class="btn btn-sm btn-primary" data-pane-action="upload">${icon('upload')}<span>上传</span></button>
      </div>
      <div class="files-scroll" id="files-scroll">
        <div id="batch-host"></div>
        <div id="files-host">${skeleton(5)}</div>
      </div>
    </section>
  </div>`;
}

/* ================================================================== 数据 */

async function loadTree(ctx) {
  const host = qs('#tree-scroll');
  try {
    const data = await ctx.api.folders(state.workspaceId);
    state.folders = { tree: data.tree || [], flat: data.flat || [] };
    if (state.openFolders.size === 0) {
      for (const f of state.folders.tree) state.openFolders.add(f.id);
    }
    renderTree(ctx);
    renderStorage(ctx);
  } catch (err) {
    host.innerHTML = `<div class="text-sm text-danger" style="padding:12px">目录加载失败：${esc(err.message)}</div>`;
  }
}

function renderTree(ctx) {
  const host = qs('#tree-scroll');
  if (!host) return;

  const totalFiles = state.files.length;
  const unfiled = countUnfiled();

  const fixed = `
    <div class="flex-col" style="gap:1px;padding-bottom:6px;border-bottom:1px solid var(--c-border);margin-bottom:6px">
      ${fixedRow('all', '全部文件', 'layers', state.counts.reduce((s, c) => s + c.count, 0))}
      ${fixedRow('root', '未分类', 'inbox', unfiled)}
      ${fixedRow('starred', '收藏', 'star', null, 'filter:starred')}
      ${fixedRow('pinned', '置顶', 'pin', null, 'filter:pinned')}
    </div>`;

  const tree = state.folders.tree.length
    ? state.folders.tree.map((node) => renderNode(node, 0)).join('')
    : `<div class="text-sm text-muted" style="padding:10px 8px">还没有文件夹，点击右上角 ＋ 新建。</div>`;

  host.innerHTML = fixed + tree;
  applyIcons(host);

  // 拖拽落点：根级
  qsa('[data-drop-root]', host).forEach((node) => {
    node.addEventListener('dragover', (e) => { e.preventDefault(); node.classList.add('is-drop-target'); });
    node.addEventListener('dragleave', () => node.classList.remove('is-drop-target'));
    node.addEventListener('drop', async (e) => {
      e.preventDefault();
      node.classList.remove('is-drop-target');
      await handleDrop(ctx, null, [...(e.dataTransfer?.files || [])]);
    });
  });
  void totalFiles;
}

function fixedRow(id, label, ico, count, action) {
  const active = !action && state.folderId === id;
  const activeFilter = action === `filter:${state.filter}`;
  return `<div class="tree-row${active || activeFilter ? ' is-active' : ''}" data-fixed="${id}" ${action ? `data-filter-action="${action.split(':')[1]}"` : ''} data-drop-root="${id === 'root' ? '1' : ''}">
    <span class="tree-caret is-leaf">${icon('chevronRight')}</span>
    <span class="tree-ico">${icon(ico)}</span>
    <span class="tree-label">${esc(label)}</span>
    ${count !== null && count !== undefined ? `<span class="tree-count">${count}</span>` : ''}
  </div>`;
}

function renderNode(node, depth) {
  const open = state.openFolders.has(node.id);
  const active = state.folderId === node.id;
  const hasChildren = node.children && node.children.length > 0;
  const childrenId = `tree-children-${node.id}`;
  const count = node.totalFileCount !== undefined ? node.totalFileCount : (node.fileCount || 0);

  return `<div class="tree-node${open ? ' is-open' : ''}" data-node="${esc(node.id)}">
    <div class="tree-row${active ? ' is-active' : ''}" data-folder="${esc(node.id)}" draggable="true" data-depth="${depth}">
      <span class="tree-caret${hasChildren ? '' : ' is-leaf'}" data-toggle="${esc(node.id)}">${icon('chevronRight')}</span>
      <span class="tree-ico">${icon(node.icon || 'folder')}</span>
      <span class="tree-label" title="${esc(node.name)}">${esc(node.name)}</span>
      <span class="tree-count">${count}</span>
      <span class="icon-btn sm tree-more" data-folder-menu="${esc(node.id)}" title="更多">${icon('moreV')}</span>
    </div>
    ${hasChildren ? `<div class="tree-children" id="${childrenId}" ${open ? '' : 'hidden'}>${node.children.map((c) => renderNode(c, depth + 1)).join('')}</div>` : ''}
  </div>`;
}

function countUnfiled() {
  const root = state.counts.find((c) => c.folderId === null);
  return root ? root.count : 0;
}

async function renderStorage(ctx) {
  try {
    const s = await ctx.api.storage();
    const label = qs('#tree-storage');
    const bar = qs('#tree-storage-bar');
    if (!label || !bar) return;
    if (s.quota > 0) {
      const pct = Math.min(100, Math.round((s.used / s.quota) * 100));
      label.textContent = `存储占用 ${s.usedText} / ${formatBytes(s.quota)}`;
      bar.style.width = `${pct}%`;
      if (pct > 85) bar.parentElement.classList.add('is-danger');
    } else {
      label.textContent = `存储占用 ${s.usedText}（不限额）`;
      bar.style.width = `${Math.min(100, (s.used / (100 * 1024 * 1024)) * 100)}%`;
    }
  } catch { /* 静默 */ }
}

async function loadFiles(ctx) {
  const host = qs('#files-host');
  const scroll = qs('#files-scroll');
  state.loading = true;
  if (host && state.files.length === 0) host.innerHTML = skeleton(5);

  const params = { workspaceId: state.workspaceId, limit: 200, sort: state.sort, order: state.order };
  if (state.folderId === 'root') params.folderId = 'root';
  else if (state.folderId !== 'all') params.folderId = state.folderId;
  if (state.query) params.q = state.query;
  if (state.filter === 'starred') params.starred = 1;
  if (state.filter === 'pinned') params.pinned = 1;
  if (state.filter === 'encrypted') params.encrypted = 1;

  try {
    const data = await ctx.api.files(params);
    state.files = data.files || [];
    state.counts = data.folders || [];
    state.loading = false;
    renderTitle(ctx);
    renderFiles(ctx);
    renderTree(ctx);
    if (scroll) scroll.scrollTop = 0;
  } catch (err) {
    state.loading = false;
    if (host) {
      host.innerHTML = emptyState({
        iconName: 'alert', title: '加载失败', desc: esc(err.message),
        actions: '<button class="btn btn-default" data-retry>重试</button>'
      });
    }
  }
}

function renderTitle(ctx) {
  const title = qs('#pane-title');
  const count = qs('#pane-count');
  if (!title) return;
  if (state.filter === 'starred') title.textContent = '收藏的文件';
  else if (state.filter === 'pinned') title.textContent = '置顶的文件';
  else if (state.filter === 'encrypted') title.textContent = '加密文件';
  else if (state.folderId === 'all') title.textContent = '全部文件';
  else if (state.folderId === 'root') title.textContent = '未分类';
  else {
    const node = state.folders.flat.find((f) => f.id === state.folderId);
    title.textContent = node ? node.name : '全部文件';
  }
  const total = state.files.length;
  const size = state.files.reduce((s, f) => s + (f.size || 0), 0);
  const pending = state.files.filter((f) => ['pending', 'processing'].includes(f.text?.status)).length;
  count.textContent = `${total} 个文件 · ${formatBytes(size)}${pending ? ` · ${pending} 个解析中` : ''}${state.query ? ` · 匹配「${state.query}」` : ''}`;
}

/* ================================================================== 渲染 */

function renderFiles(ctx) {
  const host = qs('#files-host');
  if (!host) return;
  const view = getState().ui.filesView || 'list';

  if (!state.files.length) {
    host.innerHTML = state.query
      ? emptyState({ iconName: 'search', title: '没有匹配的文件', desc: `未找到包含「${esc(state.query)}」的文件`, actions: '<button class="btn btn-default" data-pane-action="clear-search">清除搜索</button>' })
      : emptyState({
        iconName: 'file',
        title: state.folderId === 'all' ? '这个知识库还没有文件' : '该目录下暂无文件',
        desc: '支持 PDF、Word、Excel、PPT、Markdown、TXT、CSV、代码等格式，上传后会自动解析并建立索引，之后即可检索与问答。',
        actions: canWrite()
          ? '<button class="btn btn-primary" data-pane-action="upload">上传文件</button><button class="btn btn-default" data-pane-action="new-folder">新建文件夹</button>'
          : ''
      });
    renderBatchBar(ctx);
    return;
  }

  host.innerHTML = view === 'grid' ? renderGrid(ctx) : renderList(ctx);
  applyIcons(host);
  renderBatchBar(ctx);
}

function renderList(ctx) {
  return `<div class="file-list">${state.files.map((f) => rowHtml(f)).join('')}</div>`;
}

function rowHtml(f) {
  const selected = state.selected.has(f.id);
  const tags = (f.tags || []).slice(0, 2);
  return `<div class="file-row${selected ? ' is-selected' : ''}" data-file="${esc(f.id)}" draggable="true">
    <span class="file-check${selected ? ' is-forced' : ''}" data-check="${esc(f.id)}">
      <span class="checkbox${selected ? ' is-checked' : ''}"></span>
    </span>
    ${fileIconHtml(f.ext)}
    <div class="file-main">
      <div class="file-name">
        ${f.pinned ? `<span class="pin-ico">${icon('pinFill')}</span>` : ''}
        ${f.starred ? `<span class="star-ico">${icon('starFill')}</span>` : ''}
        <span class="truncate">${esc(f.name)}</span>
        ${f.encrypted ? `<span class="badge" title="已加密">${icon('lock')}</span>` : ''}
        ${statusBadge(f)}
      </div>
      <div class="file-meta">
        <span class="fm-item">${formatBytes(f.size)}</span>
        ${tags.length ? tags.map((t) => tagHtml(t)).join('') : ''}
      </div>
    </div>
    <div class="file-col col-date">${esc(timeAgo(f.updatedAt))}</div>
    <div class="file-col num col-size">${formatBytes(f.size)}</div>
    <div class="file-col num col-views">${f.viewCount || 0} 次查看</div>
    <div class="file-actions">
      <button class="icon-btn sm" data-file-act="menu" data-id="${esc(f.id)}" title="更多操作">${icon('moreV')}</button>
    </div>
  </div>`;
}

function renderGrid(ctx) {
  return `<div class="file-grid">${state.files.map((f) => {
    const selected = state.selected.has(f.id);
    const kind = fileKind(f.ext);
    return `<div class="file-card${selected ? ' is-selected' : ''}" data-file="${esc(f.id)}" draggable="true">
      <div class="file-card-check" data-check="${esc(f.id)}"><span class="checkbox${selected ? ' is-checked' : ''}"></span></div>
      <div class="file-card-badge">
        ${f.pinned ? `<span class="badge">${icon('pin')}</span>` : ''}
        ${f.starred ? `<span class="badge">${icon('starFill')}</span>` : ''}
        ${f.encrypted ? `<span class="badge">${icon('lock')}</span>` : ''}
      </div>
      <div class="file-card-thumb">
        ${kind === 'image'
          ? `<img src="/api/files/${esc(f.id)}/content?inline=1" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'file-ico f-image',textContent:'IMG'}))">`
          : fileIconHtml(f.ext, { large: true })}
      </div>
      <div class="file-card-body">
        <div class="file-card-name" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="file-card-meta">
          <span>${formatBytes(f.size)}</span><span>·</span><span>${esc(timeAgo(f.updatedAt))}</span>
        </div>
        ${statusBadge(f)}
      </div>
    </div>`;
  }).join('')}</div>`;
}

function statusBadge(f) {
  const s = f.text?.status;
  if (s === 'processing' || s === 'pending') return `<span class="badge badge-warn" title="正在解析内容">解析中</span>`;
  if (s === 'failed') return `<span class="badge badge-danger" title="${esc(f.text?.error || '解析失败')}">解析失败</span>`;
  if (s === 'empty') return `<span class="badge" title="${esc(f.text?.warning || '未提取到文本，可能是扫描件')}">无文本</span>`;
  if (s === 'ok') return `<span class="badge badge-success" title="已建立索引，可检索与问答">已索引</span>`;
  return '';
}

function renderBatchBar(ctx) {
  const host = qs('#batch-host');
  if (!host) return;
  const n = state.selected.size;
  const pageIds = state.files.map((f) => f.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => state.selected.has(id));
  const someSelected = n > 0 && !allSelected;

  if (!n) {
    host.innerHTML = state.files.length ? `<div class="flex items-center gap-3 mb-3" style="padding:0 4px">
      <span class="checkbox${allSelected ? ' is-checked' : someSelected ? ' is-indeterminate' : ''}" data-select-all></span>
      <span class="text-xs text-muted">全选 ${state.files.length} 项</span>
    </div>` : '';
    return;
  }

  host.innerHTML = `<div class="batch-bar">
    <span class="checkbox is-checked" data-select-all></span>
    <span class="bb-count">已选 ${n} 项</span>
    <span class="vr"></span>
    <button class="btn btn-sm" data-batch="pin">${icon('pin')}置顶</button>
    <button class="btn btn-sm" data-batch="star">${icon('star')}收藏</button>
    <button class="btn btn-sm" data-batch="tag">${icon('tag')}加标签</button>
    <button class="btn btn-sm" data-batch="move">${icon('move')}移动</button>
    <button class="btn btn-sm" data-batch="reindex">${icon('refresh')}重建索引</button>
    <span class="spacer"></span>
    <button class="btn btn-sm" data-batch="download">${icon('download')}导出</button>
    <button class="btn btn-sm btn-danger" data-batch="delete">${icon('trash')}删除</button>
    <button class="btn btn-sm" data-batch="clear">${icon('close')}</button>
  </div>`;
  applyIcons(host);
}

/* ================================================================== 交互：树 */

function bindTree(container, ctx) {
  const scroll = qs('#tree-scroll');

  cleanup.push(on(scroll, 'click', '[data-toggle]', (e, node) => {
    e.stopPropagation();
    const id = node.getAttribute('data-toggle');
    toggleFolder(id);
  }));

  cleanup.push(on(scroll, 'click', '[data-folder-menu]', (e, node) => {
    e.stopPropagation();
    openFolderMenu(ctx, node.getAttribute('data-folder-menu'), node);
  }));

  cleanup.push(on(scroll, 'contextmenu', '[data-folder]', (e, node) => {
    openFolderMenu(ctx, node.getAttribute('data-folder'), node, e);
  }));

  cleanup.push(on(scroll, 'click', '[data-folder]', (e, node) => {
    if (e.target.closest('[data-folder-menu]') || e.target.closest('[data-toggle]')) return;
    selectFolder(ctx, node.getAttribute('data-folder'));
  }));

  cleanup.push(on(scroll, 'click', '[data-fixed]', (e, node) => {
    const filterAction = node.getAttribute('data-filter-action');
    if (filterAction) {
      state.filter = filterAction;
      updateFilterLabel();
      loadFiles(ctx);
      renderTree(ctx);
      return;
    }
    selectFolder(ctx, node.getAttribute('data-fixed'));
  }));

  // 文件夹拖拽
  let dragFolderId = null;
  cleanup.push(on(scroll, 'dragstart', '[data-folder]', (e, node) => {
    dragFolderId = node.getAttribute('data-folder');
    e.dataTransfer.setData('text/kbpro-folder', dragFolderId);
    e.dataTransfer.effectAllowed = 'move';
  }));
  cleanup.push(on(scroll, 'dragover', '[data-folder]', (e, node) => {
    const targetId = node.getAttribute('data-folder');
    if (targetId === dragFolderId) return;
    e.preventDefault();
    node.classList.add('is-drop-target');
  }));
  cleanup.push(on(scroll, 'dragleave', '[data-folder]', (e, node) => {
    node.classList.remove('is-drop-target');
  }));
  cleanup.push(on(scroll, 'drop', '[data-folder]', async (e, node) => {
    e.preventDefault();
    node.classList.remove('is-drop-target');
    const targetId = node.getAttribute('data-folder');
    const types = [...(e.dataTransfer.types || [])];
    if (types.includes('text/kbpro-folder')) {
      const srcId = e.dataTransfer.getData('text/kbpro-folder');
      if (!srcId || srcId === targetId) return;
      try {
        await ctx.api.moveFolder(srcId, targetId);
        notify.success('文件夹已移动');
        await loadTree(ctx);
      } catch (err) {
        notify.error(err.message);
      }
    } else {
      await handleDrop(ctx, targetId, [...(e.dataTransfer?.files || [])]);
    }
  }));

  cleanup.push(on(container, 'click', '[data-tree-action]', (e, node) => {
    const act = node.getAttribute('data-tree-action');
    if (act === 'new-folder') createFolderDialog(ctx);
    else if (act === 'close') qs('#files-layout')?.classList.remove('tree-open');
  }));
}

function toggleFolder(id) {
  const node = qs(`[data-node="${CSS.escape(id)}"]`);
  const children = qs(`#tree-children-${CSS.escape(id)}`);
  const caret = qs(`[data-toggle="${CSS.escape(id)}"]`);
  if (!children) return;
  const open = state.openFolders.has(id);
  if (open) {
    state.openFolders.delete(id);
    children.classList.add('is-closing');
    setTimeout(() => {
      children.hidden = true;
      children.classList.remove('is-closing');
    }, 190);
    node?.classList.remove('is-open');
  } else {
    state.openFolders.add(id);
    children.hidden = false;
    node?.classList.add('is-open');
  }
  void caret;
}

function selectFolder(ctx, id) {
  state.folderId = id;
  state.filter = 'all';
  state.selected.clear();
  window.__kbproDropFolder = state.folderId === 'all' || state.folderId === 'root' ? null : state.folderId;
  updateFilterLabel();
  renderTree(ctx);
  loadFiles(ctx);
  qs('#files-layout')?.classList.remove('tree-open');
}

async function openFolderMenu(ctx, folderId, anchor, event) {
  const node = state.folders.flat.find((f) => f.id === folderId);
  if (!node) return;
  const items = [
    { icon: 'plus', label: '新建子文件夹', onClick: () => createFolderDialog(ctx, folderId) },
    { icon: 'edit', label: '重命名', onClick: () => renameFolderDialog(ctx, node) },
    { icon: 'move', label: '移动到…', onClick: () => moveFolderDialog(ctx, node) },
    { icon: 'tag', label: '更改颜色/图标', onClick: () => folderStyleDialog(ctx, node) },
    { sep: true },
    { icon: 'trash', label: '删除文件夹', danger: true, onClick: () => deleteFolderDialog(ctx, node) }
  ];
  if (event) contextMenu(event, items);
  else dropdown(anchor, items, { align: 'end' });
}

/* ================================================================== 交互：工具条 */

function bindToolbar(container, ctx) {
  const searchInput = qs('#file-search');
  const doSearch = debounce(() => {
    state.query = searchInput.value.trim();
    loadFiles(ctx);
  }, 300);
  searchInput.addEventListener('input', doSearch);
  cleanup.push(() => searchInput.removeEventListener('input', doSearch));

  const offPane = on(container, 'click', '[data-pane-action]', (e, node) => {
    const act = node.getAttribute('data-pane-action');
    if (act === 'upload') requestUpload(ctx);
    else if (act === 'new-folder') createFolderDialog(ctx);
    else if (act === 'sort') openSortMenu(ctx, node);
    else if (act === 'filter') openFilterMenu(ctx, node);
    else if (act === 'clear-search') { state.query = ''; qs('#file-search').value = ''; loadFiles(ctx); }
    else if (act === 'open-tree') qs('#files-layout')?.classList.add('tree-open');
  });
  cleanup.push(offPane);

  const offView = on(container, 'click', '#view-mode button', (e, node) => {
    const view = node.getAttribute('data-view');
    setState({ ui: { filesView: view } });
    qsa('#view-mode button').forEach((b) => b.classList.toggle('is-active', b === node));
    renderFiles(ctx);
  });
  cleanup.push(offView);
  qsa('#view-mode button').forEach((b) => b.classList.toggle('is-active', b.getAttribute('data-view') === (getState().ui.filesView || 'list')));
  updateSortLabel();
  updateFilterLabel();

  // 全局事件：新建文件夹 / 文件变化
  // 上传事件由应用壳统一处理（见 app.js requestGlobalUpload），此处不再重复监听。
  const onNewFolder = () => createFolderDialog(ctx);
  const onFilesChanged = () => loadFiles(ctx);
  const onRealtime = (e) => {
    const p = e.detail;
    if (!p) return;
    if (['file.indexed', 'file.failed'].includes(p.type)) loadFiles(ctx);
  };
  document.addEventListener('kbpro:new-folder', onNewFolder);
  document.addEventListener('kbpro:files-changed', onFilesChanged);
  document.addEventListener('kbpro:realtime', onRealtime);
  cleanup.push(() => document.removeEventListener('kbpro:new-folder', onNewFolder));
  cleanup.push(() => document.removeEventListener('kbpro:files-changed', onFilesChanged));
  cleanup.push(() => document.removeEventListener('kbpro:realtime', onRealtime));

  // 记录当前拖拽落点文件夹，供全局拖拽上传使用
  const setDropFolder = () => { window.__kbproDropFolder = state.folderId === 'all' || state.folderId === 'root' ? null : state.folderId; };
  setDropFolder();
  cleanup.push(() => { window.__kbproDropFolder = null; });
}

function updateSortLabel() {
  const map = { updated: '最近更新', created: '创建时间', name: '名称', size: '大小', views: '查看次数' };
  const n = qs('#sort-label');
  if (n) n.textContent = map[state.sort] || '最近更新';
}
function updateFilterLabel() {
  const map = { all: '全部', starred: '收藏', pinned: '置顶', encrypted: '加密' };
  const n = qs('#filter-label');
  if (n) n.textContent = map[state.filter] || '全部';
}

function openSortMenu(ctx, anchor) {
  const opts = [
    ['updated', '最近更新'], ['created', '创建时间'], ['name', '名称'], ['size', '大小'], ['views', '查看次数']
  ];
  dropdown(anchor, [
    { label: '排序方式', header: true },
    ...opts.map(([k, label]) => ({
      label, active: state.sort === k,
      hint: state.sort === k ? (state.order === 'desc' ? '↓' : '↑') : '',
      onClick: () => {
        if (state.sort === k) state.order = state.order === 'desc' ? 'asc' : 'desc';
        else { state.sort = k; state.order = k === 'name' ? 'asc' : 'desc'; }
        setState({ ui: { filesSort: k } });
        updateSortLabel();
        loadFiles(ctx);
      }
    }))
  ], { align: 'end', width: 190 });
}

function openFilterMenu(ctx, anchor) {
  const opts = [['all', '全部文件'], ['starred', '仅收藏'], ['pinned', '仅置顶'], ['encrypted', '仅加密']];
  dropdown(anchor, [
    { label: '筛选', header: true },
    ...opts.map(([k, label]) => ({
      label, active: state.filter === k,
      onClick: () => { state.filter = k; updateFilterLabel(); renderTree(ctx); loadFiles(ctx); }
    }))
  ], { align: 'end', width: 178 });
}

/* ================================================================== 交互：列表 */

function bindList(container, ctx) {
  const host = qs('#files-scroll');

  cleanup.push(on(host, 'click', '[data-check]', (e, node) => {
    e.stopPropagation();
    toggleSelect(node.getAttribute('data-check'));
    renderFiles(ctx);
  }));

  cleanup.push(on(host, 'click', '[data-select-all]', (e, node) => {
    e.stopPropagation();
    const ids = state.files.map((f) => f.id);
    const allSelected = ids.every((id) => state.selected.has(id));
    if (allSelected || (state.selected.size && !allSelected)) state.selected.clear();
    else ids.forEach((id) => state.selected.add(id));
    renderFiles(ctx);
  }));

  cleanup.push(on(host, 'click', '[data-file-act="menu"]', (e, node) => {
    e.stopPropagation();
    openFileMenu(ctx, node.getAttribute('data-id'), node);
  }));

  cleanup.push(on(host, 'contextmenu', '[data-file]', (e, node) => {
    openFileMenu(ctx, node.getAttribute('data-file'), node, e);
  }));

  cleanup.push(on(host, 'click', '[data-file]', (e, node) => {
    if (e.target.closest('[data-check]') || e.target.closest('[data-file-act]')) return;
    if (state.selected.size > 0 && (e.metaKey || e.ctrlKey)) {
      toggleSelect(node.getAttribute('data-file'));
      renderFiles(ctx);
      return;
    }
    openFile(ctx, node.getAttribute('data-file'));
  }));

  // 文件拖到文件夹
  cleanup.push(on(host, 'dragstart', '[data-file]', (e, node) => {
    const id = node.getAttribute('data-file');
    const ids = state.selected.has(id) ? [...state.selected] : [id];
    window.__kbproDragFiles = ids;
    e.dataTransfer.setData('text/kbpro-files', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
  }));
  cleanup.push(on(host, 'dragend', '[data-file]', () => { window.__kbproDragFiles = null; }));

  cleanup.push(on(container, 'click', '[data-batch]', (e, node) => {
    runBatch(ctx, node.getAttribute('data-batch'));
  }));

  cleanup.push(on(host, 'click', '[data-retry]', () => loadFiles(ctx)));
}

function toggleSelect(id) {
  if (state.selected.has(id)) state.selected.delete(id);
  else state.selected.add(id);
}

async function handleDrop(ctx, targetFolderId, incomingFiles = null) {
  // 内部：拖动既有文件/多选到文件夹 → 移动
  const ids = window.__kbproDragFiles;
  if (ids && ids.length) {
    window.__kbproDragFiles = null;
    if (!canWrite()) { notify.warn('当前知识库没有操作权限'); return; }
    try {
      const r = await ctx.api.batchFiles('move', ids, { targetFolderId: targetFolderId || null });
      if (r?.failed) notify.warn(`已移动 ${r.ok} 项，${r.failed} 项失败`);
      else notify.success('已移动到目标文件夹');
    } catch (err) { notify.error(err.message); return; }
    await loadFiles(ctx);
    await loadTree(ctx);
    return;
  }
  // 外部：从系统拖入文件 → 上传到目标文件夹
  const files = incomingFiles && incomingFiles.length ? incomingFiles : null;
  if (!files) return;
  if (!canWrite()) { notify.warn('当前知识库没有上传权限'); return; }
  await uploadFiles(files, { folderId: targetFolderId });
  await loadFiles(ctx);
  await loadTree(ctx);
}

/* ================================================================== 上传 */

async function requestUpload(ctx) {
  if (!canWrite()) { notify.warn('当前知识库没有写入权限'); return; }
  const files = await pickFiles({ multiple: true });
  if (!files?.length) return;
  const folderId = state.folderId === 'all' || state.folderId === 'root' ? null : state.folderId;
  await uploadFiles(files, { folderId });
  await loadFiles(ctx);
}

/* ================================================================== 文件夹对话框 */

async function createFolderDialog(ctx, parentId = null) {
  if (!canWrite()) { notify.warn('没有创建文件夹的权限'); return; }
  const target = parentId ?? (state.folderId === 'all' || state.folderId === 'root' ? null : state.folderId);
  const parentName = target ? state.folders.flat.find((f) => f.id === target)?.name : null;

  const m = modal({
    title: '新建文件夹',
    sub: parentName ? `将创建于「${parentName}」下` : '将创建在根目录',
    size: 'sm',
    body: `<div class="field" style="margin-bottom:0">
      <label>文件夹名称</label>
      <input class="input" data-field="name" placeholder="例如：产品需求文档" maxlength="80">
    </div>`,
    actions: [
      { label: '取消' },
      {
        label: '创建', primary: true, keepOpen: true,
        onClick: async (close, btn) => {
          const name = qs('[data-field="name"]', m.body).value.trim();
          if (!name) { notify.warn('请输入名称'); return; }
          btn.disabled = true;
          try {
            await ctx.api.createFolder({ workspaceId: state.workspaceId, parentId: target, name });
            close();
            notify.success(`已创建「${name}」`);
            await loadTree(ctx);
          } catch (err) {
            notify.error(err.message);
          } finally { btn.disabled = false; }
        }
      }
    ]
  });
}

async function renameFolderDialog(ctx, node) {
  const name = await promptDialog({ title: '重命名文件夹', label: '名称', value: node.name });
  if (!name || name === node.name) return;
  try {
    await ctx.api.updateFolder(node.id, { name });
    notify.success('已重命名');
    await loadTree(ctx);
  } catch (err) { notify.error(err.message); }
}

async function moveFolderDialog(ctx, node) {
  const options = flattenForSelect(state.folders.tree, node.id);
  const m = modal({
    title: `移动「${node.name}」`,
    size: 'sm',
    body: `<div class="field" style="margin-bottom:0">
      <label>目标位置</label>
      <select class="select" data-field="target">
        <option value="">根目录</option>
        ${options.map((o) => `<option value="${esc(o.id)}">${esc('　'.repeat(o.depth) + o.name)}</option>`).join('')}
      </select>
      <div class="field-hint">不能移动到自身或其子目录中。</div>
    </div>`,
    actions: [
      { label: '取消' },
      {
        label: '移动', primary: true, keepOpen: true,
        onClick: async (close, btn) => {
          btn.disabled = true;
          try {
            await ctx.api.moveFolder(node.id, qs('[data-field="target"]', m.body).value || null);
            close();
            notify.success('已移动');
            await loadTree(ctx);
          } catch (err) { notify.error(err.message); }
          finally { btn.disabled = false; }
        }
      }
    ]
  });
}

function flattenForSelect(tree, excludeId, depth = 0, out = []) {
  for (const node of tree) {
    if (node.id === excludeId || containsId(node, excludeId)) continue;
    out.push({ id: node.id, name: node.name, depth });
    flattenForSelect(node.children || [], excludeId, depth + 1, out);
  }
  return out;
}
function containsId(node, id) {
  if (!node.children?.length) return false;
  for (const c of node.children) {
    if (c.id === id || containsId(c, id)) return true;
  }
  return false;
}

async function folderStyleDialog(ctx, node) {
  const icons = ['folder', 'folderOpen', 'book', 'bulb', 'mic', 'file', 'note', 'layers', 'target', 'chart', 'users', 'archive'];
  const colors = ['', '#1F2937', '#0E9F6E', '#2563EB', '#7C3AED', '#C2410C', '#BE185D', '#0369A1'];
  let pickIcon = node.icon || 'folder';
  let pickColor = node.color || '';

  const m = modal({
    title: '文件夹外观',
    size: 'sm',
    body: `<div class="field"><label>图标</label>
        <div class="flex flex-wrap gap-2" data-icon-grid>
          ${icons.map((i) => `<button class="btn btn-sm ${i === pickIcon ? 'btn-primary' : 'btn-default'}" data-pick-icon="${i}">${icon(i)}</button>`).join('')}
        </div>
      </div>
      <div class="field" style="margin-bottom:0"><label>颜色</label>
        <div class="flex flex-wrap gap-2" data-color-grid>
          ${colors.map((c) => `<button class="btn btn-sm ${c === pickColor ? 'btn-primary' : 'btn-default'}" data-pick-color="${esc(c)}" style="${c ? `background:${c};border-color:${c};color:#fff` : ''}">${c ? '' : '默认'}</button>`).join('')}
        </div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存', primary: true, keepOpen: true,
        onClick: async (close, btn) => {
          btn.disabled = true;
          try {
            await ctx.api.updateFolder(node.id, { icon: pickIcon, color: pickColor });
            close();
            notify.success('已更新');
            await loadTree(ctx);
          } catch (err) { notify.error(err.message); }
          finally { btn.disabled = false; }
        }
      }
    ]
  });

  on(m.body, 'click', '[data-pick-icon]', (e, b) => {
    pickIcon = b.getAttribute('data-pick-icon');
    qsa('[data-pick-icon]', m.body).forEach((x) => x.classList.toggle('btn-primary', x === b));
    qsa('[data-pick-icon]', m.body).forEach((x) => x.classList.toggle('btn-default', x !== b));
  });
  on(m.body, 'click', '[data-pick-color]', (e, b) => {
    pickColor = b.getAttribute('data-pick-color');
    qsa('[data-pick-color]', m.body).forEach((x) => x.classList.remove('btn-primary'));
    b.classList.add('btn-primary');
  });
}

async function deleteFolderDialog(ctx, node) {
  let mode = 'move-to-root';
  const m = modal({
    title: `删除「${node.name}」`,
    body: `<p class="text-2 mb-4">该文件夹${node.children?.length ? `包含 ${node.children.length} 个子文件夹，` : ''}共 ${node.totalFileCount || 0} 个文件、${node.totalNoteCount || 0} 篇笔记。请选择处理方式：</p>
      <div class="flex-col gap-2">
        <label class="perm-row" style="cursor:pointer"><input type="radio" name="delmode" value="move-to-root" checked><span>保留内容，移动到根目录</span><span class="spacer"></span><span class="text-xs text-muted">推荐</span></label>
        <label class="perm-row" style="cursor:pointer"><input type="radio" name="delmode" value="cascade"><span>连同内容一起移入回收站</span></label>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '删除', danger: true, keepOpen: true,
        onClick: async (close, btn) => {
          mode = qs('input[name="delmode"]:checked', m.body)?.value || 'move-to-root';
          btn.disabled = true;
          try {
            await ctx.api.deleteFolder(node.id, mode);
            close();
            notify.success('文件夹已删除');
            if (state.folderId === node.id) state.folderId = 'all';
            await loadTree(ctx);
            await loadFiles(ctx);
          } catch (err) { notify.error(err.message); }
          finally { btn.disabled = false; }
        }
      }
    ]
  });
  qs('.modal-foot .btn-danger', m.el)?.classList.add('btn-danger-solid');
}

/* ================================================================== 文件操作菜单 */

function openFileMenu(ctx, fileId, anchor, event) {
  const f = state.files.find((x) => x.id === fileId);
  if (!f) return;
  const writable = canWrite();

  const items = [
    { icon: 'eye', label: '打开预览', onClick: () => openFile(ctx, fileId) },
    { icon: 'download', label: '下载原文件', onClick: () => { downloadUrl(ctx.api.fileContentUrl(fileId, { download: true }), f.name); toast('开始下载', { type: 'info', duration: 1400 }); } },
    { sep: true },
    { icon: f.starred ? 'star' : 'starFill', label: f.starred ? '取消收藏' : '收藏', disabled: !writable, onClick: () => patchFile(ctx, fileId, { starred: !f.starred }) },
    { icon: 'pin', label: f.pinned ? '取消置顶' : '置顶', disabled: !writable, onClick: () => patchFile(ctx, fileId, { pinned: !f.pinned }) },
    { icon: 'edit', label: '重命名', disabled: !writable, onClick: () => renameFileDialog(ctx, f) },
    { icon: 'move', label: '移动到…', disabled: !writable, onClick: () => moveFileDialog(ctx, [fileId]) },
    { icon: 'tag', label: '编辑标签', disabled: !writable, onClick: () => tagFileDialog(ctx, f) },
    { icon: f.isPrivate ? 'unlock' : 'lock', label: f.isPrivate ? '设为继承权限' : '设为私密', disabled: !writable, onClick: () => patchFile(ctx, fileId, { private: !f.isPrivate }) },
    { sep: true },
    { icon: 'sparkle', label: 'AI 智能解析', onClick: () => openFile(ctx, fileId, 'ai') },
    { icon: 'refresh', label: '重新解析并索引', disabled: !writable, onClick: () => reindexFile(ctx, fileId) },
    { icon: 'share', label: '共享与权限', onClick: () => openFile(ctx, fileId, 'share') },
    { icon: 'external', label: '导出为 Markdown', onClick: () => downloadUrl(ctx.api.fileExportUrl(fileId, 'md')) },
    { icon: 'external', label: '导出为 HTML', onClick: () => downloadUrl(ctx.api.fileExportUrl(fileId, 'html')) },
    { sep: true },
    { icon: 'trash', label: '删除', danger: true, disabled: !writable, onClick: () => deleteFile(ctx, f) }
  ];
  if (event) contextMenu(event, items);
  else dropdown(anchor, items, { align: 'end', width: 226 });
}

async function patchFile(ctx, fileId, payload) {
  try {
    await ctx.api.updateFile(fileId, payload);
    await loadFiles(ctx);
  } catch (err) { notify.error(err.message); }
}

async function renameFileDialog(ctx, f) {
  const name = await promptDialog({ title: '重命名文件', label: '文件名（含扩展名）', value: f.name });
  if (!name || name === f.name) return;
  try {
    await ctx.api.updateFile(f.id, { name });
    notify.success('已重命名');
    await loadFiles(ctx);
  } catch (err) { notify.error(err.message); }
}

async function moveFileDialog(ctx, ids) {
  const options = flattenForSelect(state.folders.tree, null);
  const m = modal({
    title: `移动 ${ids.length} 个文件`,
    size: 'sm',
    body: `<div class="field" style="margin-bottom:0">
      <label>目标文件夹</label>
      <select class="select" data-field="target">
        <option value="">未分类（根目录）</option>
        ${options.map((o) => `<option value="${esc(o.id)}">${esc('　'.repeat(o.depth) + o.name)}</option>`).join('')}
      </select>
    </div>`,
    actions: [
      { label: '取消' },
      {
        label: '移动', primary: true, keepOpen: true,
        onClick: async (close, btn) => {
          btn.disabled = true;
          try {
            const target = qs('[data-field="target"]', m.body).value || null;
            const res = await ctx.api.batchFiles('move', ids, { targetFolderId: target });
            close();
            if (res.failed) notify.warn(`已移动 ${res.ok} 个，${res.failed} 个失败`);
            else notify.success(`已移动 ${res.ok} 个文件`);
            await loadFiles(ctx);
            await loadTree(ctx);
          } catch (err) { notify.error(err.message); }
          finally { btn.disabled = false; }
        }
      }
    ]
  });
}

async function tagFileDialog(ctx, f) {
  const { tagInput } = await import('../ui.js');
  let existing = [];
  try { existing = (await ctx.api.tags(state.workspaceId)).tags || []; } catch { /* */ }

  const input = tagInput({ value: f.tags || [], suggestions: existing });
  const m = modal({
    title: '编辑标签',
    sub: '标签可用于全局检索与知识归类',
    size: 'sm',
    body: `<div class="field" style="margin-bottom:0"><label>标签</label></div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存', primary: true, keepOpen: true,
        onClick: async (close, btn) => {
          btn.disabled = true;
          try {
            await ctx.api.updateFile(f.id, { tags: input.value });
            close();
            notify.success('标签已更新');
            await loadFiles(ctx);
          } catch (err) { notify.error(err.message); }
          finally { btn.disabled = false; }
        }
      }
    ]
  });
  const field = qs('.field', m.body);
  field.innerHTML = `<label>标签</label>`;
  field.appendChild(input.el);
  if (input.el._suggestHost) field.appendChild(input.el._suggestHost);
  input.focus();
}

async function reindexFile(ctx, fileId) {
  try {
    const r = await ctx.api.reindexFile(fileId, true);
    if (r.result?.ok) notify.success(`重新解析完成 · ${r.result.chunks || 0} 个知识块`);
    else notify.warn(`解析完成但未提取到文本：${r.result?.warning || '可能为扫描件或二进制文件'}`);
    await loadFiles(ctx);
  } catch (err) { notify.error(err.message); }
}

async function deleteFile(ctx, f) {
  const ok = await confirmDialog({
    title: '删除文件',
    message: `确定要删除《${esc(f.name)}》吗？<br><span class="text-muted">文件将移入回收站，可随时恢复。</span>`,
    confirmText: '移入回收站',
    danger: true
  });
  if (!ok) return;
  try {
    await ctx.api.deleteFile(f.id);
    notify.success('已移入回收站', {
      action: '撤销',
      onAction: async () => {
        try { await ctx.api.restoreFile(f.id); notify.success('已恢复'); await loadFiles(ctx); }
        catch (err) { notify.error(err.message); }
      }
    });
    await loadFiles(ctx);
  } catch (err) { notify.error(err.message); }
}

/* ================================================================== 批量操作 */

async function runBatch(ctx, action) {
  const ids = [...state.selected];
  if (!ids.length) return;

  if (action === 'clear') { state.selected.clear(); renderFiles(ctx); return; }

  if (action === 'move') { await moveFileDialog(ctx, ids); state.selected.clear(); return; }

  if (action === 'tag') {
    const { tagInput } = await import('../ui.js');
    let existing = [];
    try { existing = (await ctx.api.tags(state.workspaceId)).tags || []; } catch { /* */ }
    const input = tagInput({ value: [], suggestions: existing });
    const m = modal({
      title: `为 ${ids.length} 个文件添加标签`,
      size: 'sm',
      body: '<div class="field" style="margin-bottom:0"><label>标签</label></div>',
      actions: [
        { label: '取消' },
        {
          label: '添加', primary: true, keepOpen: true,
          onClick: async (close, btn) => {
            btn.disabled = true;
            try {
              const res = await ctx.api.batchFiles('tag', ids, { tags: input.value });
              close();
              notify.success(`已为 ${res.ok} 个文件添加标签`);
              state.selected.clear();
              await loadFiles(ctx);
            } catch (err) { notify.error(err.message); }
            finally { btn.disabled = false; }
          }
        }
      ]
    });
    const field = qs('.field', m.body);
    field.appendChild(input.el);
    if (input.el._suggestHost) field.appendChild(input.el._suggestHost);
    return;
  }

  if (action === 'download') {
    const files = state.files.filter((f) => state.selected.has(f.id));
    if (files.length > 6) {
      notify.info(`将依次下载 ${files.length} 个文件，浏览器可能提示允许多文件下载`);
    }
    for (const f of files) {
      downloadUrl(ctx.api.fileContentUrl(f.id, { download: true }), f.name);
      await new Promise((r) => setTimeout(r, 420));
    }
    return;
  }

  if (action === 'delete') {
    const ok = await confirmDialog({
      title: '批量删除',
      message: `确定要删除选中的 ${ids.length} 个文件吗？<br><span class="text-muted">文件将移入回收站。</span>`,
      confirmText: '移入回收站',
      danger: true
    });
    if (!ok) return;
  }

  try {
    const res = await ctx.api.batchFiles(action, ids);
    if (res.failed) notify.warn(`${res.ok} 个成功，${res.failed} 个失败`);
    else notify.success(`已处理 ${res.ok} 个文件`);
    if (action !== 'reindex') state.selected.clear();
    await loadFiles(ctx);
  } catch (err) { notify.error(err.message); }
}

/* ================================================================== 文件详情抽屉 */

async function openFile(ctx, fileId, initialTab = 'content') {
  let detail;
  try {
    detail = await ctx.api.file(fileId);
  } catch (err) {
    notify.error(`无法打开文件：${err.message}`);
    return;
  }
  const f = detail.file;

  const d = drawer({
    wide: true,
    title: `<div class="preview-head">
      ${fileIconHtml(f.ext)}
      <div style="min-width:0">
        <div class="preview-title">${esc(f.name)}</div>
        <div class="preview-sub">${formatBytes(f.size)} · ${esc(formatDateTime(f.updatedAt))} · 版本 v${f.version}${f.encrypted ? ' · 已加密' : ''}</div>
      </div>
    </div>`,
    body: `<div class="tabs" style="padding:0 20px;margin-bottom:0">
        <button class="tab is-active" data-tab="content">内容</button>
        <button class="tab" data-tab="ai">AI 智能解析</button>
        <button class="tab" data-tab="related">相关知识</button>
        <button class="tab" data-tab="comments">评论</button>
        <button class="tab" data-tab="share">共享与权限</button>
      </div>
      <div id="drawer-panel" style="min-height:240px">${skeleton(4)}</div>`,
    footer: `<button class="btn btn-sm btn-default" data-dl>${icon('download')}下载</button>
      <button class="btn btn-sm btn-default" data-export>${icon('external')}导出</button>
      <span class="spacer" style="flex:1"></span>
      <button class="btn btn-sm btn-default" data-star>${icon(f.starred ? 'starFill' : 'star')}${f.starred ? '取消收藏' : '收藏'}</button>
      <button class="btn btn-sm btn-default" data-pin>${icon('pin')}${f.pinned ? '取消置顶' : '置顶'}</button>
      <button class="btn btn-sm btn-primary" data-ask>${icon('sparkle')}就此文档提问</button>`
  });

  const panel = qs('#drawer-panel', d.el);
  const tabs = qsa('.tab', d.el);

  const switchTab = (name) => {
    tabs.forEach((t) => t.classList.toggle('is-active', t.getAttribute('data-tab') === name));
    renderTab(ctx, panel, f, name);
  };
  tabs.forEach((t) => t.addEventListener('click', () => switchTab(t.getAttribute('data-tab'))));

  qs('[data-dl]', d.foot).addEventListener('click', () => {
    downloadUrl(ctx.api.fileContentUrl(f.id, { download: true }), f.name);
  });
  qs('[data-export]', d.foot).addEventListener('click', (e) => {
    dropdown(e.currentTarget, [
      { icon: 'file', label: '导出为 Markdown', onClick: () => downloadUrl(ctx.api.fileExportUrl(f.id, 'md')) },
      { icon: 'file', label: '导出为纯文本', onClick: () => downloadUrl(ctx.api.fileExportUrl(f.id, 'txt')) },
      { icon: 'external', label: '导出为 HTML', onClick: () => downloadUrl(ctx.api.fileExportUrl(f.id, 'html')) }
    ]);
  });
  qs('[data-star]', d.foot).addEventListener('click', async () => {
    await ctx.api.updateFile(f.id, { starred: !f.starred });
    notify.success(f.starred ? '已取消收藏' : '已收藏');
    d.close();
    await loadFiles(ctx);
  });
  qs('[data-pin]', d.foot).addEventListener('click', async () => {
    await ctx.api.updateFile(f.id, { pinned: !f.pinned });
    notify.success(f.pinned ? '已取消置顶' : '已置顶');
    d.close();
    await loadFiles(ctx);
  });
  qs('[data-ask]', d.foot).addEventListener('click', () => {
    d.close();
    ctx.navigate('chat', [], { fileId: f.id });
  });

  switchTab(initialTab);
}

async function renderTab(ctx, panel, f, tab) {
  panel.innerHTML = skeleton(4);
  try {
    if (tab === 'content') await renderContentTab(ctx, panel, f);
    else if (tab === 'ai') await renderAiTab(ctx, panel, f);
    else if (tab === 'related') await renderRelatedTab(ctx, panel, f);
    else if (tab === 'comments') await renderCommentsTab(ctx, panel, f);
    else if (tab === 'share') await renderShareTab(ctx, panel, f);
  } catch (err) {
    panel.innerHTML = `<div style="padding:24px">${emptyState({ iconName: 'alert', title: '加载失败', desc: esc(err.message) })}</div>`;
  }
}

async function renderContentTab(ctx, panel, f) {
  const pv = await ctx.api.filePreview(f.id);
  const kind = pv.kind;

  if (pv.status !== 'ok' && kind !== 'image' && kind !== 'pdf') {
    panel.innerHTML = `<div style="padding:24px">${emptyState({
      iconName: pv.status === 'failed' ? 'alert' : 'file',
      title: pv.status === 'failed' ? '内容解析失败' : (pv.status === 'processing' ? '正在解析…' : '暂无文本内容'),
      desc: esc(pv.warning || (pv.status === 'processing' ? '解析完成后即可在线预览与检索。' : '该文件可能为扫描件或二进制格式，可下载后查看。')),
      actions: canWrite() ? '<button class="btn btn-default" data-reindex>重新解析</button>' : ''
    })}</div>`;
    on(panel, 'click', '[data-reindex]', async () => { await reindexFile(ctx, f.id); renderTab(ctx, panel, f, 'content'); });
    return;
  }

  if (kind === 'pdf') {
    panel.style.padding = '0';
    panel.innerHTML = `<iframe class="preview-frame" src="${esc(pv.streamUrl)}" title="${esc(f.name)}" style="height:calc(100vh - 190px)"></iframe>`;
    return;
  }
  if (kind === 'image') {
    const url = ctx.api.fileContentUrl(f.id, { inline: true });
    panel.innerHTML = `<div class="preview-body text-center"><img src="${esc(url)}" alt="${esc(f.name)}" style="max-width:100%;border-radius:var(--r-md);border:1px solid var(--c-border)"></div>`;
    return;
  }
  if (kind === 'audio' || kind === 'video') {
    const url = ctx.api.fileContentUrl(f.id, { inline: true });
    panel.innerHTML = `<div class="preview-body text-center">${kind === 'audio'
      ? `<audio controls src="${esc(url)}" style="width:100%"></audio>`
      : `<video controls src="${esc(url)}" style="width:100%;border-radius:var(--r-md)"></video>`}</div>`;
    return;
  }

  panel.innerHTML = `<div class="preview-body">
    ${pv.html ? `<div class="preview-doc">${pv.html}</div>` : `<pre class="text-view" style="padding:20px">${esc((pv.text || '').slice(0, 400000))}</pre>`}
  </div>`;
}

async function renderAiTab(ctx, panel, f) {
  const [analysis, status] = await Promise.all([
    ctx.api.fileAnalysis(f.id).catch(() => ({ latest: {} })),
    ctx.api.aiStatus().catch(() => null)
  ]);
  const latest = analysis.latest || {};
  const provider = status?.effective?.provider || 'local';
  const isLocal = provider === 'local';

  const section = (key, title, ico) => {
    const row = latest[key];
    return `<div class="card card-pad mb-4">
      <div class="section-head">
        <div class="section-title">${icon(ico)} ${title}</div>
        <div class="section-actions">
          ${row ? `<button class="btn btn-sm btn-ghost" data-copy="${key}">${icon('copy')}复制</button>` : ''}
          <button class="btn btn-sm btn-default" data-gen="${key}">${row ? '重新生成' : '生成'}</button>
        </div>
      </div>
      <div class="msg-content" id="ai-out-${key}">${row
        ? renderChatMarkdown(row.content)
        : '<div class="text-sm text-muted">尚未生成。</div>'}</div>
      ${row ? `<div class="text-xs text-muted mt-3">由 ${esc(row.provider || 'local')} / ${esc(row.model || '')} 生成 · ${esc(timeAgo(row.createdAt))}</div>` : ''}
    </div>`;
  };

  panel.innerHTML = `<div style="padding:20px">
    ${isLocal ? `<div class="card card-pad mb-4" style="background:var(--c-info-bg);border-color:transparent">
      <div class="flex items-center gap-2 text-sm"><span>${icon('info')}</span>
      <span>当前使用<strong>内置本地抽取式引擎</strong>，摘要与要点由原文句子抽取并组织，离线可用但不会改写润色。接入大模型可获得生成式摘要与更深度的提炼。</span></div>
    </div>` : ''}
    <div class="flex gap-2 mb-4">
      <button class="btn btn-sm btn-default" data-gen-all>${icon('wand')}一键生成全部</button>
      <button class="btn btn-sm btn-default" data-provider>${icon('settings')}查看 AI 引擎</button>
    </div>
    ${section('summary', '内容摘要', 'file')}
    ${section('outline', '结构化大纲', 'list')}
    ${section('keywords', '关键词与术语', 'tag')}
  </div>`;

  const generate = async (kind, button) => {
    const original = button?.innerHTML;
    if (button) { button.disabled = true; button.innerHTML = '生成中…'; }
    try {
      const res = await ctx.api.analyze({ fileId: f.id, kind });
      const content = res.result.generated?.[kind] || res.result.local?.[kind]?.content || '';
      const host = qs(`#ai-out-${kind}`, panel);
      if (host) host.innerHTML = renderChatMarkdown(content);
      notify.success('已生成');
    } catch (err) {
      notify.error(err.message);
    } finally {
      if (button) { button.disabled = false; button.innerHTML = original; }
    }
  };

  on(panel, 'click', '[data-gen]', (e, node) => generate(node.getAttribute('data-gen'), node));
  on(panel, 'click', '[data-gen-all]', async (e, node) => {
    node.disabled = true;
    node.innerHTML = '生成中…';
    for (const k of ['summary', 'outline', 'keywords']) {
      try { await ctx.api.analyze({ fileId: f.id, kind: k }); } catch { /* 继续 */ }
    }
    node.disabled = false;
    node.innerHTML = `${icon('wand')}一键生成全部`;
    await renderTab(ctx, panel, f, 'ai');
    notify.success('全部生成完成');
  });
  on(panel, 'click', '[data-copy]', (e, node) => {
    const key = node.getAttribute('data-copy');
    copyText(stripHtml(latest[key]?.content || ''), '已复制到剪贴板');
  });
  on(panel, 'click', '[data-provider]', () => { ctx.navigate('profile'); });
}

async function renderRelatedTab(ctx, panel, f) {
  const [related, graphHint] = await Promise.all([
    ctx.api.relatedFiles(f.id, 10).catch(() => ({ related: [] })),
    Promise.resolve('')
  ]);
  const list = related.related || [];
  panel.innerHTML = `<div style="padding:20px">
    <div class="text-sm text-muted mb-4">基于文档内容向量的语义关联，可帮助你发现同一主题下的其它资料。</div>
    ${list.length ? list.map((r) => `<div class="list-row" data-related="${esc(r.fileId)}">
        ${fileIconHtml(r.ext)}
        <div class="list-main">
          <div class="list-title">${esc(r.name)}</div>
          <div class="list-sub">相似度 ${(r.score * 100).toFixed(1)}%</div>
        </div>
        <span class="badge">${(r.score * 100).toFixed(0)}%</span>
      </div>`).join('') : emptyState({ iconName: 'layers', title: '暂无关联文档', desc: '当知识库中包含更多同主题文档时，这里会自动显示语义关联。' })}
    ${graphHint}
  </div>`;
  on(panel, 'click', '[data-related]', (e, node) => {
    const id = node.getAttribute('data-related');
    openFile(ctx, id);
  });
}

async function renderCommentsTab(ctx, panel, f) {
  const data = await ctx.api.comments('file', f.id).catch(() => ({ comments: [] }));
  panel.innerHTML = `<div style="padding:20px">
    <div class="flex gap-2 mb-4">
      <input class="input" id="cmt-input" placeholder="写下你的评论…">
      <button class="btn btn-primary" id="cmt-send">发送</button>
    </div>
    <div id="cmt-list">
      ${(data.comments || []).length ? data.comments.map((c) => `<div class="list-row" style="align-items:flex-start;cursor:default">
        ${avatarHtml({ name: c.userName, avatar: c.userAvatar }, 'sm')}
        <div class="list-main">
          <div class="flex items-center gap-2"><span class="text-sm font-medium">${esc(c.userName)}</span><span class="text-xs text-muted">${esc(timeAgo(c.createdAt))}</span></div>
          <div class="text-sm mt-1" style="line-height:1.7">${esc(c.body)}</div>
        </div>
        <button class="icon-btn sm" data-del-cmt="${esc(c.id)}" title="删除">${icon('trash')}</button>
      </div>`).join('') : '<div class="text-sm text-muted">还没有评论，成为第一个留言的人。</div>'}
    </div>
  </div>`;

  const send = async () => {
    const input = qs('#cmt-input', panel);
    const body = input.value.trim();
    if (!body) return;
    try {
      await ctx.api.addComment({ resourceType: 'file', resourceId: f.id, body });
      notify.success('评论已发布');
      await renderCommentsTab(ctx, panel, f);
    } catch (err) { notify.error(err.message); }
  };
  qs('#cmt-send', panel).addEventListener('click', send);
  qs('#cmt-input', panel).addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
  on(panel, 'click', '[data-del-cmt]', async (e, node) => {
    try {
      await ctx.api.deleteComment(node.getAttribute('data-del-cmt'));
      await renderCommentsTab(ctx, panel, f);
    } catch (err) { notify.error(err.message); }
  });
}

async function renderShareTab(ctx, panel, f) {
  const data = await ctx.api.shares('file', f.id).catch(() => ({ shares: [] }));
  const shares = data.shares || [];

  panel.innerHTML = `<div style="padding:20px">
    <div class="card card-pad mb-4">
      <div class="setting-title mb-2">访问级别</div>
      <div class="text-sm text-muted mb-4">当前：${f.isPrivate ? '<strong>私密</strong>（仅创建者与显式授权者可见）' : '<strong>继承知识库权限</strong>'}</div>
      <button class="btn btn-sm btn-default" id="toggle-private">${f.isPrivate ? '改为继承知识库权限' : '设为私密文件'}</button>
    </div>

    <div class="card card-pad mb-4">
      <div class="section-title mb-3">共享给</div>
      <div class="flex gap-2 mb-3" style="flex-wrap:wrap">
        <input class="input input-sm" id="share-email" placeholder="输入对方邮箱" style="flex:1;min-width:180px">
        <select class="select input-sm" id="share-perm" style="width:110px">
          <option value="view">只读</option>
          <option value="comment">可评论</option>
          <option value="edit">可编辑</option>
          <option value="manage">可管理</option>
        </select>
        <button class="btn btn-sm btn-primary" id="share-add">共享</button>
      </div>
      <button class="btn btn-sm btn-default" id="share-link">${icon('link')}生成分享链接</button>
    </div>

    <div class="card" style="overflow:hidden">
      <div class="card-pad" style="padding-bottom:8px"><div class="section-title">已有共享</div></div>
      <div style="padding:0 18px 14px">
        ${shares.length ? shares.map((s) => `<div class="member-row" style="padding-left:0;padding-right:0">
          <span class="avatar sm" style="background:var(--c-ink-100);color:var(--c-ink-600)">${icon(s.granteeType === 'link' ? 'link' : 'user', 12)}</span>
          <div class="member-main">
            <div class="member-name">${esc(s.granteeName)}</div>
            <div class="member-email">${esc(s.granteeEmail || (s.granteeType === 'link' ? '任何获得链接的人' : ''))}</div>
          </div>
          <span class="badge">${esc(permLabel(s.permission))}</span>
          ${s.token ? `<button class="icon-btn sm" data-copy-link="${esc(s.token)}" title="复制链接">${icon('copy')}</button>` : ''}
          <button class="icon-btn sm" data-del-share="${esc(s.id)}" title="移除">${icon('close')}</button>
        </div>`).join('') : '<div class="text-sm text-muted">尚未共享给任何人。</div>'}
      </div>
    </div>
  </div>`;

  qs('#toggle-private', panel).addEventListener('click', async () => {
    try {
      await ctx.api.updateFile(f.id, { private: !f.isPrivate });
      notify.success(f.isPrivate ? '已改为继承知识库权限' : '已设为私密');
      await renderShareTab(ctx, panel, { ...f, isPrivate: !f.isPrivate });
    } catch (err) { notify.error(err.message); }
  });

  qs('#share-add', panel).addEventListener('click', async () => {
    const email = qs('#share-email', panel).value.trim();
    if (!email) { notify.warn('请输入邮箱'); return; }
    try {
      const users = await ctx.api.searchUsers(email);
      const target = (users.users || []).find((u) => u.email.toLowerCase() === email.toLowerCase()) || users.users?.[0];
      if (!target) { notify.warn('未找到该用户，请确认对方已注册'); return; }
      await ctx.api.createShare({
        resourceType: 'file', resourceId: f.id, granteeType: 'user',
        granteeId: target.id, permission: qs('#share-perm', panel).value
      });
      notify.success(`已共享给 ${target.name}`);
      await renderShareTab(ctx, panel, f);
    } catch (err) { notify.error(err.message); }
  });

  qs('#share-link', panel).addEventListener('click', async () => {
    try {
      const res = await ctx.api.createShare({
        resourceType: 'file', resourceId: f.id, granteeType: 'link',
        permission: qs('#share-perm', panel).value, expiresInDays: 7
      });
      const row = (res.share || []).find((s) => s.granteeType === 'link');
      if (row?.token) {
        await copyText(`${location.origin}/#/share/${row.token}`, '分享链接已复制（7 天内有效）');
      }
      await renderShareTab(ctx, panel, f);
    } catch (err) { notify.error(err.message); }
  });

  on(panel, 'click', '[data-copy-link]', (e, node) => {
    copyText(`${location.origin}/#/share/${node.getAttribute('data-copy-link')}`, '链接已复制');
  });
  on(panel, 'click', '[data-del-share]', async (e, node) => {
    try {
      await ctx.api.deleteShare(node.getAttribute('data-del-share'));
      notify.success('已移除共享');
      await renderShareTab(ctx, panel, f);
    } catch (err) { notify.error(err.message); }
  });
}

function permLabel(p) {
  return { view: '只读', comment: '可评论', edit: '可编辑', manage: '可管理' }[p] || p;
}

export default { meta, mount, unmount };
