/**
 * KBPRO — 笔记中心
 * 富文本编辑（图片 / 代码块 / 表格 / 链接）· 自动保存 · 版本历史 · 实时协作提示
 */
import {
  qs, qsa, el, on, applyIcons, icon, notify, toast, modal, confirmDialog, promptDialog,
  dropdown, contextMenu, copyText, emptyState, esc, skeleton,
  timeAgo, formatDateTime, formatBytes, formatNumber, avatarHtml, tagHtml,
  pickFiles, downloadUrl, debounce, stripHtml, excerpt
} from '../ui.js';
import { getState, setState, canWrite } from '../store.js';
import { renderChatMarkdown, markdownToHtml } from '../md.js';

export const meta = { title: '笔记中心', icon: 'note' };

let cleanup = [];
let ctxRef = null;
let saveTimer = null;
let statusTimer = null;
let collabSource = null;
let currentNoteId = null;
let dirty = false;

const state = {
  workspaceId: '',
  notes: [],
  folderId: 'all',
  query: '',
  sort: 'updated',
  filter: 'all',
  active: null,          // 当前笔记对象
  versions: [],
  sideTab: 'info',
  sideOpen: false,
  peers: new Map()
};

/* ================================================================== 挂载 */

export async function mount(container, ctx) {
  ctxRef = ctx;
  const ws = ctx.workspace;
  if (!ws) {
    container.innerHTML = `<div class="page">${emptyState({ iconName: 'layers', title: '还没有知识库' })}</div>`;
    return;
  }
  state.workspaceId = ws.id;
  state.folderId = ctx.query.folderId || 'all';
  state.query = '';
  state.filter = 'all';
  state.sideTab = 'info';

  container.innerHTML = shellHtml();
  applyIcons(container);

  bindShell(container, ctx);
  await loadNotes(ctx);

  const wantId = ctx.params?.[0] || ctx.query.open;
  if (wantId) {
    await openNote(ctx, wantId);
  } else if (state.notes.length) {
    await openNote(ctx, state.notes[0].id);
  } else {
    renderEditorEmpty();
  }
}

export function unmount() {
  if (saveTimer) clearTimeout(saveTimer);
  if (statusTimer) clearTimeout(statusTimer);
  closeCollab();
  for (const off of cleanup) { try { typeof off === 'function' && off(); } catch { /* */ } }
  cleanup = [];
  ctxRef = null;
  currentNoteId = null;
  dirty = false;
  state.peers.clear();
}

/* ================================================================== 骨架 */

function shellHtml() {
  return `<div class="notes-layout" id="notes-layout">
    <aside class="notes-pane">
      <div class="notes-pane-head">
        <div class="search-box">
          <span class="sb-ico">${icon('search')}</span>
          <input class="input input-sm" id="note-search" placeholder="搜索笔记标题与内容…">
        </div>
        <div class="flex items-center gap-2">
          <button class="btn btn-sm btn-primary flex-1" data-note-action="new">${icon('plus')}新建笔记</button>
          <button class="btn btn-sm btn-default" data-note-action="sort" title="排序">${icon('sort')}</button>
          <button class="btn btn-sm btn-default" data-note-action="filter" title="筛选">${icon('filter')}</button>
        </div>
      </div>
      <div class="notes-scroll" id="notes-list">${skeleton(5)}</div>
    </aside>

    <section class="editor-pane">
      <div class="editor-head">
        <button class="icon-btn sm only-mobile" data-note-action="toggle-list" title="笔记列表">${icon('list')}</button>
        <input class="editor-title-input" id="note-title" placeholder="无标题笔记" disabled>
        <div class="save-state" id="save-state"><span class="ss-dot"></span><span id="save-text">未修改</span></div>
        <button class="btn btn-sm btn-default" data-note-action="side" title="详情与版本">${icon('history')}</button>
        <button class="btn btn-sm btn-default" data-note-action="more" title="更多">${icon('moreV')}</button>
      </div>
      <div class="editor-toolbar" id="editor-toolbar"></div>
      <div class="editor-scroll" id="editor-scroll">
        <div class="editor-body" id="editor-body" contenteditable="false" spellcheck="false" data-placeholder="开始记录你的想法…（支持 Markdown 风格的快捷输入）"></div>
      </div>
    </section>

    <aside class="editor-side" id="editor-side" hidden></aside>
  </div>`;
}

