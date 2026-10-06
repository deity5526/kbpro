/**
 * KBPRO — 分类文件夹
 * 文件夹管理控制台：树形目录、拖拽排序、批量归类、未分类整理。
 * 与「文件库」页内嵌的目录树不同，本页专注于目录结构本身的治理。
 */
import {
  qs, qsa, on, icon, notify, modal, dropdown, confirmDialog, promptDialog,
  emptyState, esc, timeAgo, formatBytes, formatNumber, fileIconHtml, skeleton
} from '../ui.js';

export const meta = { title: '分类文件夹', icon: 'folder' };

/* ------------------------------------------------------------------ 常量 */

const UNFILED = '__unfiled__';
const ROOT = '__root__';

const ICON_CHOICES = ['folder', 'layers', 'book', 'bulb', 'target', 'chart', 'users', 'shield', 'globe', 'file', 'tag', 'archive'];

const COLOR_CHOICES = ['', '#1F2937', '#4B5563', '#0E9F6E', '#2563EB', '#7C3AED', '#C2410C', '#BE185D', '#0369A1'];

/* ------------------------------------------------------------------ 状态 */

let page = null;

function newPageState() {
  return {
    offs: [],
    timers: [],
    root: null,
    workspace: null,
    workspaceId: '',
    tree: [],
    flat: [],
    selected: UNFILED,
    opened: {},
    checked: new Set(),
    detail: {
      loading: false,
      breadcrumb: [],
      files: [],
      notes: [],
      checkedFiles: new Set(),
      checkedNotes: new Set(),
      error: ''
    },
    dragId: '',
    dropId: ''
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

function findNodeSafe(id, { maxDepth = 64 } = {}) {
  const seen = new Set();
  const walk = (list, depth) => {
    if (depth > maxDepth) return null;
    for (const node of list) {
      if (!node || seen.has(node.id)) continue;
      seen.add(node.id);
      if (node.id === id) return node;
      const hit = walk(node.children || [], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(page.tree, 0);
}

function depthOf(id) {
  const trail = [];
  let cur = findNodeSafe(id);
  let guard = 0;
  while (cur && guard++ < 64) {
    trail.unshift(cur);
    cur = cur.parentId ? findNodeSafe(cur.parentId) : null;
  }
  return trail;
}

/** 目标是否为拖拽源自身或其后代 */
function isSelfOrDescendant(targetId, dragId) {
  if (!targetId || !dragId) return false;
  if (targetId === dragId) return true;
  const trail = depthOf(targetId);
  return trail.some((n) => n.id === dragId);
}

function canWrite() {
  return ['edit', 'manage'].includes(page?.workspace?.permission);
}

function canManage() {
  return page?.workspace?.permission === 'manage';
}

function writeDenied(what) {
  if (!page?.workspace) return '请先选择知识库';
  if (canWrite()) return '';
  return `当前知识库权限为「只读」，不能${what}，需要编辑或管理权限`;
}

function manageDenied(what) {
  if (!page?.workspace) return '请先选择知识库';
  if (canManage()) return '';
  return `当前知识库权限不足，不能${what}，需要管理权限`;
}

function writeAttr(what) {
  return canWrite() ? '' : ` disabled title="${esc(writeDenied(what))}"`;
}

function manageAttr(what) {
  return canManage() ? '' : ` disabled title="${esc(manageDenied(what))}"`;
}

/* ------------------------------------------------------------------ 挂载 */

export async function mount(container, ctx) {
  const { workspace } = ctx;

  page = newPageState();
  page.root = container;
  page.workspace = workspace || null;

  if (!workspace) {
    container.innerHTML = `<div class="page">${emptyState({
      iconName: 'layers',
      title: '还没有知识库',
      desc: '请先在左上角创建一个知识库，再来管理文件夹结构。',
      actions: '<button class="btn btn-primary" data-act="goto-dashboard">回到首页</button>'
    })}</div>`;
    addOff(on(container, 'click', '[data-act="goto-dashboard"]', () => ctx.navigate('dashboard')));
    return;
  }

  page.workspaceId = workspace.id;
  const preselect = ctx.params?.[0] || ctx.query?.folder || '';
  page.selected = preselect || UNFILED;

  container.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">分类文件夹</h1>
        <p class="page-desc">规划「${esc(workspace.name)}」的目录结构：拖拽调整层级、批量归类内容、整理未分类文件。</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" data-act="refresh">${icon('refresh')}<span>刷新</span></button>
        <button class="btn btn-primary" data-act="new-folder"${writeAttr('新建文件夹')}>${icon('plus')}<span>新建文件夹</span></button>
      </div>
    </div>
    <div id="folders-batch"></div>
    <div id="folders-body">${skeleton(6)}</div>
  </div>`;

  bindEvents(container, ctx);
  await reloadAll(ctx, true);
}

/* ------------------------------------------------------------------ 数据 */

async function reloadAll(ctx, first = false) {
  try {
    const res = await ctx.api.folders(page.workspaceId);
    page.tree = res.tree || [];
    page.flat = res.flat || [];
  } catch (err) {
    page.tree = [];
    page.flat = [];
    renderShell(ctx);
    notify.error(`文件夹加载失败：${err.message}`);
    return;
  }

  // 校正选中项：文件夹可能已被删除
  if (page.selected !== UNFILED && page.selected !== ROOT && !findNodeSafe(page.selected)) {
    page.selected = UNFILED;
  }

  renderShell(ctx);
  if (!first) notify.success('目录已刷新');
  await loadDetail(ctx);
}

async function loadDetail(ctx) {
  page.detail.loading = true;
  page.detail.error = '';
  page.detail.checkedFiles = new Set();
  page.detail.checkedNotes = new Set();
  renderBatchBar(ctx);
  renderDetail(ctx);

  if (page.selected === UNFILED || page.selected === ROOT) {
    page.detail.breadcrumb = [];
    const params = { workspaceId: page.workspaceId, folderId: 'root', limit: 100 };
    try {
      const [filesRes, notesRes] = await Promise.all([ctx.api.files(params), ctx.api.notes(params)]);
      page.detail.files = filesRes.files || [];
      page.detail.notes = notesRes.notes || [];
    } catch (err) {
      page.detail.files = [];
      page.detail.notes = [];
      page.detail.error = err.message;
      notify.error(`内容加载失败：${err.message}`);
    }
    page.detail.loading = false;
    renderDetail(ctx);
    return;
  }

  try {
    const [crumb, filesRes, notesRes] = await Promise.all([
      ctx.api.breadcrumb(page.selected),
      ctx.api.files({ workspaceId: page.workspaceId, folderId: page.selected, limit: 100 }),
      ctx.api.notes({ workspaceId: page.workspaceId, folderId: page.selected, limit: 100 })
    ]);
    page.detail.breadcrumb = crumb.breadcrumb || [];
    page.detail.files = filesRes.files || [];
    page.detail.notes = notesRes.notes || [];
  } catch (err) {
    page.detail.breadcrumb = [];
    page.detail.files = [];
    page.detail.notes = [];
    page.detail.error = err.message;
    notify.error(`文件夹内容加载失败：${err.message}`);
  }
  page.detail.loading = false;
  renderDetail(ctx);
}

/* ------------------------------------------------------------------ 渲染：骨架 */

function renderShell(ctx) {
  const host = qsIn('#folders-body');
  if (!host) return;
  page.detail.checkedFiles = page.detail.checkedFiles || new Set();
  page.detail.checkedNotes = page.detail.checkedNotes || new Set();

  const hasFolders = page.tree.length > 0;
  const emptyDetail = emptyState({
    iconName: 'folder',
    title: '还没有任何文件夹',
    desc: `用文件夹把「${page.workspace.name}」里的文档与笔记分门别类，检索和协作都会更高效。`,
    actions: `<button class="btn btn-primary" data-act="new-folder"${writeAttr('新建文件夹')}>${icon('plus')}<span>新建文件夹</span></button>`
  });

  host.innerHTML = `
    <div class="grid" style="grid-template-columns:minmax(240px,300px) minmax(0,1fr);gap:16px;align-items:start">
      <div class="card">
        <div class="card-pad" style="padding-bottom:10px">
          <div class="section-head" style="margin-bottom:8px">
            <div class="section-title" style="font-size:var(--fs-base)">${icon('folder')} 目录结构</div>
            <span class="text-xs text-muted">${page.flat.length} 个</span>
          </div>
          <div class="text-xs text-muted mb-3" style="line-height:1.7">
            ${hasFolders ? '拖拽文件夹可调整层级；勾选后可批量移动。' : '创建第一个文件夹后，即可拖拽调整层级。'}
          </div>
          <div data-tree-root>
            ${unfiledNodeHtml()}
            ${hasFolders
              ? `<div class="text-xs text-muted mt-4 mb-1" style="letter-spacing:.02em">文件夹</div>${treeHtml(page.tree, 0)}`
              : '<div class="text-xs text-muted mt-4">暂无文件夹。</div>'}
          </div>
        </div>
      </div>
      <div id="folders-detail">
        ${hasFolders ? detailHtml(ctx) : `<div class="card">${emptyDetail}</div>`}
      </div>
    </div>`;

  renderBatchBar(ctx);
  updateCounts();
}

/* ------------------------------------------------------------------ 渲染：树 */

function treeHtml(nodes, depth) {
  if (!Array.isArray(nodes) || depth > 64) return '';
  return nodes.map((node) => treeNodeHtml(node, depth)).join('');
}

function treeNodeHtml(node, depth) {
  if (!node) return '';
  const open = page.opened[node.id] === true; // 默认收起，点击 caret 展开
  const active = page.selected === node.id;
  const checked = page.checked.has(node.id);
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const color = node.color ? ` style="color:${esc(node.color)}"` : '';

  return `<div class="tree-node${open ? ' is-open' : ''}" data-node="${esc(node.id)}">
    <div class="tree-row${active ? ' is-active' : ''}" data-tree-row="${esc(node.id)}" data-depth="${depth}" draggable="${canWrite() ? 'true' : 'false'}">
      <input type="checkbox" data-tree-check="${esc(node.id)}"${checked ? ' checked' : ''}${canWrite() ? '' : ' disabled'} aria-label="选择文件夹" style="flex:none;margin:0 2px 0 0;accent-color:var(--c-ink)">
      <span class="tree-caret${hasChildren ? '' : ' is-leaf'}" data-caret="${esc(node.id)}">${icon('chevronRight')}</span>
      <span class="tree-ico"${color}>${icon(node.icon || 'folder', 14)}</span>
      <span class="tree-label" title="${esc(node.name)}">${esc(node.name)}</span>
      <span class="tree-count" title="${node.fileCount} 文档 · ${node.noteCount} 笔记">${node.fileCount}/${node.noteCount}</span>
      <button class="icon-btn sm tree-more" data-node-menu="${esc(node.id)}" aria-label="更多操作">${icon('moreV')}</button>
    </div>
    <div class="tree-children"${open ? '' : ' hidden'}>
      ${treeHtml(node.children || [], depth + 1)}
    </div>
  </div>`;
}

function unfiledNodeHtml() {
  const active = page.selected === UNFILED;
  const files = active ? page.detail.files.length : 0;
  const notes = active ? page.detail.notes.length : 0;
  return `<div class="tree-node">
    <div class="tree-row${active ? ' is-active' : ''}" data-tree-row="${esc(ROOT)}" data-unfiled="1">
      <span class="tree-caret is-leaf">${icon('chevronRight')}</span>
      <span class="tree-ico">${icon('inbox', 14)}</span>
      <span class="tree-label">未分类（根目录）</span>
      <span class="tree-count" data-unfiled-count title="根目录下的未分类内容">${active ? `${files}/${notes}` : '—'}</span>
    </div>
  </div>`;
}

/* ------------------------------------------------------------------ 渲染：详情 */

function detailHtml(ctx) {
  if (page.selected === UNFILED || page.selected === ROOT) return unfiledDetailHtml(ctx);

  const node = findNodeSafe(page.selected);
  if (!node) {
    return `<div class="card">${emptyState({
      iconName: 'folder',
      title: '文件夹不存在',
      desc: '它可能已被删除，请从左侧重新选择。'
    })}</div>`;
  }

  const trail = page.detail.breadcrumb.length ? page.detail.breadcrumb : depthOf(node.id);
  const crumbHtml = [
    `<span class="chip chip-btn" data-crumb="${esc(ROOT)}">根目录</span>`,
    ...trail.map((n) => `<span class="text-xs text-muted">${icon('chevronRight', 12)}</span><span class="chip chip-btn" data-crumb="${esc(n.id)}">${esc(n.name)}</span>`)
  ].join('');

  return `
    <div class="card mb-4">
      <div class="card-pad">
        <div class="flex items-center flex-wrap gap-2 mb-3">${crumbHtml}</div>
        <div class="setting-row">
          <div class="setting-main">
            <div class="setting-title">名称</div>
            <div class="setting-desc">同级目录下不可重名，最长 80 个字符。</div>
          </div>
          <div class="setting-ctl">
            <input class="input input-sm" data-detail-name value="${esc(node.name)}" maxlength="80" style="min-width:180px"${writeAttr('重命名文件夹')}>
            <button class="btn btn-sm btn-default" data-detail-act="rename"${writeAttr('重命名文件夹')}>${icon('check')}<span>保存</span></button>
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-main">
            <div class="setting-title">图标与颜色</div>
            <div class="setting-desc">用于在目录树与文件库中快速识别该分类。</div>
          </div>
          <div class="setting-ctl" style="flex-row;flex-wrap:wrap;min-width:0;gap:6px">
            ${ICON_CHOICES.map((name) => `<button class="btn btn-sm ${name === (node.icon || 'folder') ? 'btn-primary' : 'btn-default'}" data-detail-icon="${esc(name)}" title="${esc(name)}" style="width:30px;padding:0;justify-content:center"${writeAttr('更改图标')}>${icon(name)}</button>`).join('')}
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-main">
            <div class="setting-title">颜色标识</div>
            <div class="setting-desc">当前：${node.color ? esc(node.color) : '未设置'}</div>
          </div>
          <div class="setting-ctl" style="flex-wrap:wrap;gap:6px">
            ${COLOR_CHOICES.map((c) => `<button class="btn btn-sm ${(node.color || '') === c ? 'btn-primary' : 'btn-default'}" data-detail-color="${esc(c)}" title="${c ? esc(c) : '默认'}" style="width:30px;padding:0;justify-content:center"${writeAttr('更改颜色')}>${c ? `<span style="width:12px;height:12px;border-radius:3px;background:${esc(c)};display:inline-block"></span>` : icon('close', 12)}</button>`).join('')}
          </div>
        </div>
        <div class="setting-row">
          <div class="setting-main">
            <div class="setting-title">目录信息</div>
            <div class="setting-desc">路径 ${esc(node.path || '/')} · 直接子文件夹 ${Array.isArray(node.children) ? node.children.length : 0} 个</div>
          </div>
          <div class="setting-ctl">
            <button class="btn btn-sm btn-default" data-detail-act="new-child"${writeAttr('新建子文件夹')}>${icon('plus')}<span>新建子文件夹</span></button>
            <button class="btn btn-sm btn-danger" data-detail-act="delete"${manageAttr('删除文件夹')}>${icon('trash')}<span>删除</span></button>
          </div>
        </div>
        <div class="stat-inline mt-4">
          <div class="stat-inline-item"><span class="stat-inline-value">${Number(node.fileCount || 0)}</span><span class="stat-inline-label">本级文档</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value">${Number(node.noteCount || 0)}</span><span class="stat-inline-label">本级笔记</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value">${Number(node.totalFileCount ?? node.totalCount ?? 0)}</span><span class="stat-inline-label">含子目录文档</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value">${Number(node.totalNoteCount ?? 0)}</span><span class="stat-inline-label">含子目录笔记</span></div>
        </div>
      </div>
    </div>

    <div class="card mb-4">
      <div class="card-pad" style="padding-bottom:8px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('file')} 文件夹内容</div>
            <div class="section-sub">文档 ${page.detail.files.length} 份 · 笔记 ${page.detail.notes.length} 篇（最多各显示 100 项）</div>
          </div>
          <div class="section-actions">
            <button class="btn btn-sm btn-ghost" data-batch-items="move"${page.detail.files.length || page.detail.notes.length ? '' : ' disabled'}>批量移动所选</button>
            <button class="btn btn-sm btn-ghost" data-batch-items="remove"${page.detail.files.length || page.detail.notes.length ? '' : ' disabled'}>移出文件夹</button>
          </div>
        </div>
      </div>
      <div style="padding:0 8px 12px">
        ${contentsHtml({ showSelect: true })}
      </div>
    </div>`;
}

function unfiledDetailHtml(ctx) {
  const files = page.detail.files;
  const notes = page.detail.notes;
  return `
    <div class="card mb-4">
      <div class="card-pad">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('inbox')} 未分类内容</div>
            <div class="section-sub">这些文档与笔记尚未归入任何文件夹，批量归类后目录会更清爽</div>
          </div>
          <div class="section-actions">
            <button class="btn btn-sm btn-default" data-unfiled-act="move-all"${writeAttr('批量归类')}>${icon('move')}<span>全部归类到…</span></button>
            <button class="btn btn-sm btn-ghost" data-batch-items="move"${page.detail.files.length || page.detail.notes.length ? '' : ' disabled'}>移动所选到…</button>
          </div>
        </div>
        <div class="stat-inline mt-4">
          <div class="stat-inline-item"><span class="stat-inline-value">${files.length}</span><span class="stat-inline-label">未分类文档</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value">${notes.length}</span><span class="stat-inline-label">未分类笔记</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value">${formatBytes(files.reduce((n, f) => n + Number(f.size || 0), 0))}</span><span class="stat-inline-label">占用空间</span></div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-pad" style="padding-bottom:8px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('file')} 内容列表</div>
            <div class="section-sub">勾选后可批量归入指定文件夹</div>
          </div>
        </div>
      </div>
      <div style="padding:0 8px 12px">
        ${contentsHtml({ showSelect: true })}
      </div>
    </div>`;
}

function contentsHtml({ showSelect }) {
  if (page.detail.loading) {
    return `<div class="flex-col gap-2" style="padding:12px">${skeleton(3)}</div>`;
  }
  if (page.detail.error) {
    return `<div class="empty" style="padding:28px 16px">
      <div class="empty-ico">${icon('alert')}</div>
      <div class="empty-desc">${esc(page.detail.error)}</div>
      <div class="empty-actions"><button class="btn btn-default" data-act="refresh">重试</button></div>
    </div>`;
  }
  const { files, notes } = page.detail;
  if (!files.length && !notes.length) {
    return `<div class="empty" style="padding:28px 16px">
      <div class="empty-ico">${icon('folderOpen')}</div>
      <div class="empty-desc">这个位置还没有内容，可以从文件库上传或新建笔记。</div>
    </div>`;
  }
  return `
    ${files.length ? `<div class="text-xs text-muted mb-2" style="padding:0 8px">文档 ${files.length}</div>${files.map((f) => fileRowHtml(f, showSelect)).join('')}` : ''}
    ${notes.length ? `<div class="text-xs text-muted mt-4 mb-2" style="padding:0 8px">笔记 ${notes.length}</div>${notes.map((n) => noteRowHtml(n, showSelect)).join('')}` : ''}`;
}

function fileRowHtml(f, showSelect) {
  const checked = page.detail.checkedFiles.has(f.id);
  return `<div class="list-row" data-item-file="${esc(f.id)}">
    ${showSelect ? `<input type="checkbox" data-item-check-file="${esc(f.id)}"${checked ? ' checked' : ''}${canWrite() ? '' : ' disabled'} style="flex:none;margin:0 4px 0 0;accent-color:var(--c-ink)">` : ''}
    ${fileIconHtml(f.ext)}
    <div class="list-main">
      <div class="list-title">${esc(f.name)}</div>
      <div class="list-sub">${esc(f.sizeText || formatBytes(f.size))} · 更新于 ${esc(timeAgo(f.updatedAt || f.updated_at))}</div>
    </div>
    <button class="btn btn-sm btn-ghost" data-open-item="file" data-item-id="${esc(f.id)}">打开</button>
    <button class="btn btn-sm btn-ghost" data-remove-item="file" data-item-id="${esc(f.id)}"${writeAttr('移出文件夹')}>${icon('move')}<span>移出</span></button>
  </div>`;
}

function noteRowHtml(n, showSelect) {
  const checked = page.detail.checkedNotes.has(n.id);
  return `<div class="list-row" data-item-note="${esc(n.id)}">
    ${showSelect ? `<input type="checkbox" data-item-check-note="${esc(n.id)}"${checked ? ' checked' : ''}${canWrite() ? '' : ' disabled'} style="flex:none;margin:0 4px 0 0;accent-color:var(--c-ink)">` : ''}
    <span class="file-ico f-md" style="background:var(--c-ink-100);color:var(--c-ink-700)">${esc(n.emoji || 'NOTE')}</span>
    <div class="list-main">
      <div class="list-title">${esc(n.title)}</div>
      <div class="list-sub">${formatNumber(n.wordCount || n.word_count)} 字 · 更新于 ${esc(timeAgo(n.updatedAt || n.updated_at))}</div>
    </div>
    <button class="btn btn-sm btn-ghost" data-open-item="note" data-item-id="${esc(n.id)}">打开</button>
    <button class="btn btn-sm btn-ghost" data-remove-item="note" data-item-id="${esc(n.id)}"${writeAttr('移出文件夹')}>${icon('move')}<span>移出</span></button>
  </div>`;
}

function renderDetail(ctx) {
  // 目录为空时右侧展示的是引导卡片，不需要被详情覆盖
  if (!page.tree.length) return;
  const host = qsIn('#folders-detail');
  if (!host) return;
  host.innerHTML = detailHtml(ctx);
  updateCounts();
}

/* ------------------------------------------------------------------ 渲染：批量条 */

function renderBatchBar(ctx) {
  const host = qsIn('#folders-batch');
  if (!host) return;
  const count = page.checked.size;
  if (!count) { host.innerHTML = ''; return; }
  host.innerHTML = `<div class="batch-bar">
    <span class="bb-count">已选择 ${count} 个文件夹</span>
    <div class="vr"></div>
    <button class="btn btn-sm" data-batch-act="move"${writeAttr('批量移动')}>${icon('move')}<span>批量移动</span></button>
    <button class="btn btn-sm" data-batch-act="uncheck">取消选择</button>
    <div class="spacer"></div>
    <span class="text-xs" style="color:rgba(255,255,255,.6)">拖拽同样可以调整层级</span>
  </div>`;
}

/* ------------------------------------------------------------------ 事件 */

function bindEvents(container, ctx) {
  const offs = [];

  /* --- 顶部动作 --- */
  offs.push(on(container, 'click', '[data-act="new-folder"]', (e, node) => {
    if (node.disabled) return;
    openCreateFolder(ctx, null);
  }));
  offs.push(on(container, 'click', '[data-act="refresh"]', () => {
    reloadAll(ctx, true).catch((err) => notify.error(err.message));
  }));

  /* --- 树：展开 / 折叠 --- */
  offs.push(on(container, 'click', '[data-caret]', (e, node) => {
    e.stopPropagation();
    const id = node.getAttribute('data-caret');
    toggleNode(id);
  }));

  /* --- 树：选中 --- */
  offs.push(on(container, 'click', '[data-tree-row]', (e, node) => {
    if (e.target.closest('[data-node-menu]') || e.target.closest('[data-tree-check]') || e.target.closest('[data-caret]')) return;
    const id = node.getAttribute('data-tree-row');
    if (!id || id === page.selected) return;
    page.selected = id;
    updateActiveRow();
    loadDetail(ctx);
  }));

  /* --- 树：勾选 --- */
  offs.push(on(container, 'change', '[data-tree-check]', (e, node) => {
    const id = node.getAttribute('data-tree-check');
    if (node.checked) page.checked.add(id); else page.checked.delete(id);
    renderBatchBar(ctx);
  }));

  /* --- 树：节点菜单 --- */
  offs.push(on(container, 'click', '[data-node-menu]', (e, node) => {
    e.stopPropagation();
    const id = node.getAttribute('data-node-menu');
    openNodeMenu(node, id, ctx);
  }));

  /* --- 详情：面包屑 --- */
  offs.push(on(container, 'click', '[data-crumb]', (e, node) => {
    const id = node.getAttribute('data-crumb');
    page.selected = id === ROOT ? UNFILED : id;
    updateActiveRow();
    loadDetail(ctx);
  }));

  /* --- 详情：重命名 / 新建子文件夹 / 删除 --- */
  offs.push(on(container, 'click', '[data-detail-act]', (e, node) => {
    const act = node.getAttribute('data-detail-act');
    if (node.disabled) return;
    if (act === 'rename') return renameSelected(ctx);
    if (act === 'new-child') return openCreateFolder(ctx, page.selected);
    if (act === 'delete') return confirmDelete(ctx, page.selected);
  }));

  offs.push(on(container, 'keydown', '[data-detail-name]', (e, node) => {
    if (e.key === 'Enter') { e.preventDefault(); renameSelected(ctx); }
  }));

  /* --- 详情：图标 / 颜色 --- */
  offs.push(on(container, 'click', '[data-detail-icon]', (e, node) => {
    if (node.disabled) return;
    patchFolder(ctx, page.selected, { icon: node.getAttribute('data-detail-icon') });
  }));
  offs.push(on(container, 'click', '[data-detail-color]', (e, node) => {
    if (node.disabled) return;
    patchFolder(ctx, page.selected, { color: node.getAttribute('data-detail-color') });
  }));

  /* --- 未分类：全部归类 --- */
  offs.push(on(container, 'click', '[data-unfiled-act="move-all"]', (e, node) => {
    if (node.disabled) return;
    openMoveAllUnfiled(ctx);
  }));

  /* --- 内容勾选 --- */
  offs.push(on(container, 'change', '[data-item-check-file]', (e, node) => {
    const id = node.getAttribute('data-item-check-file');
    if (node.checked) page.detail.checkedFiles.add(id); else page.detail.checkedFiles.delete(id);
    syncItemButtons();
  }));
  offs.push(on(container, 'change', '[data-item-check-note]', (e, node) => {
    const id = node.getAttribute('data-item-check-note');
    if (node.checked) page.detail.checkedNotes.add(id); else page.detail.checkedNotes.delete(id);
    syncItemButtons();
  }));

  /* --- 内容：打开 / 移出 --- */
  offs.push(on(container, 'click', '[data-open-item]', (e, node) => {
    const type = node.getAttribute('data-open-item');
    const id = node.getAttribute('data-item-id');
    if (type === 'file') ctx.navigate('files', [], { open: id });
    else ctx.navigate('notes', [id]);
  }));

  offs.push(on(container, 'click', '[data-remove-item]', async (e, node) => {
    if (node.disabled) return;
    const type = node.getAttribute('data-remove-item');
    const id = node.getAttribute('data-item-id');
    node.disabled = true;
    try {
      if (type === 'file') await ctx.api.batchFiles('move', [id], { targetFolderId: null });
      else await ctx.api.batchNotes('move', [id], { targetFolderId: null });
      notify.success('已移出文件夹');
      await refreshAfterMutation(ctx);
    } catch (err) {
      node.disabled = false;
      notify.error(err.message);
    }
  }));

  /* --- 内容：批量移动 / 移出所选 --- */
  offs.push(on(container, 'click', '[data-batch-items]', (e, node) => {
    if (node.disabled) return;
    const mode = node.getAttribute('data-batch-items');
    openMoveSelectedItems(ctx, mode);
  }));

  /* --- 批量条 --- */
  offs.push(on(container, 'click', '[data-batch-act]', (e, node) => {
    const act = node.getAttribute('data-batch-act');
    if (act === 'uncheck') {
      page.checked.clear();
      qsa('[data-tree-check]', page.root).forEach((box) => { box.checked = false; });
      renderBatchBar(ctx);
      return;
    }
    if (act === 'move') {
      if (node.disabled) return;
      openBatchMoveFolders(ctx);
    }
  }));

  /* --- 拖拽 --- */
  offs.push(on(container, 'dragstart', '[data-tree-row]', (e, node) => {
    const id = node.getAttribute('data-tree-row');
    if (!id || id === UNFILED || id === ROOT || !canWrite()) { e.preventDefault(); return; }
    page.dragId = id;
    try { e.dataTransfer.setData('text/plain', id); } catch { /* 某些浏览器限制 */ }
    e.dataTransfer.effectAllowed = 'move';
  }));

  offs.push(on(container, 'dragover', '[data-tree-row]', (e, node) => {
    if (!page.dragId) return;
    const targetId = node.getAttribute('data-tree-row');
    const isUnfiledRow = node.hasAttribute('data-unfiled');
    const valid = isUnfiledRow || targetId === ROOT
      ? true
      : (!isSelfOrDescendant(targetId, page.dragId) && targetId !== page.dragId);
    if (!valid) {
      e.dataTransfer.dropEffect = 'none';
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (page.dropId !== targetId) {
      qsa('.is-drop-target', page.root).forEach((n) => n.classList.remove('is-drop-target'));
      node.classList.add('is-drop-target');
      page.dropId = targetId;
    }
  }));

  offs.push(on(container, 'dragleave', '[data-tree-row]', (e, node) => {
    if (node.classList.contains('is-drop-target') && !node.contains(e.relatedTarget)) {
      node.classList.remove('is-drop-target');
      if (page.dropId === node.getAttribute('data-tree-row')) page.dropId = '';
    }
  }));

  offs.push(on(container, 'drop', '[data-tree-row]', async (e, node) => {
    e.preventDefault();
    const targetId = node.getAttribute('data-tree-row');
    const dragId = page.dragId;
    const isUnfiledRow = node.hasAttribute('data-unfiled');
    clearDropState();
    if (!dragId || !targetId) return;
    // 「未分类（根目录）」与「根目录」都是根层级
    const parentId = (targetId === ROOT || isUnfiledRow) ? null : targetId;

    if (parentId && (parentId === dragId || isSelfOrDescendant(parentId, dragId))) {
      notify.error('不能把文件夹移动到它自己的子目录中');
      return;
    }
    const node0 = findNodeSafe(dragId);
    if (node0 && (node0.parentId || null) === parentId) {
      notify.info('该文件夹已在此位置');
      return;
    }
    try {
      await ctx.api.moveFolder(dragId, parentId);
      notify.success(`已把「${node0?.name || '文件夹'}」移动到${parentId ? `「${findNodeSafe(parentId)?.name || '目标'}」` : '根目录'}`);
      await reloadAll(ctx, true);
    } catch (err) {
      notify.error(err.message);
    }
  }));

  offs.push(on(container, 'dragend', '[data-tree-row]', () => clearDropState()));

  page.offs = offs;
}

function syncItemButtons() {
  const hasAny = page.detail.checkedFiles.size + page.detail.checkedNotes.size > 0;
  qsa('[data-batch-items]', page.root).forEach((btn) => {
    if (btn.getAttribute('data-batch-items') === 'remove' && !canWrite()) return;
    btn.disabled = !hasAny;
  });
}

function updateActiveRow() {
  qsa('[data-tree-row]', page.root).forEach((row) => {
    row.classList.toggle('is-active', row.getAttribute('data-tree-row') === page.selected);
  });
}

/** 用详情数据补齐「未分类（根目录）」的计数显示 */
function updateCounts() {
  const node = qsIn('[data-unfiled-count]', page.root);
  if (!node) return;
  if (page.selected !== UNFILED && page.selected !== ROOT) { node.textContent = '—'; return; }
  node.textContent = `${page.detail.files.length}/${page.detail.notes.length}`;
}

function clearDropState() {
  page.dragId = '';
  page.dropId = '';
  qsa('.is-drop-target', page.root).forEach((n) => n.classList.remove('is-drop-target'));
}

function toggleNode(id) {
  const node = qsIn(`[data-node="${cssEscape(id)}"]`, page.root);
  if (!node) return;
  const open = node.classList.toggle('is-open');
  page.opened[id] = open;
  const children = node.querySelector(':scope > .tree-children');
  if (!children) return;
  if (open) {
    children.hidden = false;
    children.classList.remove('is-closing');
  } else {
    children.classList.add('is-closing');
    later(() => {
      if (!node.classList.contains('is-open')) {
        children.hidden = true;
        children.classList.remove('is-closing');
      }
    }, 220);
  }
}

function cssEscape(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

/* ------------------------------------------------------------------ 操作 */

async function patchFolder(ctx, id, payload) {
  try {
    await ctx.api.updateFolder(id, payload);
    notify.success('文件夹已更新');
    await reloadAll(ctx, true);
  } catch (err) {
    notify.error(err.message);
  }
}

async function renameSelected(ctx) {
  const node = findNodeSafe(page.selected);
  if (!node) return;
  if (!canWrite()) { notify.warn(writeDenied('重命名文件夹')); return; }
  const input = qsIn('[data-detail-name]', page.root);
  const name = input ? input.value.trim() : '';
  if (!name) { notify.warn('文件夹名称不能为空'); return; }
  if (name === node.name) { notify.info('名称没有变化'); return; }
  try {
    await ctx.api.updateFolder(node.id, { name });
    notify.success('文件夹已重命名');
    await reloadAll(ctx, true);
  } catch (err) {
    notify.error(err.message);
  }
}

function openCreateFolder(ctx, parentId) {
  if (!canWrite()) { notify.warn(writeDenied('新建文件夹')); return; }
  const parent = parentId ? findNodeSafe(parentId) : null;

  const m = modal({
    title: parent ? `在「${parent.name}」下新建子文件夹` : '新建文件夹',
    sub: `归属知识库：${page.workspace.name}`,
    size: 'sm',
    body: `<div class="field">
        <label>文件夹名称</label>
        <input class="input" data-field="name" placeholder="例如：竞品调研" maxlength="80">
      </div>
      <div class="field">
        <label>图标</label>
        <div class="flex flex-wrap gap-2" data-icon-picker>
          ${ICON_CHOICES.map((name, i) => `<button type="button" class="btn btn-sm ${i === 0 ? 'btn-primary' : 'btn-default'}" data-pick-icon="${esc(name)}" title="${esc(name)}" style="width:32px;padding:0;justify-content:center">${icon(name)}</button>`).join('')}
        </div>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>颜色</label>
        <div class="flex flex-wrap gap-2" data-color-picker>
          ${COLOR_CHOICES.map((c) => `<button type="button" class="btn btn-sm ${c === '' ? 'btn-primary' : 'btn-default'}" data-pick-color="${esc(c)}" title="${c ? esc(c) : '默认'}" style="width:32px;padding:0;justify-content:center">${c ? `<span style="width:12px;height:12px;border-radius:3px;background:${esc(c)};display:inline-block"></span>` : icon('close', 12)}</button>`).join('')}
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
          const iconName = qsIn('[data-pick-icon].btn-primary', m.body)?.getAttribute('data-pick-icon') || 'folder';
          const color = qsIn('[data-pick-color].btn-primary', m.body)?.getAttribute('data-pick-color') || '';
          if (!name) { notify.warn('请填写文件夹名称'); return; }
          btn.disabled = true;
          try {
            await ctx.api.createFolder({ workspaceId: page.workspaceId, parentId: parentId || null, name, icon: iconName, color });
            notify.success(`已创建文件夹「${name}」`);
            close();
            await reloadAll(ctx, true);
          } catch (err) {
            notify.error(err.message);
          } finally {
            btn.disabled = false;
          }
        }
      }
    ]
  });

  bindPicker(qsIn('[data-icon-picker]', m.body), 'data-pick-icon');
  bindPicker(qsIn('[data-color-picker]', m.body), 'data-pick-color');
}

