/**
 * KBPRO — 智能问答（RAG Chat）
 *
 * 两栏布局：左侧会话列表（新对话 / 置顶 / 重命名 / 删除），
 * 右侧消息流 + 输入区。回答通过 api.ask 的 SSE 流式接口逐步渲染，
 * 并在每条回答下方展示可追溯到原文的引用来源。
 */
import {
  qs, qsa, el, on, applyIcons, icon, notify, modal, confirmDialog, promptDialog,
  dropdown, contextMenu, closeAllDropdowns, copyText, emptyState, esc, timeAgo,
  formatBytes, initials, fileIconHtml, skeleton
} from '../ui.js';
import { renderChatMarkdown } from '../md.js';
import { citationsHtml, citeCardHtml } from '../citations.js';

export const meta = { title: '智能问答', icon: 'sparkle' };

/* ------------------------------------------------------------------ 状态 */

/** 页面状态；未挂载时为 null（所有异步回调都必须判空） */
let S = null;
/** 需要解绑的监听器 */
let cleanups = [];
/** 页面创建的定时器 */
const timers = new Set();
/** 页面打开的模态框 */
const openModals = new Set();
/** 流式渲染的 rAF 句柄 */
let rafId = 0;

const GENERIC_SUGGESTIONS = [
  { title: '总结知识库的主要内容', sub: '归纳主题、结论与关键要点', q: '总结一下当前知识库的主要内容' },
  { title: '有哪些风险与注意事项？', sub: '从文档中提取风险信号', q: '知识库中提到了哪些风险与注意事项？' },
  { title: '列出关键数据与指标', sub: '抓取量化信息与结论', q: '列出知识库中的关键数据与指标' },
  { title: '最新更新的内容是什么？', sub: '按时间梳理最近的资料', q: '最近更新了哪些内容？' }
];

/* ------------------------------------------------------------------ 工具 */

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function setTimer(fn, ms) {
  const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
  timers.add(t);
  return t;
}

function clearTimers() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
}

function openModal(opts) {
  const m = modal({
    ...opts,
    onClose: (...args) => {
      openModals.delete(m);
      opts.onClose?.(...args);
    }
  });
  openModals.add(m);
  return m;
}

function userInitial() {
  const name = S?.ctx?.store?.user?.name || '';
  return name ? initials(name) : '我';
}

function findMessage(key) {
  if (!S || !key) return null;
  return S.messages.find((m) => m.key === key) || null;
}

function questionBefore(message) {
  if (!S) return '';
  const idx = S.messages.indexOf(message);
  for (let i = idx - 1; i >= 0; i--) {
    if (S.messages[i].role === 'user') return S.messages[i].content;
  }
  return '';
}

/* ------------------------------------------------------------------ 挂载 */