const TOOLBAR = [
  { cmd: 'bold', ico: 'bold', title: '加粗 (Ctrl+B)' },
  { cmd: 'italic', ico: 'italic', title: '斜体 (Ctrl+I)' },
  { cmd: 'underline', ico: 'underline', title: '下划线 (Ctrl+U)' },
  { cmd: 'strikeThrough', ico: 'strike', title: '删除线' },
  { sep: true },
  { block: 'h1', ico: 'h1', title: '一级标题' },
  { block: 'h2', ico: 'h2', title: '二级标题' },
  { block: 'p', ico: 'h3', title: '正文' },
  { sep: true },
  { cmd: 'insertUnorderedList', ico: 'ul', title: '无序列表' },
  { cmd: 'insertOrderedList', ico: 'ol', title: '有序列表' },
  { block: 'blockquote', ico: 'quote', title: '引用' },
  { action: 'code', ico: 'codeBlock', title: '代码块' },
  { action: 'table', ico: 'table', title: '插入表格' },
  { action: 'image', ico: 'image', title: '插入图片' },
  { action: 'link', ico: 'link', title: '插入链接' },
  { cmd: 'insertHorizontalRule', ico: 'divider', title: '分割线' },
  { sep: true },
  { action: 'tag', ico: 'tag', title: '编辑标签' },
  { cmd: 'removeFormat', ico: 'close', title: '清除格式' }
];

/* ================================================================== 列表 */

async function loadNotes(ctx) {
  const host = qs('#notes-list');
  if (!host) return;
  host.innerHTML = skeleton(5);
  try {
    const params = { workspaceId: state.workspaceId, limit: 300, sort: state.sort };
    if (state.folderId === 'root') params.folderId = 'root';
    else if (state.folderId !== 'all') params.folderId = state.folderId;
    if (state.query) params.q = state.query;
    if (state.filter === 'starred') params.starred = 1;
    if (state.filter === 'pinned') params.pinned = 1;
    const data = await ctx.api.notes(params);
    state.notes = data.notes || [];
    renderList(ctx);
  } catch (err) {
    host.innerHTML = `<div class="text-sm text-danger" style="padding:14px">加载失败：${esc(err.message)}</div>`;
  }
}

function renderList(ctx) {
  const host = qs('#notes-list');
  if (!host) return;
  if (!state.notes.length) {
    host.innerHTML = state.query
      ? emptyState({ iconName: 'search', title: '没有匹配的笔记', desc: `未找到包含「${esc(state.query)}」的笔记` })
      : emptyState({
        iconName: 'note', title: '还没有笔记',
        desc: '记录想法、会议纪要、读书笔记，支持图片、代码块与表格。',
        actions: canWrite() ? '<button class="btn btn-primary" data-note-action="new">新建笔记</button>' : ''
      });
    return;
  }

  host.innerHTML = state.notes.map((n) => `
    <div class="note-item${n.id === currentNoteId ? ' is-active' : ''}" data-note="${esc(n.id)}">
      <div class="note-item-top">
        ${n.pinned ? `<span class="pin-ico" style="width:12px;height:12px;color:var(--c-ink-400)">${icon('pinFill')}</span>` : ''}
        ${n.starred ? `<span style="width:12px;height:12px;color:#D97706">${icon('starFill')}</span>` : ''}
        <span class="note-item-title">${esc(n.emoji ? `${n.emoji} ` : '')}${esc(n.title)}</span>
      </div>
      <div class="note-item-excerpt">${esc(excerpt(n.text || '暂无内容', 72))}</div>
      <div class="note-item-foot">
        <span>${esc(timeAgo(n.updatedAt))}</span>
        <span>·</span>
        <span>${formatNumber(n.wordCount)} 字</span>
        <span class="spacer"></span>
        <span>${(n.tags || []).slice(0, 2).map((t) => tagHtml(t)).join('')}</span>
      </div>
    </div>`).join('');
}

/* ================================================================== 打开笔记 */

async function openNote(ctx, noteId) {
  if (dirty && currentNoteId && currentNoteId !== noteId) {
    await saveNow(ctx, { silent: true });
  }
  let data;
  try {
    data = await ctx.api.note(noteId);
  } catch (err) {
    notify.error(`无法打开笔记：${err.message}`);
    return;
  }
  state.active = data.note;
  state.versions = data.versions || [];
  currentNoteId = noteId;
  dirty = false;

  // 若通过 URL 打开，写回路由
  if (ctx.params?.[0] !== noteId) {
    history.replaceState(null, '', `#/notes/${noteId}`);
  }

  qs('#notes-layout')?.classList.remove('list-open');
  renderEditor(ctx);
  renderList(ctx);
  renderSide(ctx);
  connectCollab(ctx, noteId);
  applyIcons(qs('.editor-pane'));

  const body = qs('#editor-body');
  if (body) body.focus();
}

function renderEditorEmpty() {
  const title = qs('#note-title');
  const body = qs('#editor-body');
  if (title) { title.value = ''; title.disabled = true; }
  if (body) {
    body.contentEditable = 'false';
    body.innerHTML = '';
  }
  qs('#editor-toolbar').innerHTML = '';
  setSaveState('idle', '未选择笔记');
}