function bindPicker(host, attr) {
  if (!host) return;
  host.addEventListener('click', (e) => {
    const target = e.target.closest(`[${attr}]`);
    if (!target) return;
    qsa(`[${attr}]`, host).forEach((b) => {
      b.classList.toggle('btn-primary', b === target);
      b.classList.toggle('btn-default', b !== target);
    });
  });
}

function openNodeMenu(anchor, id, ctx) {
  const node = findNodeSafe(id);
  if (!node) return;

  dropdown(anchor, [
    {
      label: '新建子文件夹',
      icon: 'plus',
      disabled: !canWrite(),
      hint: canWrite() ? '' : '权限不足',
      onClick: () => openCreateFolder(ctx, id)
    },
    {
      label: '重命名',
      icon: 'edit',
      disabled: !canWrite(),
      hint: canWrite() ? '' : '权限不足',
      onClick: async () => {
        const name = await promptDialog({
          title: '重命名文件夹',
          label: '新的名称',
          value: node.name,
          confirmText: '保存'
        });
        if (!name || name === node.name) return;
        await patchFolder(ctx, id, { name });
      }
    },
    {
      label: '移动…',
      icon: 'move',
      disabled: !canWrite(),
      hint: canWrite() ? '' : '权限不足',
      onClick: () => openMoveFolder(ctx, id)
    },
    {
      label: '更改图标',
      icon: 'grid',
      disabled: !canWrite(),
      hint: canWrite() ? '' : '权限不足',
      onClick: () => openIconPicker(ctx, node)
    },
    { sep: true },
    {
      label: '删除',
      icon: 'trash',
      danger: true,
      disabled: !canManage(),
      hint: canManage() ? '' : '权限不足',
      onClick: () => confirmDelete(ctx, id)
    }
  ], { width: 220 });
}