export async function mount(container, ctx) {
  unmount();

  const { api, workspace, query } = ctx;
  if (!workspace) {
    container.innerHTML = `<div class="page">${emptyState({
      iconName: 'layers',
      title: '还没有可用的知识库',
      desc: '请先在左上角创建或加入一个知识库，然后再来提问。'
    })}</div>`;
    return;
  }

  S = {
    root: container,
    ctx,
    api,
    workspace,
    chats: [],
    chatsLoading: true,
    chatsError: '',
    activeId: '',
    messages: [],
    scope: { mode: 'workspace', fileIds: [], fileNames: new Map() },
    ai: null,
    streaming: false,
    abort: null,
    stick: true
  };

  container.innerHTML = shellHtml(ctx);

  const scroller = qs('#chat-scroll', container);
  const input = qs('#chat-input', container);
  const sendBtn = qs('#chat-send', container);
  const chip = qs('#scope-chip', container);
  const jump = qs('#chat-jump', container);

  /* --- 事件（全部登记到 cleanups，unmount 时统一解绑） --- */

  cleanups.push(on(container, 'click', '[data-act="new-chat"]', () => newChat()));
  cleanups.push(on(container, 'click', '[data-act="config-ai"]', () => ctx.navigate('profile')));
  cleanups.push(on(container, 'click', '[data-act="reload-chats"]', () => loadChats()));
  cleanups.push(on(container, 'click', '[data-act="reload-chat"]', () => {
    if (S) openChat(S.activeId, { force: true });
  }));

  cleanups.push(on(container, 'click', '[data-chat-menu]', (e, node) => {
    e.preventDefault();
    openChatMenu(node.getAttribute('data-chat-menu'), node);
  }));

  cleanups.push(on(container, 'click', '[data-chat]', (e, node) => {
    if (e.target.closest('[data-chat-menu]')) return;
    openChat(node.getAttribute('data-chat'));
  }));

  cleanups.push(on(container, 'contextmenu', '[data-chat]', (e, node) => {
    contextMenu(e, chatMenuItems(node.getAttribute('data-chat')));
  }));

  cleanups.push(on(container, 'click', '[data-prompt]', (e, node) => {
    send(node.getAttribute('data-prompt'));
  }));

  // 展开 / 收起参考来源
  cleanups.push(on(container, 'click', '[data-cites-toggle]', (e, node) => {
    const msgNode = node.closest('[data-msg]');
    const m = findMessage(msgNode?.getAttribute('data-msg'));
    if (!m) return;
    m.citesOpen = !(m.citesOpen === true);
    updateRegion(m, 'cites');
    // 展开后内容变长，把标题拉回视野，避免"点了但看不到展开的内容"
    if (m.citesOpen) {
      qs('[data-cites] .citations-head', msgNode)?.scrollIntoView({ block: 'nearest' });
    }
  }));

  cleanups.push(on(container, 'click', '.cite-card', (e, node) => {
    const fileId = node.getAttribute('data-cite-file');
    if (fileId) ctx.navigate('files', [], { open: fileId });
  }));

  cleanups.push(on(container, 'click', '.cite-ref', (e, node) => {
    const num = node.getAttribute('data-cite');
    const scope = node.closest('.msg') || container;
    const msgNode = node.closest('[data-msg]');
    const m = msgNode ? findMessage(msgNode.getAttribute('data-msg')) : null;
    // 角标指向的来源可能正收起着：先展开再定位
    if (m && m.citesOpen !== true && Array.isArray(m.citations) && m.citations.length) {
      m.citesOpen = true;
      updateRegion(m, 'cites');
    }
    const card = num ? qs(`.cite-card[data-cite-card="${num}"]`, scope) : null;
    if (!card) { notify.info('未找到对应的引用来源'); return; }
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    flashCard(card);
  }));

  cleanups.push(on(container, 'click', '[data-copy-answer]', (e, node) => {
    const m = findMessage(node.closest('[data-msg]')?.getAttribute('data-msg'));
    if (m) copyText(m.content, '回答已复制');
  }));

  cleanups.push(on(container, 'click', '[data-feedback]', (e, node) => {
    submitFeedback(node);
  }));

  cleanups.push(on(container, 'click', '[data-retry]', (e, node) => {
    const m = findMessage(node.closest('[data-msg]')?.getAttribute('data-msg'));
    if (m) retryAnswer(m);
  }));

  if (chip) {
    const openScope = (e) => { e.stopPropagation(); openScopeMenu(chip); };
    chip.addEventListener('click', openScope);
    cleanups.push(() => chip.removeEventListener('click', openScope));
  }

  if (sendBtn) {
    const onSend = () => {
      if (!S) return;
      if (S.streaming) { stopStream(); return; }
      send(input ? input.value : '');
    };
    sendBtn.addEventListener('click', onSend);
    cleanups.push(() => sendBtn.removeEventListener('click', onSend));
  }

  if (input) {
    const onKey = (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      e.preventDefault();
      send(input.value);
    };
    const onInput = () => autoGrow();
    input.addEventListener('keydown', onKey);
    input.addEventListener('input', onInput);
    cleanups.push(() => {
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('input', onInput);
    });
  }

  if (scroller) {
    const onScroll = () => {
      if (!S) return;
      S.stick = isAtBottom(scroller);
      showJump(!S.stick);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    cleanups.push(() => scroller.removeEventListener('scroll', onScroll));
  }

  if (jump) {
    const onJump = () => scrollToBottom();
    jump.addEventListener('click', onJump);
    cleanups.push(() => jump.removeEventListener('click', onJump));
  }

  /* --- 首屏 --- */

  applyIcons(container);
  autoGrow();
  updateComposer();
  renderScopeChip();
  renderHead();
  renderList();
  renderThread();

  await Promise.all([loadChats(), loadAiStatus()]);
  if (!S || S.root !== container) return;

  /* --- 深链 --- */

  const fileId = String(query?.fileId || '').trim();
  if (fileId) await applyFileScope(fileId);
  if (!S || S.root !== container) return;

  const question = String(query?.q || '').trim();
  if (question) {
    if (input) input.value = '';
    send(question);
  } else if (input) {
    input.focus();
  }
}

export function unmount() {
  if (S?.abort) {
    try { S.abort.abort(); } catch { /* 忽略 */ }
  }
  for (const off of cleanups) {
    try { if (typeof off === 'function') off(); } catch { /* 忽略 */ }
  }
  cleanups = [];
  clearTimers();
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  for (const m of [...openModals]) {
    try { m.close(); } catch { /* 忽略 */ }
  }
  openModals.clear();
  try { closeAllDropdowns(); } catch { /* 忽略 */ }
  S = null;
}

/* ------------------------------------------------------------------ 骨架 */

function shellHtml(ctx) {
  const wsName = esc(ctx.workspace?.name || '知识库');
  // #view 是 position:relative 的滚动容器，用绝对定位撑满，避免百分比高度失效
  return `<div class="chat-layout" style="position:absolute;top:0;right:0;bottom:0;left:0">
    <aside class="chat-side">
      <div class="chat-side-head">
        <button class="btn btn-primary" style="width:100%;justify-content:center" data-act="new-chat">
          ${icon('plus')}<span>新对话</span>
        </button>
      </div>
      <div class="chat-list" id="chat-list">${skeleton(5)}</div>
    </aside>

    <section class="chat-main" style="position:relative">
      <div class="chat-head" id="chat-head"></div>

      <div class="chat-scroll" id="chat-scroll">
        <div class="chat-inner" id="chat-inner"></div>
        <div id="chat-jump-wrap" style="position:sticky;bottom:0;display:none;justify-content:center;padding-top:10px">
          <button class="btn btn-default btn-sm" id="chat-jump" style="box-shadow:var(--sh-2)">${icon('chevronDown')}<span>回到最新</span></button>
        </div>
      </div>

      <div class="chat-compose">
        <div class="compose-inner">
          <div class="compose-box">
            <textarea id="chat-input" rows="1" spellcheck="false" placeholder="向「${wsName}」提问，例如：这份报告的核心结论是什么？"></textarea>
            <div class="compose-actions">
              <span class="scope-chip" id="scope-chip" title="选择问答范围"></span>
              <span class="spacer"></span>
              <span class="compose-hint">Enter 发送 · Shift+Enter 换行</span>
              <button class="btn btn-primary btn-sm" id="chat-send">${icon('send')}<span>发送</span></button>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>`;
}

/* ------------------------------------------------------------------ 头部 */

function renderHead() {
  if (!S) return;
  const host = qs('#chat-head', S.root);
  if (!host) return;

  const chat = S.chats.find((c) => c.id === S.activeId);
  const title = chat?.title || '新对话';
  const count = S.messages.filter((m) => m.role !== 'assistant' || m.content).length;

  host.innerHTML = `
    <div style="min-width:0;flex:1">
      <div class="text-sm" style="font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>
      <div class="text-xs text-muted">${count
        ? `本会话 ${count} 条消息 · 基于「${esc(S.workspace.name)}」`
        : `基于「${esc(S.workspace.name)}」的私有知识回答，答案会标注来源`}</div>
    </div>
    <div id="chat-ai-hint" class="flex items-center gap-2" style="flex-wrap:wrap;justify-content:flex-end"></div>
    ${S.activeId ? `<button class="icon-btn sm" data-chat-menu="${esc(S.activeId)}" title="会话操作" aria-label="会话操作">${icon('moreV')}</button>` : ''}`;

  renderAiHint();
}

/** 本地引擎降级提示：非阻断，仅说明并给出配置入口 */
function renderAiHint() {
  if (!S) return;
  const host = qs('#chat-ai-hint', S.root);
  if (!host) return;

  const st = S.ai;
  const provider = st?.status?.provider || st?.effective?.provider || '';
  if (!st || !provider) { host.innerHTML = ''; return; }

  if (provider === 'local') {
    host.innerHTML = `
      <span class="badge badge-info">${icon('info')} 离线引擎</span>
      <span class="text-xs text-muted" style="max-width:330px;line-height:1.55">当前由内置本地引擎回答，内容来自知识库原文抽取；配置大模型后可获得生成式回答。</span>
      <button class="btn btn-sm btn-default" data-act="config-ai">${icon('settings')}<span>配置大模型</span></button>`;
  } else {
    const model = st.effective?.model ? ` · ${esc(st.effective.model)}` : '';
    host.innerHTML = `<span class="badge">${icon('zap')} ${esc(provider)}${model}</span>`;
  }
  applyIcons(host);
}

/* ------------------------------------------------------------------ 会话列表 */

function sortChats() {
  if (!S) return;
  S.chats.sort((a, b) => {
    const pin = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pin) return pin;
    return (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0);
  });
}

