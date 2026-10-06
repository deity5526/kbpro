/**
 * KBPRO — 首页 / 知识库概览
 * 作为页面实现的规范参考：mount(container, ctx)
 */
import {
  qs, qsa, el, on, applyIcons, icon, notify, modal, dropdown, esc, emptyState,
  timeAgo, formatBytes, formatNumber, greeting, fileIconHtml, avatarHtml, roleLabel,
  skeleton, tagHtml
} from '../ui.js';

export const meta = { title: '首页', icon: 'home' };

let cleanup = [];

export async function mount(container, ctx) {
  const { api, workspace } = ctx;
  if (!workspace) {
    container.innerHTML = `<div class="page">${emptyState({ iconName: 'layers', title: '还没有知识库', desc: '请先在左上角创建一个知识库' })}</div>`;
    return;
  }

  container.innerHTML = `<div class="page">
    <div id="dash-hero"></div>
    <div id="dash-body">${skeleton(4)}</div>
  </div>`;

  let data;
  try {
    data = await api.overview(workspace.id);
  } catch (err) {
    qs('#dash-body', container).innerHTML = emptyState({
      iconName: 'alert', title: '加载失败', desc: esc(err.message),
      actions: '<button class="btn btn-default" data-retry>重试</button>'
    });
    on(container, 'click', '[data-retry]', () => mount(container, ctx));
    return;
  }

  const { stats, recentFiles, recentNotes, topTags, trend, members } = data;

  /* ---------------------------------------------------------- Hero */
  qs('#dash-hero', container).innerHTML = `
    <section class="hero">
      <div class="hero-greet">${esc(greeting())}，${esc(ctx.store.user?.name || '')}</div>
      <h1 class="hero-title">${esc(workspace.name)}</h1>
      <p class="hero-sub">
        ${workspace.kind === 'team'
          ? `团队知识库 · ${stats.members} 位成员协作 · 已沉淀 ${stats.files} 份文档与 ${stats.notes} 篇笔记`
          : `个人知识库 · 已沉淀 ${stats.files} 份文档与 ${stats.notes} 篇笔记 · 索引 ${formatNumber(stats.chunks)} 个知识块`}
      </p>
      <div class="hero-actions">
        <button class="btn btn-primary" data-act="upload">${icon('upload')}<span>上传文档</span></button>
        <button class="btn btn-default" data-act="ask">${icon('sparkle')}<span>向知识库提问</span></button>
        <button class="btn btn-default" data-act="note">${icon('note')}<span>新建笔记</span></button>
        <button class="btn btn-default" data-act="search">${icon('search')}<span>全局检索</span></button>
      </div>
    </section>`;

  /* ---------------------------------------------------------- 主体 */
  const parseTotal = stats.parse.ok + stats.parse.pending + stats.parse.failed;
  const parsePercent = parseTotal ? Math.round((stats.parse.ok / parseTotal) * 100) : 100;

  qs('#dash-body', container).innerHTML = `
    <div class="grid grid-4 mb-6">
      ${statCard('文档总数', formatNumber(stats.files), 'file', `已索引 ${formatNumber(stats.chunks)} 个知识块`)}
      ${statCard('笔记篇数', formatNumber(stats.notes), 'note', `${stats.folders} 个文件夹 · ${topTags.length} 个标签`)}
      ${statCard('存储占用', stats.sizeText, 'database', `${stats.starred} 收藏 · ${stats.pinned} 置顶`)}
      ${statCard('解析进度', `${parsePercent}%`, 'activity',
        stats.parse.pending ? `${stats.parse.pending} 个解析中` : (stats.parse.failed ? `${stats.parse.failed} 个失败` : '全部就绪'))}
    </div>

    <div class="grid mb-6" style="grid-template-columns:minmax(0,1.62fr) minmax(0,1fr);gap:16px" id="dash-row-2">
      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('chart')} 近 14 天沉淀趋势</div>
              <div class="section-sub">文档与笔记的新增节奏</div>
            </div>
            <div class="legend">
              <span class="legend-item"><span class="legend-dot" style="background:var(--c-ink)"></span>文档</span>
              <span class="legend-item"><span class="legend-dot" style="background:var(--c-ink-300)"></span>笔记</span>
            </div>
          </div>
          ${renderTrend(trend)}
        </div>
      </div>

      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div class="section-title">${icon('tag')} 知识标签</div>
            <div class="section-actions"><button class="btn btn-sm btn-ghost" data-act="tags">全部</button></div>
          </div>
          ${topTags.length
            ? `<div class="tag-cloud">${topTags.map((t) => `<span class="tag tag-btn" data-tag="${esc(t.name)}" title="${t.count} 项">${esc(t.name)}<span class="text-muted" style="margin-left:3px">${t.count}</span></span>`).join('')}</div>`
            : `<div class="text-sm text-muted">给文件或笔记打上标签后，这里会形成知识脉络。</div>`}
          <hr class="hr">
          <div class="stat-inline">
            <div class="stat-inline-item"><span class="stat-inline-value">${formatNumber(stats.chunks)}</span><span class="stat-inline-label">知识块</span></div>
            <div class="stat-inline-item"><span class="stat-inline-value">${formatNumber(stats.chats)}</span><span class="stat-inline-label">问答会话</span></div>
            <div class="stat-inline-item"><span class="stat-inline-value">${stats.parse.ok}</span><span class="stat-inline-label">已解析</span></div>
          </div>
        </div>
      </div>
    </div>

    <div class="grid mb-6" style="grid-template-columns:repeat(2,minmax(0,1fr));gap:16px" id="dash-row-3">
      <div class="card">
        <div class="card-pad" style="padding-bottom:8px">
          <div class="section-head">
            <div class="section-title">${icon('file')} 最近文档</div>
            <div class="section-actions">
              <button class="btn btn-sm btn-ghost" data-act="files">查看全部</button>
            </div>
          </div>
        </div>
        <div style="padding:0 8px 10px">
          ${recentFiles.length ? recentFiles.map(fileRowHtml).join('') : '<div class="empty" style="padding:32px 16px"><div class="empty-ico">' + icon('file') + '</div><div class="empty-desc">还没有文档，点击「上传文档」开始沉淀知识。</div></div>'}
        </div>
      </div>

      <div class="card">
        <div class="card-pad" style="padding-bottom:8px">
          <div class="section-head">
            <div class="section-title">${icon('note')} 最近笔记</div>
            <div class="section-actions">
              <button class="btn btn-sm btn-ghost" data-act="notes">查看全部</button>
            </div>
          </div>
        </div>
        <div style="padding:0 8px 10px">
          ${recentNotes.length ? recentNotes.map(noteRowHtml).join('') : '<div class="empty" style="padding:32px 16px"><div class="empty-ico">' + icon('note') + '</div><div class="empty-desc">还没有笔记，新建一篇记录你的想法。</div></div>'}
        </div>
      </div>
    </div>

    ${workspace.kind === 'team' && members.length ? `
    <div class="card mb-6">
      <div class="card-pad">
        <div class="section-head">
          <div class="section-title">${icon('users')} 协作成员</div>
          <div class="section-actions"><button class="btn btn-sm btn-default" data-act="team">管理成员</button></div>
        </div>
        <div class="flex flex-wrap gap-4">
          ${members.map((m) => `<div class="flex items-center gap-2">
            ${avatarHtml(m, 'sm')}
            <div><div class="text-sm font-medium">${esc(m.name)}</div><div class="text-xs text-muted">${esc(roleLabel(m.role))}</div></div>
          </div>`).join('')}
        </div>
      </div>
    </div>` : ''}

    <div class="card">
      <div class="card-pad">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('sparkle')} 基于你的知识库提问</div>
            <div class="section-sub">答案会标注来源文档与页码，可追溯</div>
          </div>
        </div>
        <div class="search-box mb-4">
          <span class="sb-ico">${icon('sparkle')}</span>
          <input class="input" id="dash-ask" placeholder="例如：这份报告的核心结论是什么？" style="height:38px">
        </div>
        <div class="flex flex-wrap gap-2">
          ${['总结一下当前知识库的主要内容', '有哪些风险需要注意？', '列出关键数据与指标'].map((q) =>
            `<span class="chip chip-btn" data-prompt="${esc(q)}">${esc(q)}</span>`).join('')}
        </div>
      </div>
    </div>`;

  applyIcons(container);
  bindEvents(container, ctx);
}