function renderEditor(ctx) {
  const n = state.active;
  if (!n) return renderEditorEmpty();

  const title = qs('#note-title');
  title.disabled = !canWrite();
  title.value = n.title;

  const body = qs('#editor-body');
  body.contentEditable = canWrite() ? 'true' : 'false';
  body.innerHTML = n.html || '';
  body.setAttribute('data-placeholder', '开始记录你的想法…');

  renderToolbar(ctx);
  setSaveState('idle', dirty ? '未保存' : `已保存 · ${timeAgo(n.updatedAt)}`);
}

function renderToolbar(ctx) {
  const host = qs('#editor-toolbar');
  if (!host) return;
  const disabled = !canWrite();
  host.innerHTML = TOOLBAR.map((t) => {
    if (t.sep) return '<span class="tb-sep"></span>';
    return `<button class="tb-btn" data-tool="${t.cmd || t.block || t.action}" data-kind="${t.cmd ? 'cmd' : t.block ? 'block' : 'action'}" title="${esc(t.title)}" ${disabled ? 'disabled' : ''}>${icon(t.ico)}</button>`;
  }).join('');
  applyIcons(host);
}

/* ================================================================== 编辑器事件 */

function bindShell(container, ctx) {
  const titleInput = qs('#note-title');
  const body = qs('#editor-body');
  const searchInput = qs('#note-search');

  const onTitle = () => { markDirty(ctx); };
  titleInput.addEventListener('input', onTitle);
  cleanup.push(() => titleInput.removeEventListener('input', onTitle));

  const onBodyInput = () => { markDirty(ctx); };
  body.addEventListener('input', onBodyInput);
  cleanup.push(() => body.removeEventListener('input', onBodyInput));

  // 粘贴：净化 + 保留纯文本回退
  const onPaste = (e) => {
    e.preventDefault();
    const html = e.clipboardData?.getData('text/html');
    const text = e.clipboardData?.getData('text/plain') || '';
    if (html) {
      const clean = sanitizePasted(html);
      document.execCommand('insertHTML', false, clean);
    } else {
      document.execCommand('insertText', false, text);
    }
    markDirty(ctx);
  };
  body.addEventListener('paste', onPaste);
  cleanup.push(() => body.removeEventListener('paste', onPaste));

  // 键盘快捷键
  const onKey = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(ctx, { createVersion: true }); return; }
    if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); exec('bold'); return; }
    if (mod && e.key.toLowerCase() === 'i') { e.preventDefault(); exec('italic'); return; }
    if (mod && e.key.toLowerCase() === 'u') { e.preventDefault(); exec('underline'); return; }
    if (mod && e.key === 'k') { e.preventDefault(); insertLink(); return; }
    if (e.key === 'Tab' && document.activeElement === body) {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
      markDirty(ctx);
    }
  };
  body.addEventListener('keydown', onKey);
  cleanup.push(() => body.removeEventListener('keydown', onKey));

  // 工具栏
  const offTool = on(qs('#editor-toolbar'), 'click', '[data-tool]', async (e, node) => {
    if (!canWrite()) return;
    const kind = node.getAttribute('data-kind');
    const value = node.getAttribute('data-tool');
    body.focus();
    if (kind === 'cmd') { exec(value); }
    else if (kind === 'block') { exec('formatBlock', value); }
    else await runAction(ctx, value);
    markDirty(ctx);
  });
  cleanup.push(offTool);

  // 工具栏激活态
  const syncToolbar = () => {
    try {
      for (const cmd of ['bold', 'italic', 'underline', 'strikeThrough', 'insertUnorderedList', 'insertOrderedList']) {
        const active = document.queryCommandState(cmd);
        const btn = qs(`[data-tool="${cmd}"]`);
        if (btn) btn.classList.toggle('is-active', active);
      }
    } catch { /* 忽略 */ }
  };
  const onSel = () => { if (document.activeElement === body || body.contains(document.activeElement)) syncToolbar(); };
  document.addEventListener('selectionchange', onSel);
  cleanup.push(() => document.removeEventListener('selectionchange', onSel));

  // 顶部操作
  const offActions = on(container, 'click', '[data-note-action]', async (e, node) => {
    const act = node.getAttribute('data-note-action');
    if (act === 'new') await newNote(ctx);
    else if (act === 'sort') openSortMenu(ctx, node);
    else if (act === 'filter') openFilterMenu(ctx, node);
    else if (act === 'toggle-list') qs('#notes-layout')?.classList.toggle('list-open');
    else if (act === 'side') toggleSide(ctx);
    else if (act === 'more') openNoteMenu(ctx, node);
  });
  cleanup.push(offActions);

  // 笔记列表
  const offList = on(qs('#notes-list'), 'click', '[data-note]', (e, node) => {
    if (e.target.closest('[data-note-menu]')) return;
    openNote(ctx, node.getAttribute('data-note'));
  });
  cleanup.push(offList);
  const offListMenu = on(qs('#notes-list'), 'contextmenu', '[data-note]', (e, node) => {
    openListItemMenu(ctx, node.getAttribute('data-note'), node, e);
  });
  cleanup.push(offListMenu);

  // 搜索
  const doSearch = debounce(() => {
    state.query = searchInput.value.trim();
    loadNotes(ctx);
  }, 280);
  searchInput.addEventListener('input', doSearch);
  cleanup.push(() => searchInput.removeEventListener('input', doSearch));

  // 全局事件
  const onNew = () => newNote(ctx);
  const onSaveReq = () => saveNow(ctx, { createVersion: true });
  const onRealtime = (e) => {
    const p = e.detail;
    if (!p) return;
    if (p.type === 'note.updated' && p.noteId === currentNoteId && p.userName) {
      // 他人保存了当前笔记
      if (!dirty) openNote(ctx, currentNoteId);
    }
    if (['note.created', 'note.deleted'].includes(p.type)) loadNotes(ctx);
  };
  document.addEventListener('kbpro:new-note', onNew);
  document.addEventListener('kbpro:save-note', onSaveReq);
  document.addEventListener('kbpro:realtime', onRealtime);
  cleanup.push(() => document.removeEventListener('kbpro:new-note', onNew));
  cleanup.push(() => document.removeEventListener('kbpro:save-note', onSaveReq));
  cleanup.push(() => document.removeEventListener('kbpro:realtime', onRealtime));

  // 链接点击拦截
  body.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a && a.href) { e.preventDefault(); window.open(a.href, '_blank', 'noopener'); }
  });
}