function renderList() {
  if (!S) return;
  const host = qs('#chat-list', S.root);
  if (!host) return;

  if (S.chatsLoading) { host.innerHTML = skeleton(5); return; }

  if (S.chatsError) {
    host.innerHTML = `<div style="padding:12px 10px">
      <div class="text-sm text-muted" style="line-height:1.7">会话列表加载失败。</div>
      <button class="btn btn-sm btn-default mt-2" data-act="reload-chats">${icon('refresh')}<span>重新加载</span></button>
    </div>`;
    applyIcons(host);
    return;
  }

  if (!S.chats.length) {
    host.innerHTML = `<div class="text-sm text-muted" style="padding:14px 10px;line-height:1.75">
      还没有问答记录。<br>点击上方「新对话」开始提问。
    </div>`;
    return;
  }

  host.innerHTML = S.chats.map((c) => {
    const active = c.id === S.activeId;
    return `<div class="chat-item${active ? ' is-active' : ''}" data-chat="${esc(c.id)}" title="${esc(c.title || '未命名会话')}">
      <span style="flex:none;display:inline-flex;color:var(--c-ink-400)">${icon(c.pinned ? 'pinFill' : 'comment')}</span>
      <span class="chat-item-title">${esc(c.title || '未命名会话')}</span>
      <span class="text-xs text-muted" style="flex:none;font-size:11px">${esc(timeAgo(c.updated_at))}</span>
      <button class="icon-btn sm" data-chat-menu="${esc(c.id)}" title="更多操作" aria-label="更多操作">${icon('moreV')}</button>
    </div>`;
  }).join('');
}

function chatMenuItems(id) {
  const chat = S?.chats.find((c) => c.id === id);
  return [
    { icon: 'edit', label: '重命名', onClick: () => renameChat(id) },
    { icon: 'pin', label: chat?.pinned ? '取消置顶' : '置顶会话', onClick: () => togglePin(id) },
    { sep: true },
    { icon: 'trash', label: '删除会话', danger: true, onClick: () => removeChat(id) }
  ];
}