function openIconPicker(ctx, node) {
  const m = modal({
    title: '更改图标与颜色',
    sub: node.name,
    size: 'sm',
    body: `<div class="field">
        <label>图标</label>
        <div class="flex flex-wrap gap-2" data-icon-picker>
          ${ICON_CHOICES.map((name) => `<button type="button" class="btn btn-sm ${name === (node.icon || 'folder') ? 'btn-primary' : 'btn-default'}" data-pick-icon="${esc(name)}" title="${esc(name)}" style="width:32px;padding:0;justify-content:center">${icon(name)}</button>`).join('')}
        </div>
      </div>
      <div class="field" style="margin-bottom:0">
        <label>颜色</label>
        <div class="flex flex-wrap gap-2" data-color-picker>
          ${COLOR_CHOICES.map((c) => `<button type="button" class="btn btn-sm ${(node.color || '') === c ? 'btn-primary' : 'btn-default'}" data-pick-color="${esc(c)}" title="${c ? esc(c) : '默认'}" style="width:32px;padding:0;justify-content:center">${c ? `<span style="width:12px;height:12px;border-radius:3px;background:${esc(c)};display:inline-block"></span>` : icon('close', 12)}</button>`).join('')}
        </div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '保存',
        primary: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          const iconName = qsIn('[data-pick-icon].btn-primary', m.body)?.getAttribute('data-pick-icon') || 'folder';
          const color = qsIn('[data-pick-color].btn-primary', m.body)?.getAttribute('data-pick-color') || '';
          btn.disabled = true;
          try {
            await ctx.api.updateFolder(node.id, { icon: iconName, color });
            notify.success('文件夹样式已更新');
            close();
            await reloadAll(ctx, true);
          } catch (err) {
            notify.error(err.message);
          } finally {
            btn.disabled = false;
          }
        }
      }
    ]
  });
  bindPicker(qsIn('[data-icon-picker]', m.body), 'data-pick-icon');
  bindPicker(qsIn('[data-color-picker]', m.body), 'data-pick-color');
}

/** 单一文件夹移动：选择目标父目录 */
function openMoveFolder(ctx, id) {
  const node = findNodeSafe(id);
  if (!node) return;
  const options = folderOptions({ excludeId: id, includeRoot: true });

  const m = modal({
    title: '移动文件夹',
    sub: `把「${node.name}」移动到`,
    size: 'sm',
    body: `<div class="field" style="margin-bottom:0">
        <label>目标位置</label>
        <select class="select" data-field="target">
          ${options}
        </select>
        <div class="field-hint">不能移动到它自己或它自己的子目录中，服务端会再次校验。</div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '移动',
        primary: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          const raw = qsIn('[data-field="target"]', m.body).value;
          const parentId = raw === ROOT ? null : raw;
          btn.disabled = true;
          try {
            await ctx.api.moveFolder(id, parentId);
            notify.success('文件夹已移动');
            close();
            await reloadAll(ctx, true);
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

/** 批量移动：逐个调用 api.moveFolder 并汇报成功 / 失败 */
function openBatchMoveFolders(ctx) {
  if (!canWrite()) { notify.warn(writeDenied('批量移动')); return; }
  const ids = [...page.checked];
  if (!ids.length) { notify.warn('请先勾选文件夹'); return; }
  const excluded = new Set(ids);
  const options = folderOptions({ excludeIds: excluded, includeRoot: true });

  const m = modal({
    title: '批量移动文件夹',
    sub: `共 ${ids.length} 个文件夹`,
    size: 'sm',
    body: `<div class="field">
        <label>目标位置</label>
        <select class="select" data-field="target">${options}</select>
        <div class="field-hint">目标列表已排除所选文件夹自身，移动失败的项目会在结果中列出。</div>
      </div>
      <div class="perm-grid" data-batch-result></div>`,
    actions: [
      { label: '关闭' },
      {
        label: '开始移动',
        primary: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          const raw = qsIn('[data-field="target"]', m.body).value;
          const parentId = raw === ROOT ? null : raw;
          btn.disabled = true;
          const host = qsIn('[data-batch-result]', m.body);
          host.innerHTML = `<div class="text-xs text-muted">正在移动 ${ids.length} 个项目…</div>`;
          let ok = 0;
          const failed = [];
          for (const id of ids) {
            try {
              await ctx.api.moveFolder(id, parentId);
              ok += 1;
            } catch (err) {
              failed.push({ id, name: findNodeSafe(id)?.name || id, message: err.message });
            }
          }
          host.innerHTML = `<div class="perm-row">
              <span style="width:14px;height:14px;color:var(--c-success)">${icon('check')}</span>
              <div class="flex-1">成功 ${ok} 个</div>
            </div>
            ${failed.length ? `<div class="perm-row">
              <span style="width:14px;height:14px;color:var(--c-danger)">${icon('alert')}</span>
              <div class="flex-1">
                <div class="text-sm">失败 ${failed.length} 个</div>
                <div class="text-xs text-muted">${esc(failed.map((f) => `${f.name}：${f.message}`).join('；'))}</div>
              </div>
            </div>` : ''}`;
          if (ok) notify.success(`已移动 ${ok} 个文件夹`);
          if (failed.length) notify.error(`${failed.length} 个文件夹移动失败`);
          page.checked = new Set(failed.map((f) => f.id));
          await reloadAll(ctx, true);
          if (!failed.length) close();
          btn.disabled = false;
        }
      }
    ]
  });
}

/** 删除确认：必须显式选择内容处理方式 */
function confirmDelete(ctx, id) {
  const node = findNodeSafe(id);
  if (!node) return;
  if (!canManage()) { notify.warn(manageDenied('删除文件夹')); return; }

  const children = Array.isArray(node.children) ? node.children.length : 0;
  let mode = 'move-to-root';

  const m = modal({
    title: `删除文件夹「${node.name}」`,
    sub: `该文件夹含 ${node.fileCount} 份文档、${node.noteCount} 篇笔记，${children} 个子文件夹`,
    size: 'sm',
    body: `<div class="text-sm text-2 mb-4" style="line-height:1.75">
        删除会同时移除该文件夹及其全部子文件夹。请选择其中内容的处理方式：
      </div>
      <div class="field" style="margin-bottom:0">
        <label>内容处理方式</label>
        <select class="select" data-field="mode">
          <option value="move-to-root">将内容移动到根目录（推荐）</option>
          <option value="cascade">连同内容一起删除</option>
        </select>
        <div class="field-hint" data-mode-hint>
          <strong>将内容移动到根目录</strong>：文件夹结构被删除，里面的文档与笔记会被移到「未分类（根目录）」，内容不会丢失。
        </div>
      </div>
      <div class="card mt-3" style="background:var(--c-ink-50)">
        <div class="card-pad" style="padding:12px 14px">
          <div class="text-xs text-muted" style="line-height:1.75" data-mode-warn>
            如果选择「连同内容一起删除」，其中所有文档与笔记都会进入回收站，可稍后从回收站恢复。
          </div>
        </div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '删除文件夹',
        danger: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          btn.disabled = true;
          try {
            const res = await ctx.api.deleteFolder(id, mode);
            notify.success(mode === 'cascade'
              ? `已删除 ${res?.removed || 1} 个文件夹，内容已移入回收站`
              : '文件夹已删除，内容已移动到根目录');
            close();
            if (page.selected === id) page.selected = UNFILED;
            page.checked.delete(id);
            await reloadAll(ctx, true);
          } catch (err) {
            notify.error(err.message);
          } finally {
            btn.disabled = false;
          }
        }
      }
    ]
  });

  const sel = qsIn('[data-field="mode"]', m.body);
  const hint = qsIn('[data-mode-hint]', m.body);
  const warn = qsIn('[data-mode-warn]', m.body);
  sel.addEventListener('change', () => {
    mode = sel.value;
    if (mode === 'cascade') {
      hint.innerHTML = '<strong>连同内容一起删除</strong>：文件夹与其中的文档、笔记都会进入回收站，之后可在回收站恢复。';
      warn.textContent = '提示：回收站会保留可恢复副本；超过保留期后将被彻底清理。';
    } else {
      hint.innerHTML = '<strong>将内容移动到根目录</strong>：文件夹结构被删除，里面的文档与笔记会被移到「未分类（根目录）」，内容不会丢失。';
      warn.textContent = '如果选择「连同内容一起删除」，其中所有文档与笔记都会进入回收站，可稍后从回收站恢复。';
    }
  });
}

/** 未分类：把根目录下的全部内容归类到某个文件夹 */
function openMoveAllUnfiled(ctx) {
  if (!canWrite()) { notify.warn(writeDenied('批量归类')); return; }
  const files = page.detail.files;
  const notes = page.detail.notes;
  if (!files.length && !notes.length) { notify.info('根目录下没有未分类内容'); return; }

  const m = modal({
    title: '整理未分类内容',
    sub: `文档 ${files.length} 份 · 笔记 ${notes.length} 篇`,
    size: 'sm',
    body: `<div class="field" style="margin-bottom:0">
        <label>归类到</label>
        <select class="select" data-field="target">
          <option value="">请选择目标文件夹</option>
          ${flatFolderOptions()}
        </select>
        <div class="field-hint">会把这些内容全部移动到所选文件夹下。</div>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '开始归类',
        primary: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          const target = qsIn('[data-field="target"]', m.body).value;
          if (!target) { notify.warn('请选择目标文件夹'); return; }
          btn.disabled = true;
          try {
            if (files.length) await ctx.api.batchFiles('move', files.map((f) => f.id), { targetFolderId: target });
            if (notes.length) await ctx.api.batchNotes('move', notes.map((n) => n.id), { targetFolderId: target });
            notify.success(`已将 ${files.length + notes.length} 项内容归类`);
            close();
            await reloadAll(ctx, true);
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

/** 详情内：移动所选内容 / 移出文件夹 */
function openMoveSelectedItems(ctx, mode) {
  const fileIds = [...page.detail.checkedFiles];
  const noteIds = [...page.detail.checkedNotes];
  if (!fileIds.length && !noteIds.length) { notify.warn('请先勾选内容'); return; }
  if (!canWrite()) { notify.warn(writeDenied('整理内容')); return; }

  if (mode === 'remove') {
    const doRemove = async (confirmed) => {
      if (!confirmed) return;
      try {
        if (fileIds.length) await ctx.api.batchFiles('move', fileIds, { targetFolderId: null });
        if (noteIds.length) await ctx.api.batchNotes('move', noteIds, { targetFolderId: null });
        notify.success('已移出文件夹');
        await reloadAll(ctx, true);
      } catch (err) {
        notify.error(err.message);
      }
    };
    confirmDialog({
      title: '移出文件夹',
      message: `确定把选中的 ${fileIds.length + noteIds.length} 项内容移出当前文件夹吗？内容会回到「未分类（根目录）」，不会被删除。`,
      confirmText: '移出'
    }).then(doRemove).catch((err) => notify.error(err.message));
    return;
  }

  const m = modal({
    title: '移动所选内容',
    sub: `文档 ${fileIds.length} 份 · 笔记 ${noteIds.length} 篇`,
    size: 'sm',
    body: `<div class="field" style="margin-bottom:0">
        <label>目标文件夹</label>
        <select class="select" data-field="target">
          <option value="">请选择目标文件夹</option>
          ${flatFolderOptions()}
        </select>
      </div>`,
    actions: [
      { label: '取消' },
      {
        label: '移动',
        primary: true,
        keepOpen: true,
        onClick: async (close, btn) => {
          const target = qsIn('[data-field="target"]', m.body).value;
          if (!target) { notify.warn('请选择目标文件夹'); return; }
          btn.disabled = true;
          try {
            if (fileIds.length) await ctx.api.batchFiles('move', fileIds, { targetFolderId: target });
            if (noteIds.length) await ctx.api.batchNotes('move', noteIds, { targetFolderId: target });
            notify.success('内容已移动');
            close();
            await reloadAll(ctx, true);
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

/** 生成 <option>，可排除若干文件夹（自身及其后代由服务端再次校验） */
function folderOptions({ excludeId = '', excludeIds = null, includeRoot = true } = {}) {
  const excluded = new Set(excludeIds || (excludeId ? [excludeId] : []));
  const lines = [];
  if (includeRoot) lines.push(`<option value="${esc(ROOT)}">根目录</option>`);

  const walk = (list, depth) => {
    if (!Array.isArray(list) || depth > 64) return;
    for (const node of list) {
      const isExcluded = excluded.has(node.id) || (!excludeIds && excludeId && isSelfOrDescendant(node.id, excludeId));
      if (!isExcluded) {
        lines.push(`<option value="${esc(node.id)}">${'　'.repeat(depth)}${esc(node.name)}</option>`);
      }
      walk(node.children || [], depth + 1);
    }
  };
  walk(page.tree, 0);
  return lines.join('');
}

/** 扁平文件夹列表 → <option>（用缩进体现层级，线性遍历，避免重复算深度） */
function flatFolderOptions() {
  const lines = [];
  const walk = (list, depth) => {
    if (!Array.isArray(list) || depth > 64) return;
    for (const node of list) {
      lines.push(`<option value="${esc(node.id)}">${'　'.repeat(depth)}${esc(node.name)}</option>`);
      walk(node.children || [], depth + 1);
    }
  };
  walk(page.tree, 0);
  return lines.join('');
}

async function refreshAfterMutation(ctx) {
  try {
    await reloadAll(ctx, true);
  } catch (err) {
    notify.error(err.message);
  }
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