/* ------------------------------------------------------------------ 片段 */

function statCard(label, value, iconName, foot) {
  return `<div class="card stat-card card-hover">
    <div class="stat-top">
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-ico">${icon(iconName)}</span>
    </div>
    <div class="stat-value">${esc(value)}</div>
    <div class="stat-foot">${esc(foot)}</div>
  </div>`;
}

function renderTrend(trend) {
  if (!trend?.length) return '';
  const max = Math.max(1, ...trend.map((d) => d.files + d.notes));
  const now = Date.now();
  return `<div class="bar-chart">${trend.map((d, i) => {
    const fh = Math.round((d.files / max) * 74);
    const nh = Math.round((d.notes / max) * 74);
    const isToday = i === trend.length - 1;
    const label = isToday ? '今天' : `${new Date(d.date).getMonth() + 1}/${new Date(d.date).getDate()}`;
    return `<div class="bar-col" title="${d.date}：${d.files} 文档 · ${d.notes} 笔记">
      <div class="bar-stack">
        ${nh ? `<div class="bar-seg notes" style="height:${nh}px"></div>` : ''}
        ${fh ? `<div class="bar-seg files" style="height:${fh}px"></div>` : ''}
        ${!fh && !nh ? '<div class="bar-seg" style="height:2px;background:var(--c-ink-100)"></div>' : ''}
      </div>
      <div class="bar-x">${i % 2 === 0 || isToday ? label : ''}</div>
    </div>`;
  }).join('')}</div>`;
}