function openChatMenu(id, anchor) {
  if (!S || !id) return;
  dropdown(anchor, chatMenuItems(id));
}

async function loadChats() {
  if (!S) return;
  const api = S.api;
  const workspaceId = S.workspace.id;
  S.chatsLoading = true;
  S.chatsError = '';
  renderList();
  try {
    const res = await api.chats({ workspaceId });
    if (!S) return;
    S.chats = Array.isArray(res?.chats) ? res.chats : [];
    sortChats();
  } catch (err) {
    if (!S) return;
    S.chats = [];
    S.chatsError = err?.message || '会话列表加载失败';
    notify.error(S.chatsError);
  } finally {
    if (S) {
      S.chatsLoading = false;
      renderList();
    }
  }
}

/* ------------------------------------------------------------------ 会话操作 */

function newChat() {
  if (!S) return;
  if (S.streaming) { notify.warn('正在生成回答，请先停止当前生成'); return; }
  S.activeId = '';
  S.messages = [];
  renderList();
  renderHead();
  renderThread();
  const input = qs('#chat-input', S.root);
  if (input) input.focus();
}

async function openChat(id, { force = false } = {}) {
  if (!S || !id) return;
  if (S.streaming) { notify.warn('正在生成回答，请先停止当前生成'); return; }
  if (!force && S.activeId === id && S.messages.length) return;

  S.activeId = id;
  S.messages = [];
  renderList();
  renderHead();

  const host = qs('#chat-inner', S.root);
  if (host) host.innerHTML = `<div style="padding:4px 0">${skeleton(4)}</div>`;

  try {
    const res = await S.api.chat(id);
    if (!S || S.activeId !== id) return;
    S.messages = (Array.isArray(res?.messages) ? res.messages : []).map(normalizeMessage);
    if (res?.chat) {
      const idx = S.chats.findIndex((c) => c.id === id);
      if (idx >= 0) S.chats[idx] = { ...S.chats[idx], ...res.chat };
      else S.chats.push(res.chat);
      sortChats();
    }
    renderList();
    renderHead();
    renderThread();
    scrollToBottom();
  } catch (err) {
    if (!S || S.activeId !== id) return;
    const h = qs('#chat-inner', S.root);
    if (h) {
      h.innerHTML = `<div class="page" style="padding:24px 0">${emptyState({
        iconName: 'alert',
        title: '会话加载失败',
        desc: esc(err?.message || '请稍后重试'),
        actions: '<button class="btn btn-default" data-act="reload-chat">重新加载</button>'
      })}</div>`;
    }
    notify.error(err?.message || '会话加载失败');
  }
}

function normalizeMessage(m) {
  return {
    key: `srv-${m.id}`,
    id: m.id || '',
    role: m.role === 'user' ? 'user' : 'assistant',
    content: m.content || '',
    citations: Array.isArray(m.citations) ? m.citations : [],
    feedback: Number(m.feedback) || 0,
    model: m.model || '',
    // 该回答是否来自通用知识（未引用知识库）——刷新后也要保留警示
    general: !!m.general,
    noContext: !!m.noContext,
    interrupted: !!m.interrupted,
    streaming: false,
    typing: false,
    error: false,
    errorMsg: ''
  };
}

async function renameChat(id) {
  if (!S) return;
  const chat = S.chats.find((c) => c.id === id);
  const title = await promptDialog({
    title: '重命名会话',
    label: '会话标题',
    value: chat?.title || '',
    placeholder: '输入新的会话标题',
    confirmText: '保存'
  });
  if (!S || title === null || title === undefined) return;
  const next = String(title).trim();
  if (!next) { notify.warn('标题不能为空'); return; }
  try {
    await S.api.updateChat(id, { title: next });
    if (!S) return;
    if (chat) chat.title = next;
    renderList();
    renderHead();
    notify.success('已重命名');
  } catch (err) {
    notify.error(err?.message || '重命名失败');
  }
}

async function togglePin(id) {
  if (!S) return;
  const chat = S.chats.find((c) => c.id === id);
  if (!chat) return;
  const next = !chat.pinned;
  try {
    await S.api.updateChat(id, { pinned: next });
    if (!S) return;
    chat.pinned = next ? 1 : 0;
    sortChats();
    renderList();
    notify.success(next ? '已置顶，排序更靠前' : '已取消置顶');
  } catch (err) {
    notify.error(err?.message || '操作失败');
  }
}

async function removeChat(id) {
  if (!S) return;
  const chat = S.chats.find((c) => c.id === id);
  const ok = await confirmDialog({
    title: '删除会话',
    message: `确定要删除「${esc(chat?.title || '未命名会话')}」吗？该会话中的问答记录会一并删除，且无法恢复。`,
    confirmText: '删除',
    danger: true
  });
  if (!S || !ok) return;
  try {
    await S.api.deleteChat(id);
    if (!S) return;
    S.chats = S.chats.filter((c) => c.id !== id);
    if (S.activeId === id) {
      S.activeId = '';
      S.messages = [];
      renderThread();
      renderHead();
    }
    renderList();
    notify.success('会话已删除');
  } catch (err) {
    notify.error(err?.message || '删除失败');
  }
}

