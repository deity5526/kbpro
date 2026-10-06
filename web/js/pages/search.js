/**
 * KBPRO — 全局检索
 *
 * 旗舰检索页：关键词 / 标签 / 语义 / 模糊，多知识库范围、结果操作与分页。
 * 结构参考 pages/dashboard.js：模板字符串 + el() + 委托 on()，无额外抽象。
 */
import {
  qs, qsa, el, on, icon, notify, dropdown, copyText, closeAllDropdowns,
  esc, emptyState, skeleton, timeAgo, formatBytes, formatNumber,
  fileIconHtml, debounce, highlightText
} from '../ui.js';

export const meta = { title: '全局检索', icon: 'search' };

/* ------------------------------------------------------------------ 常量 */

const PAGE_SIZE = 20;
const RECENT_DAYS = 7;
const TAG_CHIP_LIMIT = 12;

const TYPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'file', label: '文档' },
  { value: 'note', label: '笔记' }
];

const MODE_OPTIONS = [
  { value: 'hybrid', label: '智能混合' },
  { value: 'keyword', label: '关键词' },
  { value: 'vector', label: '语义向量' },
  { value: 'fuzzy', label: '模糊匹配' }
];

const MODE_LABELS = {
  hybrid: '混合检索',
  keyword: '关键词检索',
  vector: '语义向量检索',
  fuzzy: '模糊匹配'
};

const TIPS = [
  { icon: 'search', title: '关键词', desc: '直接输入词语，同时匹配标题、正文与笔记内容。' },
  { icon: 'tag', title: '标签', desc: '点击标签缩小范围，可与关键词组合使用。' },
  { icon: 'sparkle', title: '语义向量', desc: '切换「语义向量」按含义检索，不必逐字一致。' },
  { icon: 'filter', title: '内容模糊', desc: '记不清原文时切换「模糊匹配」，容忍错别字。' }
];

/* ------------------------------------------------------------------ 模块状态 */

let cleanup = [];
let dom = {};
let ctxRef = null;

let state = initialState();
let items = [];            // 已加载并展示的结果（已应用本地时间筛选）
let total = 0;             // 服务端总命中数
let serverOffset = 0;      // 已请求到的服务端偏移
let hasMore = false;
let lastMeta = { terms: [], mode: 'hybrid', took: 0, vectorUsed: 0 };
let loading = false;
let runId = 0;
let controller = null;
let folderMaps = new Map();   // workspaceId -> Map(folderId, { name, path })
let folderRequests = new Set();
let initialCache = { loaded: false, failed: false, tags: [], recent: [] };
let tagList = [];
let debouncedRun = null;
let focusTimer = null;

function initialState() {
  return {
    q: '',
    tags: [],
    types: 'all',
    mode: 'hybrid',
    scope: 'current',
    starred: false,
    folderId: '',
    since: 0,
    showAllTags: false
  };
}