function sanitizePasted(html) {
  const div = document.createElement('div');
  div.innerHTML = html;
  div.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((n) => n.remove());
  div.querySelectorAll('*').forEach((node) => {
    [...node.attributes].forEach((attr) => {
      if (/^on/i.test(attr.name)) node.removeAttribute(attr.name);
      if (attr.name === 'style' && /expression|javascript:/i.test(attr.value)) node.removeAttribute('style');
    });
  });
  return div.innerHTML;
}

function exec(cmd, value = null) {
  try {
    document.execCommand('styleWithCSS', false, false);
  } catch { /* 部分浏览器不支持 */ }
  try {
    document.execCommand(cmd, false, value);
  } catch {
    notify.warn('当前浏览器不支持该格式操作');
  }
}

/* ================================================================== 编辑器动作 */

async function runAction(ctx, action) {
  if (action === 'code') {
    const sel = window.getSelection();
    const text = sel && sel.toString() ? sel.toString() : '// 在此输入代码';
    const html = `<pre><code>${esc(text)}</code></pre><p><br></p>`;
    document.execCommand('insertHTML', false, html);
    return;
  }
  if (action === 'table') {
    const rows = 3, cols = 3;
    let html = '<table><thead><tr>';
    for (let c = 0; c < cols; c++) html += `<th>列 ${c + 1}</th>`;
    html += '</tr></thead><tbody>';
    for (let r = 1; r < rows; r++) {
      html += '<tr>';
      for (let c = 0; c < cols; c++) html += '<td>&nbsp;</td>';
      html += '</tr>';
    }
    html += '</tbody></table><p><br></p>';
    document.execCommand('insertHTML', false, html);
    return;
  }
  if (action === 'image') {
    const files = await pickFiles({ accept: 'image/*', multiple: false });
    if (!files?.length) return;
    const file = files[0];
    if (file.size > 8 * 1024 * 1024) { notify.warn('图片不能超过 8 MB'); return; }
    notify.info('正在上传图片…', { duration: 1500 });
    try {
      const res = await ctx.api.uploadAsset(file, { workspaceId: state.workspaceId, noteId: currentNoteId });
      const url = res.assets?.[0]?.url || res.url;
      if (!url) throw new Error('上传未返回地址');
      document.execCommand('insertHTML', false, `<img src="${esc(url)}" alt="${esc(file.name)}">`);
      markDirty(ctx);
      notify.success('图片已插入');
    } catch (err) {
      notify.error(`图片上传失败：${err.message}`);
    }
    return;
  }
  if (action === 'link') { await insertLink(); return; }
  if (action === 'tag') { await editTags(ctx); return; }
}

async function insertLink() {
  const url = await promptDialog({ title: '插入链接', label: '网址', placeholder: 'https://' });
  if (!url) return;
  const text = window.getSelection()?.toString() || url;
  const safe = /^(https?:|mailto:|tel:)/i.test(url) ? url : `https://${url}`;
  document.execCommand('insertHTML', false, `<a href="${esc(safe)}" target="_blank" rel="noopener">${esc(text)}</a>`);
}

function markDirty(ctx) {
  dirty = true;
  setSaveState('saving', '编辑中…');
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveNow(ctx, {}), 900);
}