/* ------------------------------------------------------------------ 消息渲染 */

function renderThread() {
  if (!S) return;
  const host = qs('#chat-inner', S.root);
  if (!host) return;

  if (!S.messages.length) {
    host.innerHTML = emptyThreadHtml();
    applyIcons(host);
    loadSuggestions();
    return;
  }
  host.innerHTML = S.messages.map(messageHtml).join('');
  applyIcons(host);
}

function emptyThreadHtml() {
  return `<div class="chat-empty">
    <div class="chat-empty-mark">${icon('sparkle')}</div>
    <h2>向「${esc(S.workspace.name)}」提问</h2>
    <p>回答完全基于知识库中的文档内容，并标注来源与片段，可追溯到原文。</p>
    <div class="prompt-grid" id="chat-prompts">${promptCardsHtml(GENERIC_SUGGESTIONS)}</div>
  </div>`;
}

function promptCardsHtml(list) {
  return list.map((s) => `<button class="prompt-card" data-prompt="${esc(s.q)}">
    <div class="prompt-card-title">${esc(s.title)}</div>
    <div class="prompt-card-sub">${esc(s.sub)}</div>
  </button>`).join('');
}

/** 用工作区真实文档生成提问建议；失败时保留通用建议 */
async function loadSuggestions() {
  if (!S) return;
  try {
    const res = await S.api.files({ workspaceId: S.workspace.id, limit: 6 });
    if (!S) return;
    const files = Array.isArray(res?.files) ? res.files : [];
    if (!files.length) return;
    const list = files.slice(0, 4).map((f) => ({
      title: `《${f.name}》讲了什么？`,
      sub: '基于该文档提炼核心内容',
      q: `《${f.name}》讲了什么？`
    }));
    let gi = 0;
    while (list.length < 4) list.push(GENERIC_SUGGESTIONS[gi++ % GENERIC_SUGGESTIONS.length]);
    const grid = qs('#chat-prompts', S.root);
    if (grid) grid.innerHTML = promptCardsHtml(list.slice(0, 4));
  } catch { /* 建议属于增强项，失败静默保留通用建议 */ }
}

function messageHtml(m) {
  if (m.role === 'user') {
    return `<div class="msg is-user" data-msg="${esc(m.key)}">
      <div class="msg-avatar">${esc(userInitial())}</div>
      <div class="msg-body">
        <div class="msg-role">我</div>
        <div class="msg-content">${esc(m.content)}</div>
      </div>
    </div>`;
  }
  return `<div class="msg is-assistant" data-msg="${esc(m.key)}">
    <div class="msg-avatar">${icon('sparkle')}</div>
    <div class="msg-body">${assistantBodyHtml(m)}</div>
  </div>`;
}

function assistantBodyHtml(m) {
  const contentHtml = m.content ? renderChatMarkdown(m.content) : '';
  const typing = m.typing ? '<div class="typing"><span></span><span></span><span></span></div>' : '';
  const error = m.error ? errorCardHtml(m) : '';
  const blink = m.streaming && m.content ? ' cursor-blink' : '';
  const model = m.model ? ` · ${esc(m.model)}` : '';
  return `<div class="msg-role">KBPRO 智能助手${model}</div>
    ${generalNoticeHtml(m)}
    <div class="msg-content${blink}">${contentHtml}${typing}${error}</div>
    <div data-tools>${toolsHtml(m)}</div>
    <div data-cites>${citationsHtml(m)}</div>`;
}

/**
 * 「未引用知识库」提示。
 *
 * 当知识库检索不到依据、而大模型用通用知识作答时，后端会带上 general=true。
 * 必须在界面上明确标注——否则用户会误以为这段流畅的回答出自自己的文档，
 * 这恰恰是知识库产品最不能含糊的地方。仅靠提示词要求模型自觉声明是不够的。
 */
function generalNoticeHtml(m) {
  if (m.error) return '';
  if (!m.general && !m.noContext) return '';
  if (!m.content) return '';
  // 本地抽取式引擎不可能越过知识库作答，普通「暂无依据」提示无需再加徽章
  if (m.noContext && !m.general) return '';
  return `<div class="general-notice">
    <span class="general-notice-ico">${icon('alert', 14)}</span>
    <div class="general-notice-body">
      <div class="general-notice-title">以下为通用回答 · 未引用你的知识库</div>
      <div class="general-notice-desc">知识库中没有检索到相关依据，该内容来自大模型的通用知识，请自行核实。</div>
    </div>
  </div>`;
}

function toolsHtml(m) {
  const feedback = m.id ? `
    <button class="btn btn-ghost btn-sm" data-feedback="1" data-value="1" title="回答有帮助"${m.feedback === 1 ? ' style="color:var(--c-ink);background:var(--c-ink-100)"' : ''}>👍</button>
    <button class="btn btn-ghost btn-sm" data-feedback="1" data-value="-1" title="回答需要改进"${m.feedback === -1 ? ' style="color:var(--c-ink);background:var(--c-ink-100)"' : ''}>👎</button>` : '';
  if (!m.content && !feedback) return '';
  return `<div class="msg-tools">
    <button class="btn btn-ghost btn-sm" data-copy-answer="1" title="复制回答">${icon('copy')}<span>复制</span></button>
    ${feedback}
  </div>`;
}