/** 从 URL query 还原筛选状态 */
function readState(query = {}) {
  const next = initialState();
  next.q = String(query.q || '');
  next.tags = String(query.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  next.types = TYPE_OPTIONS.some((o) => o.value === query.types) ? query.types : 'all';
  next.mode = MODE_LABELS[query.mode] ? query.mode : 'hybrid';
  next.scope = query.scope === 'all' ? 'all' : 'current';
  next.starred = query.starred === '1' || query.starred === 'true';
  next.folderId = String(query.folderId || '');
  return next;
}

/** 当前筛选状态 URL query（null/空值由 navigate 自动丢弃） */
function urlQuery() {
  const out = {};
  const q = state.q.trim();
  if (q) out.q = q;
  if (state.tags.length) out.tags = state.tags.join(',');
  if (state.types !== 'all') out.types = state.types;
  if (state.mode !== 'hybrid') out.mode = state.mode;
  if (state.scope === 'all') out.scope = 'all';
  if (state.starred) out.starred = '1';
  if (state.folderId) out.folderId = state.folderId;
  return out;
}

function syncUrl() {
  if (!ctxRef) return;
  ctxRef.navigate('search', [], urlQuery());
}

/* ================================================================== 挂载 */

export async function mount(container, ctx) {
  ctxRef = ctx;
  cleanup = [];
  dom = {};
  state = readState(ctx.query);
  items = [];
  total = 0;
  serverOffset = 0;
  hasMore = false;
  loading = false;
  runId = 0;
  controller = null;
  folderMaps = new Map();
  folderRequests = new Set();
  initialCache = { loaded: false, failed: false, tags: [], recent: [] };
  tagList = [];
  lastMeta = { terms: [], mode: state.mode, took: 0, vectorUsed: 0 };

  const { workspace } = ctx;
  if (!workspace) {
    container.innerHTML = `<div class="page">${emptyState({
      iconName: 'layers',
      title: '还没有知识库',
      desc: '请先在左上角创建一个知识库，再开始检索。'
    })}</div>`;
    return;
  }

  container.innerHTML = `<div class="search-page">
    <section class="search-hero">
      <div class="search-big">
        <span class="sb-ico">${icon('search', 18)}</span>
        <input id="search-input" type="text" spellcheck="false" autocomplete="off"
               aria-label="检索关键词" placeholder="搜索文档、笔记、标签或正文内容…"
               value="${esc(state.q)}">
        <button class="icon-btn sm" id="search-clear" type="button" aria-label="清空关键词"${state.q ? '' : ' hidden'}>${icon('close', 14)}</button>
      </div>
      <div class="filters" id="search-quick"></div>
      <div class="filters" id="search-filters"></div>
      <div class="filters" id="search-tagrow"></div>
    </section>
    <div id="search-body"></div>
  </div>`;

  dom = {
    input: qs('#search-input', container),
    clear: qs('#search-clear', container),
    quick: qs('#search-quick', container),
    filters: qs('#search-filters', container),
    tagRow: qs('#search-tagrow', container),
    body: qs('#search-body', container)
  };

  debouncedRun = debounce(() => {
    if (!ctxRef) return;
    if (state.q.trim()) runSearch();
    else renderInitial();
  }, 260);

  renderQuickFilters();
  renderMainFilters();
  renderTagFilters();
  bind(container, ctx);

  // 后台补齐筛选项与初始面板；失败不影响主流程
  void loadFilterSources(workspace.id);
  void loadInitialPanel(workspace.id);

  if (state.q.trim()) await runSearch();
  else renderInitial();

  focusTimer = setTimeout(() => {
    focusTimer = null;
    if (!dom.input || !dom.input.isConnected) return;
    const active = document.activeElement;
    const isField = !!active && (/^(input|textarea|select)$/i.test(active.tagName) || active.isContentEditable);
    if (!isField || container.contains(active)) dom.input.focus();
  }, 50);
}

export function unmount() {
  for (const off of cleanup) {
    try { if (typeof off === 'function') off(); } catch { /* 忽略单个解绑失败 */ }
  }
  cleanup = [];

  if (debouncedRun && typeof debouncedRun.cancel === 'function') debouncedRun.cancel();
  debouncedRun = null;
  if (focusTimer) { clearTimeout(focusTimer); focusTimer = null; }
  if (controller) {
    try { controller.abort(); } catch { /* 已结束 */ }
    controller = null;
  }
  closeAllDropdowns();

  runId++;
  loading = false;
  dom = {};
  ctxRef = null;
  items = [];
  total = 0;
  tagList = [];
  folderMaps = new Map();
  folderRequests = new Set();
}

/* ================================================================== 筛选栏 */

function renderQuickFilters() {
  dom.quick.innerHTML = `
    <span class="text-xs text-muted">快捷筛选</span>
    <span class="chip chip-btn" data-quick="recent7" title="仅看最近 7 天更新的文档">${icon('clock', 12)}最近 7 天更新的文档</span>
    <span class="chip chip-btn" data-quick="starred" title="仅看已收藏内容">${icon('star', 12)}我收藏的</span>
    <span class="chip chip-btn" data-quick="alltags" title="展开全部标签">${icon('tag', 12)}全部标签</span>
    <button class="btn btn-sm btn-ghost ml-auto" type="button" data-clear-filters>${icon('refresh', 13)}<span>清除筛选</span></button>
    <span class="text-xs text-muted" style="width:100%">按 ${kbd('/')} 聚焦搜索框，${kbd('Esc')} 清空关键词</span>`;
}

function kbd(text) {
  return `<span style="font-size:10.5px;font-weight:600;font-family:var(--font-mono);background:var(--c-ink-100);color:var(--c-text-3);border-radius:4px;padding:1px 5px">${esc(text)}</span>`;
}

function renderMainFilters() {
  dom.filters.innerHTML = `
    <span class="segmented" role="group" aria-label="内容类型">
      ${TYPE_OPTIONS.map((o) => `<button type="button" data-type="${o.value}">${esc(o.label)}</button>`).join('')}
    </span>
    <span class="segmented" role="group" aria-label="检索模式">
      ${MODE_OPTIONS.map((o) => `<button type="button" data-mode="${o.value}">${esc(o.label)}</button>`).join('')}
    </span>
    <span class="segmented" role="group" aria-label="知识库范围">
      <button type="button" data-scope="current">当前知识库</button>
      <button type="button" data-scope="all">全部知识库</button>
    </span>
    <span class="chip chip-btn" data-starred title="仅看已收藏内容">${icon('star', 12)}仅收藏</span>
    <select class="select input-sm" id="search-folder" aria-label="按文件夹筛选" style="max-width:200px">
      <option value="">全部文件夹</option>
    </select>`;
}

function renderTagFilters() {
  if (!dom.tagRow) return;

  const clearBtn = state.tags.length
    ? `<button class="btn btn-sm btn-ghost" type="button" data-clear-tags>${icon('close', 12)}<span>清除标签</span></button>`
    : '';

  if (!tagList.length) {
    // 标签清单不可用时，仍要让来自 URL 的标签可见、可清除
    dom.tagRow.innerHTML = state.tags.length
      ? `<span class="text-xs text-muted">标签</span>${state.tags.map((name) => tagChipHtml({ name, count: 0, color: '' })).join('')}${clearBtn}`
      : `<span class="text-xs text-muted">当前知识库还没有标签，给内容打上标签后即可按标签筛选。</span>`;
    return;
  }

  const selected = tagList.filter((t) => state.tags.includes(t.name));
  const missing = state.tags
    .filter((name) => !tagList.some((t) => t.name === name))
    .map((name) => ({ name, count: 0, color: '' }));
  const rest = tagList.filter((t) => !state.tags.includes(t.name));
  const room = Math.max(0, TAG_CHIP_LIMIT - selected.length - missing.length);
  const shown = state.showAllTags
    ? [...missing, ...selected, ...rest]
    : [...missing, ...selected, ...rest.slice(0, room)];
  const hidden = tagList.length - shown.length + missing.length;

  dom.tagRow.innerHTML = `
    <span class="text-xs text-muted">标签</span>
    ${shown.map(tagChipHtml).join('')}
    ${hidden > 0 ? `<span class="chip chip-btn" data-quick="alltags">还有 ${hidden} 个</span>` : ''}
    ${clearBtn}`;
}

function tagChipHtml(tag) {
  const active = state.tags.includes(tag.name);
  const style = tag.color ? ` style="background:${esc(tag.color)}1a;color:${esc(tag.color)}"` : '';
  return `<span class="tag tag-btn${active ? ' is-active' : ''}" data-tag="${esc(tag.name)}" title="${Number(tag.count) || 0} 项内容"${style}>${esc(tag.name)}<span style="opacity:.6;margin-left:4px">${Number(tag.count) || 0}</span></span>`;
}

/** 同步所有筛选控件的激活态（不重建 DOM，避免丢失 select 状态） */
function updateFilterStates() {
  if (!dom.filters || !dom.quick) return;

  qsa('[data-type]', dom.filters).forEach((n) => n.classList.toggle('is-active', n.getAttribute('data-type') === state.types));
  qsa('[data-mode]', dom.filters).forEach((n) => n.classList.toggle('is-active', n.getAttribute('data-mode') === state.mode));
  qsa('[data-scope]', dom.filters).forEach((n) => n.classList.toggle('is-active', n.getAttribute('data-scope') === state.scope));

  const star = qs('[data-starred]', dom.filters);
  if (star) star.classList.toggle('is-active', state.starred);

  const folder = qs('#search-folder', dom.filters);
  if (folder) folder.value = state.folderId || '';

  qsa('[data-quick]', dom.quick).forEach((n) => {
    const key = n.getAttribute('data-quick');
    const active = (key === 'recent7' && state.since === RECENT_DAYS)
      || (key === 'starred' && state.starred)
      || (key === 'alltags' && state.showAllTags);
    n.classList.toggle('is-active', active);
  });

  if (dom.clear && dom.input) dom.clear.hidden = !dom.input.value;
}

function fillFolderOptions(folders) {
  const select = dom.filters ? qs('#search-folder', dom.filters) : null;
  if (!select) return;
  const options = ['<option value="">全部文件夹</option>'];
  for (const folder of folders || []) {
    const depth = Math.max(0, String(folder.path || '').split('/').filter(Boolean).length - 1);
    const pad = depth > 0 ? '\u3000'.repeat(depth) : '';
    const count = Number(folder.totalCount || 0);
    options.push(`<option value="${esc(folder.id)}">${pad}${esc(folder.name)}${count ? ` (${count})` : ''}</option>`);
  }
  select.innerHTML = options.join('');
  select.value = state.folderId || '';
}

function applyFilterChange() {
  updateFilterStates();
  renderTagFilters();
  syncUrl();
  if (state.q.trim()) runSearch();
  else renderInitial();
}

/* ================================================================== 检索 */

function buildParams(offset) {
  const params = {
    workspaceId: state.scope === 'all' ? 'all' : (ctxRef?.workspace?.id || ''),
    q: state.q.trim(),
    mode: state.mode,
    limit: state.since === RECENT_DAYS ? 40 : PAGE_SIZE,
    offset
  };
  if (state.types !== 'all') params.types = state.types;
  if (state.tags.length) params.tags = state.tags;
  if (state.folderId) params.folderId = state.folderId;
  if (state.starred) params.starred = 1;
  return params;
}

/**
 * api.search() 未透传 AbortSignal；为在快速输入时真正取消上一次请求，
 * 这里经同一客户端的底层 api.request 调用（api.search 内部走的就是它）。
 */
function searchRequest(api, params, signal) {
  return api.request('GET', `/api/search${api.qs(params)}`, { signal });
}

async function runSearch({ more = false } = {}) {
  if (!ctxRef || !dom.body) return;
  if (!state.q.trim()) { renderInitial(); return; }
  if (loading && more) return;

  const api = ctxRef.api;
  const myRun = ++runId;
  if (controller) { try { controller.abort(); } catch { /* 已结束 */ } }
  controller = new AbortController();
  const { signal } = controller;
  loading = true;

  const offset = more ? serverOffset : 0;
  if (more) {
    setMoreLoading(true);
  } else {
    items = [];
    total = 0;
    serverOffset = 0;
    hasMore = false;
    dom.body.innerHTML = skeleton(5);
  }

  try {
    const data = await searchRequest(api, buildParams(offset), signal);
    if (signal.aborted || myRun !== runId || !dom.body) return;

    const list = Array.isArray(data?.items) ? data.items : [];
    lastMeta = {
      terms: Array.isArray(data?.terms) ? data.terms : [],
      mode: MODE_LABELS[data?.mode] ? data.mode : state.mode,
      took: Number(data?.took || 0),
      vectorUsed: Number(data?.vectorUsed || 0)
    };
    serverOffset = offset + list.length;
    total = Number(data?.total || 0);
    hasMore = list.length > 0 && serverOffset < total;

    const kept = applyLocalFilter(list);
    items = more ? items.concat(kept) : kept;
    loading = false;
    renderResults();
    void loadFoldersForResults(items);
  } catch (err) {
    if (err?.name === 'AbortError' || signal.aborted || myRun !== runId) return;
    loading = false;
    renderErrorState(err);
  } finally {
    if (myRun === runId) setMoreLoading(false);
  }
}

/** 本地时间筛选（检索接口暂无时间参数） */
function applyLocalFilter(list) {
  if (state.since !== RECENT_DAYS) return list;
  const min = Date.now() - RECENT_DAYS * 86400000;
  return list.filter((item) => {
    const t = Date.parse(item.updatedAt || '');
    return Number.isFinite(t) && t >= min;
  });
}

function setMoreLoading(busy) {
  if (!dom.body) return;
  const btn = qs('[data-more]', dom.body);
  if (!btn) return;
  btn.disabled = !!busy;
  if (busy) {
    btn.dataset.label = btn.textContent;
    btn.textContent = '加载中…';
  } else if (btn.dataset.label) {
    btn.textContent = btn.dataset.label;
    delete btn.dataset.label;
  }
}

/* ================================================================== 渲染 */

function statsLine() {
  const parts = [
    `找到 <strong>${formatNumber(total)}</strong> 条结果`,
    `用时 ${formatNumber(lastMeta.took)} ms`,
    esc(MODE_LABELS[lastMeta.mode] || MODE_LABELS.hybrid)
  ];
  if (lastMeta.vectorUsed) parts.push(`语义向量命中 ${formatNumber(lastMeta.vectorUsed)} 块`);
  if (state.since === RECENT_DAYS) parts.push(`已按最近 ${RECENT_DAYS} 天筛选（本页 ${items.length} 条）`);
  if (state.tags.length) parts.push(`标签：${esc(state.tags.join('、'))}`);
  if (state.starred) parts.push('仅收藏');
  if (state.scope === 'all') parts.push('全部知识库');
  return `<div class="search-stats">${parts.join('<span style="opacity:.5">·</span>')}</div>`;
}

function renderResults() {
  if (!dom.body) return;

  if (!items.length) {
    if (state.since === RECENT_DAYS && hasMore) {
      dom.body.innerHTML = `${statsLine()}<div class="card">${emptyState({
        iconName: 'clock',
        title: '本页没有最近 7 天更新的内容',
        desc: '可以继续加载更多结果，或去掉时间范围限制。',
        actions: '<button class="btn btn-default" data-more>加载更多</button><button class="btn btn-ghost" data-quick="recent7">去掉时间筛选</button>'
      })}</div>`;
      return;
    }
    renderNoResults(statsLine());
    return;
  }

  dom.body.innerHTML = `${statsLine()}
    <div id="search-results">${items.map(cardHtml).join('')}</div>
    <div class="flex items-center gap-3" style="justify-content:center;margin-top:var(--sp-5)">
      ${hasMore ? '<button class="btn btn-default" data-more>加载更多</button>' : ''}
      <span class="text-xs text-muted">已显示 ${formatNumber(items.length)} / ${formatNumber(total)} 条</span>
    </div>`;

  fillFolderLabels();
}

function renderNoResults(stats) {
  if (!dom.body) return;
  const q = state.q.trim();
  const actions = [
    '<button class="btn btn-default" data-focus-input>换个关键词</button>',
    state.tags.length ? '<button class="btn btn-default" data-clear-tags>去掉标签过滤</button>' : '',
    state.mode !== 'fuzzy' ? '<button class="btn btn-primary" data-fuzzy>用模糊匹配重试</button>' : '',
    state.scope !== 'all' ? '<button class="btn btn-ghost" data-scope-all>在全部知识库中检索</button>' : ''
  ].filter(Boolean).join('');

  dom.body.innerHTML = `${stats}<div class="card">${emptyState({
    iconName: 'search',
    title: '没有找到相关内容',
    desc: `没有匹配「${esc(q)}」的结果。可以换一个关键词、去掉标签过滤，或切换为模糊匹配再试一次。`,
    actions
  })}</div>`;
}

function renderErrorState(err) {
  if (!dom.body) return;
  dom.body.innerHTML = `<div class="card">${emptyState({
    iconName: 'alert',
    title: '检索失败',
    desc: esc(err?.message || '请稍后重试'),
    actions: '<button class="btn btn-default" data-retry>重试</button>'
  })}</div>`;
}

function renderInitial() {
  if (!dom.body) return;
  const tags = initialCache.tags;
  const recent = initialCache.recent;
  const loadingInitial = !initialCache.loaded;

  dom.body.innerHTML = `
    <div class="grid mb-5" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:16px">
      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('info', 15)} 检索技巧</div>
              <div class="section-sub">四种方式可组合使用</div>
            </div>
          </div>
          <div class="flex-col gap-3">
            ${TIPS.map((tip) => `<div class="flex gap-3" style="align-items:flex-start">
              <span style="width:26px;height:26px;border-radius:8px;background:var(--c-ink-100);color:var(--c-ink-600);display:grid;place-items:center;flex:none">${icon(tip.icon, 14)}</span>
              <div style="min-width:0">
                <div class="text-sm font-medium">${esc(tip.title)}</div>
                <div class="text-xs text-muted" style="line-height:1.7">${esc(tip.desc)}</div>
              </div>
            </div>`).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('tag', 15)} 标签云</div>
              <div class="section-sub">点击标签立即检索</div>
            </div>
          </div>
          ${loadingInitial
            ? skeleton(3)
            : (initialCache.failed
              ? '<div class="text-sm text-muted" style="line-height:1.75">标签云加载失败，可直接输入关键词检索。</div>'
              : (tags.length
                ? `<div class="tag-cloud">${tags.slice(0, 24).map(cloudTagHtml).join('')}</div>`
                : '<div class="text-sm text-muted" style="line-height:1.75">当前知识库还没有标签，给内容打上标签后这里会形成知识脉络。</div>'))}
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-pad" style="padding-bottom:8px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('clock', 15)} 最近更新</div>
            <div class="section-sub">一键打开，或输入关键词深入检索</div>
          </div>
          <div class="section-actions"><button class="btn btn-sm btn-ghost" type="button" data-goto-files>查看文件库</button></div>
        </div>
      </div>
      <div style="padding:0 8px 10px">
        ${loadingInitial
          ? skeleton(3)
          : (initialCache.failed
            ? '<div class="text-sm text-muted" style="padding:0 12px 12px">最近文档加载失败，可点击右上角「查看文件库」。</div>'
            : (recent.length
              ? recent.map(recentRowHtml).join('')
              : '<div class="text-sm text-muted" style="padding:0 12px 12px">当前知识库还没有文档，先上传一份资料试试。</div>'))}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ 片段 */

function cloudTagHtml(tag) {
  const style = tag.color ? ` style="background:${esc(tag.color)}1a;color:${esc(tag.color)}"` : '';
  return `<span class="tag tag-btn" data-cloud-tag="${esc(tag.name)}" title="${Number(tag.count) || 0} 项内容"${style}>${esc(tag.name)}<span style="opacity:.6;margin-left:4px">${Number(tag.count) || 0}</span></span>`;
}

function recentRowHtml(file) {
  return `<div class="list-row" data-recent-file="${esc(file.id)}">
    ${fileIconHtml(file.ext)}
    <div class="list-main">
      <div class="list-title">${esc(file.name)}</div>
      <div class="list-sub">${formatBytes(file.size)} · ${esc(String(file.ext || '').toUpperCase() || 'FILE')}</div>
    </div>
    <div class="list-time">${esc(timeAgo(file.updatedAt))}</div>
  </div>`;
}

function cardHtml(item) {
  const isFile = item.type === 'file';
  const terms = lastMeta.terms;
  const folderId = item.folderId || '';
  const wsId = item.workspaceId || '';
  const folderName = folderLookup(wsId, folderId);
  const tags = Array.isArray(item.tags) ? item.tags : [];
  const score = Number(item.score || 0);
  const snippet = item.snippet || esc(item.snippetRaw || '');
  const key = `${item.type}:${item.id}`;

  return `<article class="result-item" data-result data-key="${esc(key)}">
    <div class="result-head">
      ${isFile
        ? fileIconHtml(item.ext)
        : `<span class="file-ico f-md" style="background:var(--c-ink-100);color:var(--c-ink-700);font-size:16px">${esc(item.emoji || 'NOTE')}</span>`}
      <div class="result-title">${highlightText(item.title || '', terms)}</div>
      ${item.starred ? `<span style="width:14px;height:14px;color:#D97706;flex:none" title="已收藏">${icon('star', 14)}</span>` : ''}
      <button class="icon-btn sm" type="button" data-menu aria-label="更多操作" style="flex:none">${icon('moreV', 14)}</button>
    </div>
    <div class="result-snippet">${snippet}</div>
    <div class="result-foot">
      <span class="badge${isFile ? '' : ' badge-info'}">${isFile ? '文档' : '笔记'}</span>
      ${item.page ? `<span>第 ${Number(item.page)} 页</span>` : ''}
      ${folderId
        ? `<span data-folder-label data-folder-ws="${esc(wsId)}" data-folder-id="${esc(folderId)}" title="所在文件夹">${icon('folder', 12)} ${folderName ? esc(folderName) : '<span class="skel" style="display:inline-block;width:50px;height:9px;vertical-align:middle"></span>'}</span>`
        : `<span title="所在文件夹">${icon('folder', 12)} 根目录</span>`}
      ${tags.slice(0, 5).map((t) => `<span class="tag tag-btn" data-result-tag="${esc(t)}" title="按该标签筛选">${esc(t)}</span>`).join('')}
      ${tags.length > 5 ? `<span>+${tags.length - 5}</span>` : ''}
      <span title="${esc(item.updatedAt || '')}">${icon('clock', 12)} ${esc(timeAgo(item.updatedAt))}</span>
      <span class="spacer"></span>
      <span class="text-mono" title="相关度得分">${score.toFixed(2)}</span>
    </div>
  </article>`;
}

function folderLookup(workspaceId, folderId) {
  if (!folderId) return '';
  const entry = folderMaps.get(workspaceId)?.get(folderId);
  return entry ? entry.name : '';
}

function fillFolderLabels() {
  if (!dom.body || !dom.body.isConnected) return;
  qsa('[data-folder-label]', dom.body).forEach((node) => {
    const wsId = node.getAttribute('data-folder-ws');
    const folderId = node.getAttribute('data-folder-id');
    const entry = folderMaps.get(wsId)?.get(folderId);
    if (!entry) return;
    node.innerHTML = `${icon('folder', 12)} ${esc(entry.name)}`;
    node.setAttribute('title', entry.path || entry.name);
  });
}

function replaceCard(item) {
  if (!dom.body) return;
  const key = `${item.type}:${item.id}`;
  const node = qsa('[data-key]', dom.body).find((n) => n.getAttribute('data-key') === key);
  if (!node) return;
  const next = el(cardHtml(item));
  node.replaceWith(next);
}

/* ================================================================== 数据 */

async function loadFilterSources(workspaceId) {
  if (!ctxRef) return;
  const api = ctxRef.api;
  try {
    const [tagRes, folderRes] = await Promise.all([
      api.tags(workspaceId),
      api.folders(workspaceId)
    ]);
    if (!ctxRef) return;
    tagList = Array.isArray(tagRes?.tags) ? tagRes.tags : [];
    const flat = Array.isArray(folderRes?.flat) ? folderRes.flat : [];
    folderMaps.set(workspaceId, new Map(flat.map((f) => [f.id, { name: f.name, path: f.path || f.name }])));
    renderTagFilters();
    fillFolderOptions(flat);
    updateFilterStates();
  } catch (err) {
    if (!ctxRef) return;
    tagList = [];
    renderTagFilters();
    notify.error(err?.message || '加载筛选项失败');
  }
}

async function loadInitialPanel(workspaceId) {
  if (!ctxRef) return;
  const api = ctxRef.api;
  const [cloud, recent] = await Promise.allSettled([
    api.tagCloud(workspaceId),
    api.files({ workspaceId, limit: 6, sort: 'updated' })
  ]);
  if (!ctxRef) return;
  initialCache = {
    loaded: true,
    failed: cloud.status === 'rejected' && recent.status === 'rejected',
    tags: cloud.status === 'fulfilled' && Array.isArray(cloud.value?.tags) ? cloud.value.tags : [],
    recent: recent.status === 'fulfilled' && Array.isArray(recent.value?.files) ? recent.value.files : []
  };
  if (!state.q.trim() && dom.body) renderInitial();
}

async function loadFoldersForResults(list) {
  if (!ctxRef) return;
  const api = ctxRef.api;
  const ids = [...new Set(list.map((item) => item.workspaceId).filter(Boolean))];
  for (const workspaceId of ids) {
    if (!ctxRef) return;
    if (folderMaps.has(workspaceId) || folderRequests.has(workspaceId)) continue;
    folderRequests.add(workspaceId);
    try {
      const data = await api.folders(workspaceId);
      const flat = Array.isArray(data?.flat) ? data.flat : [];
      folderMaps.set(workspaceId, new Map(flat.map((f) => [f.id, { name: f.name, path: f.path || f.name }])));
    } catch {
      folderMaps.set(workspaceId, new Map());
    } finally {
      folderRequests.delete(workspaceId);
    }
  }
  fillFolderLabels();
}

/* ================================================================== 结果操作 */

function deepLink(item) {
  const base = `${location.origin}${location.pathname}`;
  return item.type === 'file'
    ? `${base}#/files?open=${encodeURIComponent(item.id)}`
    : `${base}#/notes/${encodeURIComponent(item.id)}`;
}

function openItem(item) {
  if (!ctxRef) return;
  if (item.type === 'file') ctxRef.navigate('files', [], { open: item.id });
  else ctxRef.navigate('notes', [item.id]);
}

function openItemMenu(anchor, item) {
  if (!ctxRef) return;
  const api = ctxRef.api;
  const isFile = item.type === 'file';

  dropdown(anchor, [
    {
      icon: 'external',
      label: '在新标签打开',
      onClick: () => {
        const url = isFile ? api.fileExportUrl(item.id) : api.noteExportUrl(item.id);
        window.open(url, '_blank', 'noopener');
      }
    },
    {
      icon: 'copy',
      label: '复制链接',
      onClick: () => copyText(deepLink(item), '链接已复制')
    },
    {
      icon: 'folder',
      label: '打开所在文件夹',
      disabled: !item.folderId,
      hint: item.folderId ? '' : '位于根目录',
      onClick: () => ctxRef.navigate('files', [], { folderId: item.folderId })
    },
    { sep: true },
    {
      icon: 'star',
      label: item.starred ? '取消收藏' : '收藏',
      active: !!item.starred,
      onClick: () => toggleStar(item)
    }
  ], { align: 'end', width: 208 });
}

async function toggleStar(item) {
  if (!ctxRef) return;
  const api = ctxRef.api;
  const action = item.starred ? 'unstar' : 'star';
  try {
    const res = item.type === 'file'
      ? await api.batchFiles(action, [item.id])
      : await api.batchNotes(action, [item.id]);
    if (Number(res?.failed || 0) > 0) {
      throw new Error(res?.errors?.[0]?.error || '操作失败');
    }
    item.starred = !item.starred;
    replaceCard(item);
    notify.success(item.starred ? '已加入收藏' : '已取消收藏');
  } catch (err) {
    notify.error(err?.message || '操作失败');
  }
}

/* ================================================================== 事件 */

function bind(container, ctx) {
  const push = (off) => cleanup.push(off);

  /* --- 输入框：随打随搜（防抖），Enter 立即检索并写入 URL --- */
  const input = dom.input;
  const clearBtn = dom.clear;

  const onInput = () => {
    state.q = input.value;
    if (clearBtn) clearBtn.hidden = !input.value;
    debouncedRun();
  };
  input.addEventListener('input', onInput);
  push(() => input.removeEventListener('input', onInput));

  const onInputKeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    debouncedRun.cancel();
    state.q = input.value;
    syncUrl();
    runSearch();
  };
  input.addEventListener('keydown', onInputKeydown);
  push(() => input.removeEventListener('keydown', onInputKeydown));

  const onClearClick = () => {
    input.value = '';
    state.q = '';
    clearBtn.hidden = true;
    debouncedRun.cancel();
    syncUrl();
    renderInitial();
    input.focus();
  };
  clearBtn.addEventListener('click', onClearClick);
  push(() => clearBtn.removeEventListener('click', onClearClick));

  /* --- 全局快捷键：/ 聚焦，Esc 清空 --- */
  const onDocKeydown = (e) => {
    if (!ctxRef) return;
    const active = document.activeElement;
    const typing = !!active && (/^(input|textarea|select)$/i.test(active.tagName) || active.isContentEditable);

    if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      // 捕获阶段阻断，避免全局命令面板同时抢占该按键
      e.stopPropagation();
      dom.input?.focus();
      dom.input?.select?.();
      return;
    }

    if (e.key === 'Escape') {
      // 让模态框 / 抽屉 / 下拉菜单优先处理
      if (qs('.overlay') || qs('.drawer') || qs('.dropdown')) return;
      if (!dom.input || !dom.input.value) return;
      dom.input.value = '';
      state.q = '';
      if (dom.clear) dom.clear.hidden = true;
      debouncedRun.cancel();
      syncUrl();
      renderInitial();
    }
  };
  document.addEventListener('keydown', onDocKeydown, true);
  push(() => document.removeEventListener('keydown', onDocKeydown, true));

  /* --- 筛选：类型 / 模式 / 范围 --- */
  push(on(container, 'click', '[data-type]', (e, node) => {
    state.types = node.getAttribute('data-type');
    applyFilterChange();
  }));

  push(on(container, 'click', '[data-mode]', (e, node) => {
    state.mode = node.getAttribute('data-mode');
    applyFilterChange();
  }));

  push(on(container, 'click', '[data-scope]', (e, node) => {
    state.scope = node.getAttribute('data-scope');
    applyFilterChange();
  }));

  push(on(container, 'click', '[data-scope-all]', () => {
    state.scope = 'all';
    applyFilterChange();
  }));

  push(on(container, 'click', '[data-starred]', () => {
    state.starred = !state.starred;
    applyFilterChange();
  }));

  push(on(container, 'change', '#search-folder', (e, node) => {
    state.folderId = node.value;
    applyFilterChange();
  }));

  /* --- 标签筛选 --- */
  push(on(container, 'click', '[data-tag]', (e, node) => {
    const name = node.getAttribute('data-tag');
    state.tags = state.tags.includes(name)
      ? state.tags.filter((t) => t !== name)
      : [...state.tags, name];
    applyFilterChange();
  }));

  push(on(container, 'click', '[data-clear-tags]', () => {
    state.tags = [];
    applyFilterChange();
  }));

  push(on(container, 'click', '[data-clear-filters]', () => {
    const q = dom.input ? dom.input.value : '';
    state = initialState();
    state.q = q;
    applyFilterChange();
  }));

  /* --- 快捷筛选 --- */
  push(on(container, 'click', '[data-quick]', (e, node) => {
    const key = node.getAttribute('data-quick');
    if (key === 'recent7') {
      const on2 = state.since !== RECENT_DAYS;
      state.since = on2 ? RECENT_DAYS : 0;
      state.types = on2 ? 'file' : 'all';
    } else if (key === 'starred') {
      state.starred = !state.starred;
    } else if (key === 'alltags') {
      state.showAllTags = !state.showAllTags;
      renderTagFilters();
      dom.tagRow?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
    }
    applyFilterChange();
  }));

  /* --- 结果区 --- */
  push(on(dom.body, 'click', '[data-menu]', (e, node) => {
    e.preventDefault();
    const card = node.closest('[data-result]');
    const item = findItem(card?.getAttribute('data-key'));
    if (item) openItemMenu(node, item);
  }));

  push(on(dom.body, 'click', '[data-result-tag]', (e, node) => {
    e.preventDefault();
    const name = node.getAttribute('data-result-tag');
    if (!state.tags.includes(name)) state.tags = [...state.tags, name];
    applyFilterChange();
  }));

  push(on(dom.body, 'click', '[data-result]', (e, node) => {
    if (e.target.closest('[data-menu]') || e.target.closest('[data-result-tag]')) return;
    const item = findItem(node.getAttribute('data-key'));
    if (item) openItem(item);
  }));

  push(on(dom.body, 'click', '[data-more]', () => {
    runSearch({ more: true });
  }));

  push(on(dom.body, 'click', '[data-retry]', () => {
    runSearch();
  }));

  push(on(dom.body, 'click', '[data-fuzzy]', () => {
    state.mode = 'fuzzy';
    updateFilterStates();
    syncUrl();
    runSearch();
  }));

  push(on(dom.body, 'click', '[data-focus-input]', () => {
    dom.input?.focus();
    dom.input?.select?.();
  }));

  push(on(dom.body, 'click', '[data-cloud-tag]', (e, node) => {
    const name = node.getAttribute('data-cloud-tag');
    state.tags = state.tags.includes(name) ? state.tags.filter((t) => t !== name) : [...state.tags, name];
    if (!dom.input.value.trim()) {
      dom.input.value = name;
      state.q = name;
    }
    applyFilterChange();
  }));

  push(on(dom.body, 'click', '[data-recent-file]', (e, node) => {
    ctx.navigate('files', [], { open: node.getAttribute('data-recent-file') });
  }));

  push(on(dom.body, 'click', '[data-goto-files]', () => {
    ctx.navigate('files');
  }));

  updateFilterStates();
}

function findItem(key) {
  if (!key) return null;
  return items.find((it) => `${it.type}:${it.id}` === key) || null;
}

export default { meta, mount, unmount };