function setSaveState(kind, text) {
  const host = qs('#save-state');
  const label = qs('#save-text');
  if (!host || !label) return;
  host.classList.remove('is-saving', 'is-saved', 'is-error');
  if (kind === 'saving') host.classList.add('is-saving');
  else if (kind === 'saved') host.classList.add('is-saved');
  else if (kind === 'error') host.classList.add('is-error');
  label.textContent = text;
}

async function saveNow(ctx, { createVersion = false, silent = false } = {}) {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  if (!currentNoteId || !state.active || !dirty) {
    if (!silent && !dirty) toast('没有需要保存的修改', { type: 'info', duration: 1400 });
    return state.active;
  }
  if (!canWrite()) { setSaveState('error', '无编辑权限'); return state.active; }

  const title = qs('#note-title')?.value ?? state.active.title;
  const html = qs('#editor-body')?.innerHTML ?? state.active.html;

  setSaveState('saving', '保存中…');
  try {
    const res = await ctx.api.saveNote(currentNoteId, { title, html, createVersion });
    state.active = res.note;
    dirty = false;
    setSaveState('saved', `已保存 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    const idx = state.notes.findIndex((n) => n.id === res.note.id);
    if (idx >= 0) state.notes[idx] = { ...state.notes[idx], ...res.note };
    renderList(ctx);
    if (createVersion || state.sideOpen) {
      const v = await ctx.api.noteVersions(currentNoteId);
      state.versions = v.versions || [];
      renderSide(ctx);
    }
    if (!silent) {
      // 广播协作状态
      ctx.api.collabPatch('note', currentNoteId, { version: res.version }).catch(() => {});
    }
    return res.note;
  } catch (err) {
    setSaveState('error', `保存失败：${err.message}`);
    notify.error(`保存失败：${err.message}`);
    return state.active;
  }
}

/* ================================================================== 新建 / 删除 */

async function newNote(ctx) {
  if (!canWrite()) { notify.warn('当前知识库没有编辑权限'); return; }
  if (dirty) await saveNow(ctx, { silent: true });
  try {
    const folderId = state.folderId !== 'all' && state.folderId !== 'root' ? state.folderId : null;
    const res = await ctx.api.createNote({
      workspaceId: state.workspaceId, folderId,
      title: '未命名笔记', html: '<p><br></p>'
    });
    await loadNotes(ctx);
    await openNote(ctx, res.note.id);
    const titleInput = qs('#note-title');
    titleInput?.focus();
    titleInput?.select();
  } catch (err) {
    notify.error(err.message);
  }
}

function openNoteMenu(ctx, anchor) {
  const n = state.active;
  if (!n) return;
  const items = [
    { icon: 'edit', label: '重命名', disabled: !canWrite(), onClick: async () => {
      const t = await promptDialog({ title: '重命名笔记', label: '标题', value: n.title });
      if (!t) return;
      qs('#note-title').value = t;
      markDirty(ctx);
      await saveNow(ctx, { createVersion: true });
      notify.success('已重命名');
    } },
    { icon: 'tag', label: '编辑标签', onClick: () => editTags(ctx) },
    { icon: 'folder', label: '移动到文件夹', disabled: !canWrite(), onClick: () => moveNoteDialog(ctx) },
    { icon: n.starred ? 'star' : 'starFill', label: n.starred ? '取消收藏' : '收藏', onClick: () => toggleNoteFlag(ctx, 'starred') },
    { icon: 'pin', label: n.pinned ? '取消置顶' : '置顶', onClick: () => toggleNoteFlag(ctx, 'pinned') },
    { sep: true },
    { icon: 'copy', label: '创建副本', onClick: async () => {
      try {
        const r = await ctx.api.duplicateNote(n.id);
        notify.success('已创建副本');
        await loadNotes(ctx);
        await openNote(ctx, r.note.id);
      } catch (err) { notify.error(err.message); }
    } },
    { icon: 'history', label: '查看历史版本', onClick: () => { state.sideTab = 'versions'; state.sideOpen = true; renderSide(ctx); } },
    { sep: true },
    { icon: 'download', label: '导出为 Markdown', onClick: () => downloadUrl(ctx.api.noteExportUrl(n.id, 'md'), `${n.title}.md`) },
    { icon: 'external', label: '导出为 HTML', onClick: () => downloadUrl(ctx.api.noteExportUrl(n.id, 'html'), `${n.title}.html`) },
    { sep: true },
    { icon: 'trash', label: '删除笔记', danger: true, disabled: !canWrite(), onClick: () => deleteNote(ctx, n) }
  ];
  dropdown(anchor, items, { align: 'end', width: 226 });
}

function openListItemMenu(ctx, noteId, anchor, event) {
  const n = state.notes.find((x) => x.id === noteId);
  if (!n) return;
  const items = [
    { icon: 'note', label: '打开', onClick: () => openNote(ctx, noteId) },
    { icon: 'edit', label: '重命名', disabled: !canWrite(), onClick: async () => {
      const t = await promptDialog({ title: '重命名笔记', label: '标题', value: n.title });
      if (!t) return;
      try {
        await ctx.api.saveNote(noteId, { title: t });
        notify.success('已重命名');
        await loadNotes(ctx);
      } catch (err) { notify.error(err.message); }
    } },
    { icon: n.starred ? 'star' : 'starFill', label: n.starred ? '取消收藏' : '收藏', onClick: async () => {
      await ctx.api.batchNotes(n.starred ? 'unstar' : 'star', [noteId]);
      await loadNotes(ctx);
    } },
    { icon: 'pin', label: n.pinned ? '取消置顶' : '置顶', onClick: async () => {
      await ctx.api.batchNotes(n.pinned ? 'unpin' : 'pin', [noteId]);
      await loadNotes(ctx);
    } },
    { sep: true },
    { icon: 'trash', label: '删除', danger: true, disabled: !canWrite(), onClick: () => deleteNote(ctx, n) }
  ];
  if (event) contextMenu(event, items);
  else dropdown(anchor, items, { align: 'end' });
}

async function deleteNote(ctx, n) {
  const ok = await confirmDialog({
    title: '删除笔记',
    message: `确定要删除《${esc(n.title)}》吗？<br><span class="text-muted">笔记将移入回收站，可随时恢复。</span>`,
    confirmText: '移入回收站',
    danger: true
  });
  if (!ok) return;
  try {
    await ctx.api.deleteNote(n.id);
    notify.success('已移入回收站', {
      action: '撤销',
      onAction: async () => {
        try { await ctx.api.restoreNote(n.id); notify.success('已恢复'); await loadNotes(ctx); }
        catch (err) { notify.error(err.message); }
      }
    });
    if (currentNoteId === n.id) {
      currentNoteId = null;
      state.active = null;
      renderEditorEmpty();
    }
    await loadNotes(ctx);
    if (!currentNoteId && state.notes.length) await openNote(ctx, state.notes[0].id);
  } catch (err) { notify.error(err.message); }
}

async function toggleNoteFlag(ctx, key) {
  const n = state.active;
  if (!n) return;
  try {
    await ctx.api.batchNotes(n[key] ? (key === 'starred' ? 'unstar' : 'unpin') : (key === 'starred' ? 'star' : 'pin'), [n.id]);
    await openNote(ctx, n.id);
  } catch (err) { notify.error(err.message); }
}

async function editTags(ctx) {
  const n = state.active;
  if (!n) return;
  const { tagInput } = await import('../ui.js');
  let existing = [];
  try { existing = (await ctx.api.tags(state.workspaceId)).tags || []; } catch { /* */ }
  const input = tagInput({ value: n.tags || [], suggestions: existing });
  const m = modal({
    title: '编辑标签',
    size: 'sm',
    body: '<div class="field" style="margin-bottom:0"><label>标签</label></div>',
    actions: [
      { label: '取消' },
      {
        label: '保存', primary: true, keepOpen: true,
        onClick: async (close, btn) => {
          btn.disabled = true;
          try {
            await ctx.api.saveNote(n.id, { tags: input.value });
            close();
            notify.success('标签已更新');
            await openNote(ctx, n.id);
            await loadNotes(ctx);
          } catch (err) { notify.error(err.message); }
          finally { btn.disabled = false; }
        }
      }
    ]
  });
  const field = qs('.field', m.body);
  field.appendChild(input.el);
  if (input.el._suggestHost) field.appendChild(input.el._suggestHost);
  input.focus();
}

async function moveNoteDialog(ctx) {
  const n = state.active;
  if (!n) return;
  const folders = await ctx.api.folders(state.workspaceId).catch(() => ({ tree: [] }));
  const options = flattenTree(folders.tree);
  const m = modal({
    title: '移动笔记',
    size: 'sm',
    body: `<div class="field" style="margin-bottom:0"><label>目标文件夹</label>
      <select class="select" data-field="target">
        <option value="">未分类（根目录）</option>
        ${options.map((o) => `<option value="${esc(o.id)}"${o.id === n.folderId ? ' selected' : ''}>${esc('　'.repeat(o.depth) + o.name)}</option>`).join('')}
      </select></div>`,
    actions: [
      { label: '取消' },
      {
        label: '移动', primary: true, keepOpen: true,
        onClick: async (close, btn) => {
          btn.disabled = true;
          try {
            await ctx.api.saveNote(n.id, { folderId: qs('[data-field="target"]', m.body).value || null });
            close();
            notify.success('已移动');
            await openNote(ctx, n.id);
            await loadNotes(ctx);
          } catch (err) { notify.error(err.message); }
          finally { btn.disabled = false; }
        }
      }
    ]
  });
}

function flattenTree(tree, depth = 0, out = []) {
  for (const node of tree) {
    out.push({ id: node.id, name: node.name, depth });
    flattenTree(node.children || [], depth + 1, out);
  }
  return out;
}

/* ================================================================== 侧栏 */

function toggleSide(ctx) {
  state.sideOpen = !state.sideOpen;
  renderSide(ctx);
}

function renderSide(ctx) {
  const host = qs('#editor-side');
  const layout = qs('#notes-layout');
  if (!host || !layout) return;
  host.hidden = !state.sideOpen;
  layout.classList.toggle('with-side', state.sideOpen);
  if (!state.sideOpen) return;

  const n = state.active;
  if (!n) { host.innerHTML = ''; return; }

  host.innerHTML = `
    <div class="side-tabs">
      <button class="side-tab${state.sideTab === 'info' ? ' is-active' : ''}" data-side="info">详情</button>
      <button class="side-tab${state.sideTab === 'versions' ? ' is-active' : ''}" data-side="versions">版本 ${state.versions.length}</button>
    </div>
    <div class="side-body" id="side-body"></div>`;

  const body = qs('#side-body', host);
  if (state.sideTab === 'info') {
    body.innerHTML = `
      <div class="flex-col gap-4">
        <div>
          <div class="text-xs text-muted mb-2">表情</div>
          <div class="flex flex-wrap gap-1">${['', '📌', '📝', '💡', '📚', '✅', '🔥', '⭐', '🧠', '🎯'].map((e) =>
            `<button class="btn btn-sm ${n.emoji === e ? 'btn-primary' : 'btn-default'}" data-emoji="${e}" style="min-width:30px">${e || '无'}</button>`).join('')}</div>
        </div>
        <div><div class="text-xs text-muted mb-2">标签</div>
          <div class="flex flex-wrap gap-1">${(n.tags || []).length ? n.tags.map((t) => tagHtml(t)).join('') : '<span class="text-sm text-muted">暂无标签</span>'}</div>
          <button class="btn btn-sm btn-default mt-2" data-side-act="tags">编辑标签</button>
        </div>
        <div><div class="text-xs text-muted mb-2">统计</div>
          <dl class="kv"><dt>字数</dt><dd>${formatNumber(n.wordCount)}</dd>
            <dt>阅读</dt><dd>约 ${n.readMinutes || Math.max(1, Math.round(n.wordCount / 380))} 分钟</dd>
            <dt>版本</dt><dd>v${n.version}</dd>
            <dt>创建</dt><dd>${esc(formatDateTime(n.createdAt))}</dd>
            <dt>更新</dt><dd>${esc(formatDateTime(n.updatedAt))}</dd></dl>
        </div>
        <div><div class="text-xs text-muted mb-2">操作</div>
          <div class="flex-col gap-2">
            <button class="btn btn-sm btn-default" data-side-act="save-version">${icon('history')}保存为一个版本</button>
            <button class="btn btn-sm btn-default" data-side-act="move">${icon('move')}移动到文件夹</button>
            <button class="btn btn-sm btn-default" data-side-act="export">${icon('download')}导出 Markdown</button>
          </div>
        </div>
      </div>`;
    applyIcons(body);
  } else {
    body.innerHTML = state.versions.length
      ? state.versions.map((v) => `<div class="ver-item${v.version === n.version ? ' is-current' : ''}" data-ver="${v.version}">
          <div class="ver-top"><span>v${v.version}</span>
            ${v.version === n.version ? '<span class="badge badge-success">当前</span>' : `<button class="btn btn-sm btn-ghost" data-restore="${v.version}">恢复</button>`}
          </div>
          <div class="ver-sub">${esc(formatDateTime(v.created_at))} · ${formatNumber(v.chars || 0)} 字</div>
          ${v.summary ? `<div class="ver-sub">${esc(v.summary)}</div>` : ''}
          ${v.editor_name ? `<div class="ver-sub">编辑者：${esc(v.editor_name)}</div>` : ''}
        </div>`).join('')
      : '<div class="text-sm text-muted">暂无历史版本。每次内容变化会自动留存快照。</div>';
  }

  on(host, 'click', '[data-side]', (e, node) => {
    state.sideTab = node.getAttribute('data-side');
    renderSide(ctx);
  });
  on(host, 'click', '[data-emoji]', async (e, node) => {
    try {
      await ctx.api.saveNote(n.id, { emoji: node.getAttribute('data-emoji') });
      await openNote(ctx, n.id);
    } catch (err) { notify.error(err.message); }
  });
  on(host, 'click', '[data-side-act]', async (e, node) => {
    const act = node.getAttribute('data-side-act');
    if (act === 'tags') await editTags(ctx);
    else if (act === 'move') await moveNoteDialog(ctx);
    else if (act === 'save-version') {
      dirty = true;
      await saveNow(ctx, { createVersion: true });
      notify.success('已保存为新版本');
    } else if (act === 'export') downloadUrl(ctx.api.noteExportUrl(n.id, 'md'), `${n.title}.md`);
  });
  on(host, 'click', '[data-restore]', async (e, node) => {
    const v = node.getAttribute('data-restore');
    const ok = await confirmDialog({
      title: `恢复到 v${v}`,
      message: '当前内容会先被保存为一个新版本，然后替换为所选版本的内容。',
      confirmText: '恢复'
    });
    if (!ok) return;
    try {
      await ctx.api.restoreNoteVersion(n.id, v);
      notify.success(`已恢复到 v${v}`);
      await openNote(ctx, n.id);
    } catch (err) { notify.error(err.message); }
  });
  on(host, 'click', '[data-ver]', async (e, node) => {
    if (e.target.closest('[data-restore]')) return;
    const v = node.getAttribute('data-ver');
    if (String(v) === String(n.version)) return;
    try {
      const data = await ctx.api.noteVersion(n.id, v);
      showVersionPreview(n, data.version, ctx);
    } catch (err) { notify.error(err.message); }
  });
}

function showVersionPreview(note, version, ctx) {
  modal({
    title: `v${version.version} · ${version.title}`,
    sub: `${formatDateTime(version.createdAt)} · ${formatNumber(version.chars)} 字`,
    size: 'lg',
    body: `<div class="preview-doc" style="padding:0;max-width:none">${version.html}</div>`,
    actions: [
      { label: '关闭' },
      {
        label: '恢复此版本', primary: true, keepOpen: true,
        onClick: async (close) => {
          try {
            await ctx.api.restoreNoteVersion(note.id, version.version);
            close();
            notify.success(`已恢复到 v${version.version}`);
            await openNote(ctx, note.id);
          } catch (err) { notify.error(err.message); }
        }
      }
    ]
  });
}

/* ================================================================== 排序/筛选 */

function openSortMenu(ctx, anchor) {
  const opts = [['updated', '最近更新'], ['created', '创建时间'], ['title', '标题'], ['words', '字数']];
  dropdown(anchor, [
    { label: '排序', header: true },
    ...opts.map(([k, label]) => ({
      label, active: state.sort === k,
      onClick: () => { state.sort = k; loadNotes(ctx); }
    }))
  ], { align: 'end', width: 172 });
}

function openFilterMenu(ctx, anchor) {
  const opts = [['all', '全部笔记'], ['starred', '仅收藏'], ['pinned', '仅置顶']];
  dropdown(anchor, [
    { label: '筛选', header: true },
    ...opts.map(([k, label]) => ({
      label, active: state.filter === k,
      onClick: () => { state.filter = k; loadNotes(ctx); }
    }))
  ], { align: 'end', width: 168 });
}

/* ================================================================== 协作 */

function connectCollab(ctx, noteId) {
  closeCollab();
  try {
    collabSource = ctx.api.collabStream('note', noteId);
    collabSource.addEventListener('presence', (e) => {
      try {
        const p = JSON.parse(e.data);
        if (p.userId) state.peers.set(p.userId, p);
      } catch { /* */ }
    });
    collabSource.addEventListener('note.patch', (e) => {
      try {
        const p = JSON.parse(e.data);
        if (p.userId) {
          state.peers.set(p.userId, { userId: p.userId, name: p.userName, at: p.at });
          showPeers();
        }
      } catch { /* */ }
    });
    collabSource.addEventListener('lock', (e) => {
      try {
        const p = JSON.parse(e.data);
        if (p.userName) toast(`${p.userName} 正在编辑此笔记`, { type: 'info', duration: 2400 });
      } catch { /* */ }
    });
    collabSource.addEventListener('error', () => { /* EventSource 自动重连 */ });
  } catch { /* 忽略 */ }
}

function showPeers() {
  const host = qs('#save-state');
  if (!host) return;
  const peers = [...state.peers.values()].filter((p) => p.userId !== getState().user?.id);
  const existing = qs('#peer-indicator');
  if (!peers.length) { existing?.remove(); return; }
  const label = `${peers.length} 人正在查看`;
  if (existing) { existing.querySelector('span').textContent = label; return; }
  const node = el(`<span id="peer-indicator" class="flex items-center gap-1 text-xs text-muted" title="${esc(peers.map((p) => p.name).join('、'))}" style="margin-left:8px">
    ${icon('users', 13)}<span>${esc(label)}</span></span>`);
  host.after(node);
}

function closeCollab() {
  if (collabSource) { try { collabSource.close(); } catch { /* */ } collabSource = null; }
  qs('#peer-indicator')?.remove();
}

export default { meta, mount, unmount };