function errorCardHtml(m) {
  const reason = m.errorMsg ? esc(m.errorMsg) : '可能是网络波动或模型服务暂时不可用。';
  return `<div class="card" style="margin-top:10px;padding:11px 13px;border-color:var(--c-danger);background:var(--c-danger-bg)">
    <div class="flex items-center gap-2 text-sm" style="color:var(--c-danger);font-weight:600">${icon('alert')} 回答生成失败</div>
    <div class="text-xs mt-1" style="color:var(--c-text-2);line-height:1.7">${reason}</div>
    <div class="mt-2"><button class="btn btn-sm btn-default" data-retry="1">${icon('refresh')}<span>重试</span></button></div>
  </div>`;
}

/**
 * 参考来源的渲染已抽到 ../citations.js（纯字符串构建，可在 Node 中单测）。
 * 这里只管折叠交互：默认收起，点标题展开；正文 [1] 角标会自动展开后再定位。
 */

function refreshMessage(m) {
  if (!S || !m || m.role === 'user') return;
  const node = qs(`[data-msg="${m.key}"]`, S.root);
  if (!node) return;
  const body = qs('.msg-body', node);
  if (body) body.innerHTML = assistantBodyHtml(m);
}

function updateRegion(m, region) {
  if (!S || !m) return;
  const node = qs(`[data-msg="${m.key}"]`, S.root);
  if (!node) return;
  const host = qs(`[data-${region}]`, node);
  if (!host) return;
  host.innerHTML = region === 'tools' ? toolsHtml(m) : citationsHtml(m);
}

function appendMessageNode(m) {
  if (!S) return;
  const host = qs('#chat-inner', S.root);
  if (!host) return;
  const node = el(messageHtml(m));
  if (node) host.appendChild(node);
  if (S.stick) scrollToBottom();
}

function flashCard(card) {
  const prevBorder = card.style.borderColor;
  const prevBg = card.style.background;
  card.style.borderColor = 'var(--c-ink)';
  card.style.background = 'var(--c-ink-100)';
  setTimer(() => {
    card.style.borderColor = prevBorder;
    card.style.background = prevBg;
  }, 1200);
}

/* ------------------------------------------------------------------ 反馈 */

async function submitFeedback(node) {
  if (!S) return;
  const m = findMessage(node.closest('[data-msg]')?.getAttribute('data-msg'));
  if (!m || !m.id) return;
  const value = Number(node.getAttribute('data-value')) || 1;
  const next = m.feedback === value ? 0 : value;
  try {
    await S.api.messageFeedback(m.id, next);
    if (!S) return;
    m.feedback = next;
    updateRegion(m, 'tools');
    if (next === 1) notify.success('感谢反馈，已记为有帮助');
    else if (next === -1) notify.info('已记录，我们会持续改进');
    else notify.info('已取消反馈');
  } catch (err) {
    notify.error(err?.message || '反馈提交失败');
  }
}

/* ------------------------------------------------------------------ 问答范围 */

function renderScopeChip() {
  if (!S) return;
  const chip = qs('#scope-chip', S.root);
  if (!chip) return;

  let label;
  if (S.scope.mode === 'all') label = '全部知识库';
  else if (S.scope.mode === 'files') label = `限定 ${S.scope.fileIds.length} 个文件`;
  else label = S.workspace.name;

  chip.innerHTML = `${icon('layers')}<span>${esc(label)}</span>${icon('chevronDown')}`;
  chip.title = S.scope.mode === 'files'
    ? `问答范围：${[...S.scope.fileNames.values()].join('、') || '指定文件'}`
    : `问答范围：${label}`;
}

function setScope(next) {
  if (!S) return;
  S.scope = next;
  renderScopeChip();
}

function openScopeMenu(anchor) {
  if (!S || !anchor) return;
  dropdown(anchor, [
    { label: '问答范围', header: true },
    {
      icon: 'layers', label: '当前知识库', hint: S.workspace.name,
      active: S.scope.mode === 'workspace',
      onClick: () => setScope({ mode: 'workspace', fileIds: [], fileNames: new Map() })
    },
    {
      icon: 'globe', label: '全部知识库', hint: '跨库检索',
      active: S.scope.mode === 'all',
      onClick: () => setScope({ mode: 'all', fileIds: [], fileNames: new Map() })
    },
    { sep: true },
    {
      icon: 'file',
      label: S.scope.fileIds.length ? `已限定 ${S.scope.fileIds.length} 个文件` : '限定到指定文件…',
      onClick: () => openFilePicker()
    }
  ], { align: 'start', width: 252 });
}