function fileRowHtml(f) {
  return `<div class="list-row" data-file="${esc(f.id)}">
    ${fileIconHtml(f.ext)}
    <div class="list-main">
      <div class="list-title">${esc(f.name)}</div>
      <div class="list-sub">${formatBytes(f.size)}${f.pinned ? ' · 已置顶' : ''}${f.starred ? ' · 已收藏' : ''}</div>
    </div>
    <div class="list-time">${esc(timeAgo(f.updated_at))}</div>
  </div>`;
}

function noteRowHtml(n) {
  return `<div class="list-row" data-note="${esc(n.id)}">
    <span class="file-ico f-md" style="background:var(--c-ink-100);color:var(--c-ink-700)">${esc(n.emoji || 'NOTE')}</span>
    <div class="list-main">
      <div class="list-title">${esc(n.title)}</div>
      <div class="list-sub">${formatNumber(n.word_count)} 字</div>
    </div>
    <div class="list-time">${esc(timeAgo(n.updated_at))}</div>
  </div>`;
}

/* ------------------------------------------------------------------ 事件 */

function bindEvents(container, ctx) {
  const { navigate, workspace } = ctx;

  const offs = [];

  offs.push(on(container, 'click', '[data-act]', (e, node) => {
    const act = node.getAttribute('data-act');
    if (act === 'upload') document.dispatchEvent(new CustomEvent('kbpro:upload-request'));
    else if (act === 'ask') navigate('chat');
    else if (act === 'note') { navigate('notes'); setTimeout(() => document.dispatchEvent(new CustomEvent('kbpro:new-note')), 280); }
    else if (act === 'search') navigate('search');
    else if (act === 'files') navigate('files');
    else if (act === 'notes') navigate('notes');
    else if (act === 'team') navigate('team');
    else if (act === 'tags') navigate('search');
  }));

  offs.push(on(container, 'click', '[data-file]', (e, node) => {
    navigate('files', [], { open: node.getAttribute('data-file') });
  }));

  offs.push(on(container, 'click', '[data-note]', (e, node) => {
    navigate('notes', [node.getAttribute('data-note')]);
  }));

  offs.push(on(container, 'click', '[data-tag]', (e, node) => {
    navigate('search', [], { tags: node.getAttribute('data-tag') });
  }));

  offs.push(on(container, 'click', '[data-prompt]', (e, node) => {
    navigate('chat', [], { q: node.getAttribute('data-prompt') });
  }));

  const askInput = qs('#dash-ask', container);
  if (askInput) {
    const submit = () => {
      const q = askInput.value.trim();
      if (!q) { notify.warn('请输入问题'); return; }
      navigate('chat', [], { q });
    };
    askInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    offs.push(() => askInput.removeEventListener('keydown', submit));
  }

  cleanup = offs;
}

export function unmount() {
  for (const off of cleanup) {
    try { typeof off === 'function' && off(); } catch { /* */ }
  }
  cleanup = [];
}

export default { meta, mount, unmount };