async function openFilePicker() {
  if (!S) return;
  let files = [];
  try {
    const res = await S.api.files({ workspaceId: S.workspace.id, limit: 40 });
    if (!S) return;
    files = Array.isArray(res?.files) ? res.files : [];
  } catch (err) {
    notify.error(err?.message || '文件列表加载失败');
    return;
  }
  if (!files.length) { notify.info('当前知识库还没有可用于问答的文档'); return; }

  const names = new Map(files.map((f) => [f.id, f.name]));
  const selected = new Set(S.scope.mode === 'files' ? S.scope.fileIds : []);

  let m = null;
  m = openModal({
    title: '限定问答文件',
    sub: '只在所选文档范围内检索并生成答案',
    size: 'md',
    body: `<div class="text-xs text-muted mb-2">已选 <span id="scope-picked">${selected.size}</span> / ${files.length} 个文件，最多 50 个。</div>
      <div id="scope-file-list" style="max-height:340px;overflow:auto;margin:0 -4px">${
        files.map((f) => `<div class="list-row" data-pick="${esc(f.id)}" title="${esc(f.name)}">
          <span class="checkbox${selected.has(f.id) ? ' is-checked' : ''}"></span>
          ${fileIconHtml(f.ext)}
          <div class="list-main">
            <div class="list-title">${esc(f.name)}</div>
            <div class="list-sub">${formatBytes(f.size)} · ${esc(timeAgo(f.updatedAt))}</div>
          </div>
        </div>`).join('')
      }</div>`,
    actions: [
      { label: '取消' },
      {
        label: '应用范围',
        primary: true,
        onClick: () => {
          if (!S) return;
          const picked = qsa('[data-pick]', m.body)
            .filter((n) => qs('.checkbox', n)?.classList.contains('is-checked'))
            .map((n) => n.getAttribute('data-pick'));
          if (picked.length > 50) { notify.warn('最多选择 50 个文件'); return false; }
          if (picked.length) {
            setScope({ mode: 'files', fileIds: picked, fileNames: new Map(picked.map((id) => [id, names.get(id) || id])) });
            notify.success(`已限定 ${picked.length} 个文件`);
          } else {
            setScope({ mode: 'workspace', fileIds: [], fileNames: new Map() });
            notify.info('已恢复为整个知识库');
          }
        }
      }
    ]
  });

  on(m.body, 'click', '[data-pick]', (e, row) => {
    const box = qs('.checkbox', row);
    if (!box) return;
    box.classList.toggle('is-checked');
    const counter = qs('#scope-picked', m.body);
    if (counter) counter.textContent = String(qsa('[data-pick]', m.body).filter((n) => qs('.checkbox', n)?.classList.contains('is-checked')).length);
  });
}

async function applyFileScope(fileId) {
  if (!S) return;
  let name = fileId;
  try {
    const res = await S.api.file(fileId);
    if (res?.file?.name) name = res.file.name;
  } catch { /* 仅用于展示名称，失败则退回文件 ID */ }
  if (!S) return;
  setScope({ mode: 'files', fileIds: [fileId], fileNames: new Map([[fileId, name]]) });
}

/* ------------------------------------------------------------------ 流式问答 */

function askPayload(question) {
  const payload = {
    question,
    workspaceId: S.scope.mode === 'all' ? 'all' : S.workspace.id
  };
  if (S.activeId) payload.chatId = S.activeId;
  if (S.scope.mode === 'files' && S.scope.fileIds.length) payload.fileIds = [...S.scope.fileIds];
  return payload;
}

function send(question) {
  if (!S) return;
  if (S.streaming) { notify.warn('正在生成回答，请先停止当前生成'); return; }
  const q = String(question ?? '').trim();
  if (!q) { notify.warn('请输入问题'); return; }

  const input = qs('#chat-input', S.root);
  if (input) { input.value = ''; autoGrow(); }

  const wasEmpty = S.messages.length === 0;
  const userMsg = { key: uid('u'), id: '', role: 'user', content: q, citations: [], feedback: 0, streaming: false, typing: false, error: false, errorMsg: '', model: '' };
  S.messages.push(userMsg);

  if (wasEmpty) renderThread();
  else appendMessageNode(userMsg);

  runAsk(q).catch(() => { /* runAsk 内部已处理错误 */ });
}

async function retryAnswer(failed) {
  if (!S || S.streaming) return;
  const q = questionBefore(failed);
  if (!q) { notify.warn('找不到对应的提问，请重新输入'); return; }
  const idx = S.messages.indexOf(failed);
  if (idx >= 0) S.messages.splice(idx, 1);
  qs(`[data-msg="${failed.key}"]`, S.root)?.remove();
  await runAsk(q);
}

async function runAsk(question) {
  if (!S) return;

  const asstMsg = {
    key: uid('a'), id: '', role: 'assistant', content: '', citations: [],
    feedback: 0, streaming: true, typing: true, error: false, errorMsg: '', model: ''
  };
  S.messages.push(asstMsg);
  appendMessageNode(asstMsg);

  S.streaming = true;
  updateComposer();
  scrollToBottom();

  const controller = new AbortController();
  S.abort = controller;

  let text = '';
  let painted = false;
  let streamError = '';
  let stopped = false;

  const paint = () => {
    rafId = 0;
    painted = false;
    if (!S) return;
    const node = qs(`[data-msg="${asstMsg.key}"] .msg-content`, S.root);
    if (!node) return;
    asstMsg.content = text;
    node.innerHTML = renderChatMarkdown(text);
    if (S.streaming && text) node.classList.add('cursor-blink');
    if (S.stick) scrollToBottom();
  };

  const schedule = () => {
    if (painted) return;
    painted = true;
    rafId = requestAnimationFrame(paint);
  };

  const onToken = (piece) => {
    text += piece || '';
    if (asstMsg.typing) {
      asstMsg.typing = false;
      asstMsg.content = text;
      refreshMessage(asstMsg);
      if (S.stick) scrollToBottom();
      return;
    }
    schedule();
  };

  const onContexts = (data) => {
    const list = Array.isArray(data?.citations) ? data.citations : [];
    if (!list.length) return;
    asstMsg.citations = list;
    updateRegion(asstMsg, 'cites');
  };

  let result = null;
  try {
    result = await S.api.ask(askPayload(question), {
      signal: controller.signal,
      onStart: (data) => {
        if (!S || !data?.chatId) return;
        // 服务端在首个事件中就会创建/绑定会话，立即同步侧栏与标题
        if (S.activeId !== data.chatId) {
          S.activeId = data.chatId;
          renderList();
          renderHead();
        }
      },
      onContexts,
      onToken,
      onDone: (data) => {
        asstMsg.streaming = false;
        asstMsg.typing = false;
        if (data?.messageId) asstMsg.id = data.messageId;
        if (data?.model) asstMsg.model = data.model;
        if (Array.isArray(data?.citations) && data.citations.length) asstMsg.citations = data.citations;
        // 「未引用知识库 · 通用回答」标记：必须在界面上如实呈现
        asstMsg.general = !!data?.general;
        asstMsg.noContext = !!data?.noContext;
        asstMsg.interrupted = !!data?.interrupted;
      },
      onError: (err) => { streamError = err?.message || '生成失败'; }
    });
  } catch (err) {
    if (err?.name === 'AbortError') stopped = true;
    else streamError = err?.message || '生成失败';
  }

  if (!S) return;

  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; painted = false; }

  S.streaming = false;
  S.abort = null;

  asstMsg.streaming = false;
  asstMsg.typing = false;

  if (result) {
    asstMsg.content = result.content || text;
    if (result.chatId) S.activeId = result.chatId;
    if (result.messageId) asstMsg.id = result.messageId;
    if (result.model) asstMsg.model = result.model;
    if (Array.isArray(result.citations) && result.citations.length) asstMsg.citations = result.citations;
  } else {
    asstMsg.content = text;
  }

  // 配置了大模型但调用失败时会回退本地引擎：必须如实展示，避免"用了大模型却没反应"
  if (result && result.error) {
    asstMsg.error = true;
    asstMsg.errorMsg = `大模型调用失败：${result.error}`;
    notify.warn(`大模型调用失败，已回退内置本地引擎：${result.error}`);
    loadAiStatus();
  }

  if (!stopped && streamError) {
    asstMsg.error = true;
    asstMsg.errorMsg = streamError;
  }
  if (stopped && !asstMsg.content) asstMsg.content = '（已停止生成）';

  refreshMessage(asstMsg);
  updateComposer();
  if (S.stick) scrollToBottom();

  if (stopped) notify.info('已停止生成');
  else if (streamError) notify.error(streamError);

  if (S.activeId) {
    renderHead();
    loadChatsSilently();
  }
}

/** 生成结束后静默刷新会话列表（标题 / 时间 / 排序） */
async function loadChatsSilently() {
  if (!S) return;
  const api = S.api;
  try {
    const res = await api.chats({ workspaceId: S.workspace.id });
    if (!S) return;
    S.chats = Array.isArray(res?.chats) ? res.chats : S.chats;
    sortChats();
    renderList();
    renderHead();
  } catch { /* 列表刷新失败不影响当前会话 */ }
}

function stopStream() {
  if (!S || !S.abort) return;
  try { S.abort.abort(); } catch { /* 忽略 */ }
}

/* ------------------------------------------------------------------ 输入区 */

function updateComposer() {
  if (!S) return;
  const btn = qs('#chat-send', S.root);
  if (!btn) return;
  if (S.streaming) {
    btn.className = 'btn btn-danger-solid btn-sm';
    btn.innerHTML = `${icon('stop')}<span>停止生成</span>`;
  } else {
    btn.className = 'btn btn-primary btn-sm';
    btn.innerHTML = `${icon('send')}<span>发送</span>`;
  }
}

function autoGrow() {
  if (!S) return;
  const ta = qs('#chat-input', S.root);
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(200, Math.max(24, ta.scrollHeight || 24))}px`;
}

/* ------------------------------------------------------------------ 滚动 */

function isAtBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 90;
}

function scrollToBottom() {
  if (!S) return;
  const node = qs('#chat-scroll', S.root);
  if (!node) return;
  node.scrollTop = node.scrollHeight;
  S.stick = true;
  showJump(false);
}

function showJump(show) {
  if (!S) return;
  const wrap = qs('#chat-jump-wrap', S.root);
  if (!wrap) return;
  wrap.style.display = show ? 'flex' : 'none';
}

/* ------------------------------------------------------------------ 状态探测 */

async function loadAiStatus() {
  if (!S) return;
  const api = S.api;
  try {
    const res = await api.aiStatus();
    if (!S) return;
    S.ai = res || null;
    renderAiHint();
  } catch { /* 探测失败不阻断问答 */ }
}

export default { meta, mount, unmount };
