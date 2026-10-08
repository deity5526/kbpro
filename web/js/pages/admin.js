/**
 * KBPRO — 系统管理（管理员）
 * 概览 / 备份与恢复 / 审计日志 / 实例设置
 */
import {
  qs, qsa, on, applyIcons, icon, notify, modal, confirmDialog, emptyState, esc,
  badge, skeleton, downloadUrl, withLoading, debounce,
  formatBytes, formatNumber, formatDateTime, timeAgo
} from '../ui.js';
import { isAdmin } from '../store.js';

export const meta = { title: '系统管理', icon: 'shield' };

/* ------------------------------------------------------------------ 常量 */

const BACKUP_KINDS = [
  { value: 'full', label: '全量备份（数据库 + 全部文件）' },
  { value: 'metadata', label: '仅元数据（数据库，不含文件）' },
  { value: 'workspace', label: '指定知识库' }
];

const BACKUP_KIND_LABEL = { full: '全量', metadata: '仅元数据', workspace: '指定知识库' };

const AI_PROVIDERS = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'ollama', label: 'ollama' },
  { value: 'openai', label: 'openai' },
  { value: 'local', label: 'local' }
];

const COUNT_LABELS = {
  users: '用户', workspaces: '知识库', folders: '文件夹', files: '文件', notes: '笔记',
  note_versions: '笔记版本', chunks: '知识块', shares: '分享', comments: '评论',
  chats: '问答会话', messages: '消息', access_logs: '审计日志', backups: '备份',
  tags: '标签', team_members: '团队成员'
};

const COUNT_ORDER = [
  'users', 'workspaces', 'files', 'notes', 'chunks', 'folders', 'tags',
  'chats', 'messages', 'shares', 'comments', 'note_versions', 'team_members', 'access_logs', 'backups'
];

const PAGE_SIZE = 100;

let cleanup = [];
let logState = { limit: PAGE_SIZE, offset: 0, total: 0, action: '', q: '', workspaceId: '' };

/* ------------------------------------------------------------------ 挂载 */

export async function mount(container, ctx) {
  if (!isAdmin()) {
    container.innerHTML = `<div class="page">
      <div class="card">${emptyState({
        iconName: 'lock',
        title: '需要管理员权限',
        desc: '系统管理包含实例级设置、备份恢复与全部审计日志，仅管理员账号可访问。',
        actions: '<button class="btn btn-default" data-act="back">返回首页</button>'
      })}</div>
    </div>`;
    cleanup = [on(container, 'click', '[data-act="back"]', () => ctx.navigate('dashboard'))];
    return;
  }

  logState = { limit: PAGE_SIZE, offset: 0, total: 0, action: '', q: '', workspaceId: '' };

  container.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">系统管理</h1>
        <p class="page-desc">实例运行状态、备份恢复、审计日志与全局设置</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" data-act="refresh-tab">${icon('refresh')}<span>刷新当前页</span></button>
      </div>
    </div>

    <div class="tabs" role="tablist">
      <button class="tab is-active" data-tab="overview" role="tab">概览</button>
      <button class="tab" data-tab="backup" role="tab">备份与恢复</button>
      <button class="tab" data-tab="logs" role="tab">审计日志</button>
      <button class="tab" data-tab="settings" role="tab">实例设置</button>
    </div>

    <section class="tab-panel" data-panel="overview"></section>
    <section class="tab-panel" data-panel="backup" hidden></section>
    <section class="tab-panel" data-panel="logs" hidden></section>
    <section class="tab-panel" data-panel="settings" hidden></section>
  </div>`;

  const offs = [];
  const activeTab = () => qs('.tab.is-active', container)?.getAttribute('data-tab') || 'overview';

  offs.push(on(container, 'click', '[data-tab]', (e, node) => {
    const tab = node.getAttribute('data-tab');
    qsa('[data-tab]', container).forEach((n) => n.classList.toggle('is-active', n === node));
    qsa('[data-panel]', container).forEach((p) => { p.hidden = p.getAttribute('data-panel') !== tab; });
    if (tab === 'settings') loadSettings(container, ctx);
  }));

  offs.push(on(container, 'click', '[data-act="refresh-tab"]', async (e, node) => {
    const tab = activeTab();
    await withLoading(node, async () => {
      if (tab === 'overview') await loadOverview(container, ctx);
      else if (tab === 'backup') await loadBackups(container, ctx);
      else if (tab === 'logs') await loadLogs(container, ctx);
      else if (tab === 'settings') await loadSettings(container, ctx);
    })();
  }));

  offs.push(...bindOverview(container, ctx));
  offs.push(...bindBackups(container, ctx));
  offs.push(...bindLogs(container, ctx));
  offs.push(...bindSettings(container, ctx));

  applyIcons(container);
  cleanup = offs;

  loadOverview(container, ctx);
  loadBackups(container, ctx);
}

export function unmount() {
  for (const off of cleanup) {
    try { typeof off === 'function' && off(); } catch { /* 忽略 */ }
  }
  cleanup = [];
}

/* ================================================================== 概览 */

function bindOverview(container, ctx) {
  const offs = [];
  const panel = qs('[data-panel="overview"]', container);

  offs.push(on(panel, 'click', '[data-act="retry-overview"]', () => loadOverview(container, ctx)));

  /* 数据表分布：点击行可复制表名 */
  offs.push(on(panel, 'click', '[data-count-key]', (e, node) => {
    notify.info(`表名：${node.getAttribute('data-count-key')}`);
  }));

  return offs;
}

async function loadOverview(container, ctx) {
  const panel = qs('[data-panel="overview"]', container);
  if (!panel) return;
  panel.innerHTML = `<div class="card"><div class="card-pad">${skeleton(4)}</div></div>`;
  try {
    const data = await ctx.api.systemStats();
    panel.innerHTML = overviewHtml(data);
    applyIcons(panel);
  } catch (err) {
    panel.innerHTML = `<div class="card"><div class="card-pad">
      ${emptyState({
        iconName: 'alert', title: '系统信息加载失败', desc: esc(err?.message || '未知错误'),
        actions: '<button class="btn btn-default" data-act="retry-overview">重试</button>'
      })}
    </div></div>`;
    applyIcons(panel);
  }
}

function overviewHtml(data) {
  const counts = data?.counts || {};
  const db = data?.database || {};
  const runtime = data?.runtime || {};
  const ai = data?.ai || {};

  const aiProvider = ai.provider || 'local';
  const aiAvailable = aiProvider === 'local' ? true : Boolean(ai.available);

  return `
    <div class="grid grid-4 mb-6">
      ${statCard('用户', formatNumber(counts.users), 'user', '含管理员与普通成员')}
      ${statCard('知识库', formatNumber(counts.workspaces), 'layers', `${formatNumber(counts.folders)} 个文件夹`)}
      ${statCard('文件', formatNumber(counts.files), 'file', `${formatNumber(counts.tags)} 个标签`)}
      ${statCard('笔记', formatNumber(counts.notes), 'note', `${formatNumber(counts.note_versions)} 个历史版本`)}
      ${statCard('知识块', formatNumber(counts.chunks), 'layers', 'RAG 检索的最小单元')}
      ${statCard('数据库体积', db.sizeText || formatBytes(db.bytes), 'database', `${formatNumber(db.bytes)} 字节`)}
      ${statCard('运行时长', runtime.uptimeText || '—', 'clock', `进程 PID ${esc(String(runtime.pid ?? '—'))}`)}
      ${statCard('内存占用', `${formatNumber(runtime.memoryMB)} MB`, 'activity', 'Node 进程 RSS')}
    </div>

    <div class="grid mb-6" style="grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px">
      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('robot')} AI 引擎</div>
              <div class="section-sub">${esc(ai.note || '')}</div>
            </div>
            <div class="flex items-center gap-2">
              ${badge(aiProvider, aiProvider === 'local' ? 'info' : '')}
              ${aiAvailable ? badge('可用', 'success') : badge('不可用', 'danger')}
            </div>
          </div>
          <div class="stat-inline">
            <div class="stat-inline-item"><span class="stat-inline-value">${esc(ai.model || '—')}</span><span class="stat-inline-label">对话模型</span></div>
            <div class="stat-inline-item"><span class="stat-inline-value">${formatNumber((ai.models || []).length)}</span><span class="stat-inline-label">可用模型</span></div>
            <div class="stat-inline-item"><span class="stat-inline-value text-mono" style="font-size:var(--fs-sm);word-break:break-all">${esc(ai.baseUrl || '—')}</span><span class="stat-inline-label">接口地址</span></div>
          </div>
          ${(ai.models || []).length ? `<div class="flex flex-wrap gap-1 mt-4">${
            (ai.models || []).slice(0, 16).map((m) => `<span class="chip">${esc(m)}</span>`).join('')
          }</div>` : ''}
        </div>
      </div>

      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div class="section-title">${icon('info')} 运行时</div>
          </div>
          <dl class="kv">
            <dt>Node 版本</dt><dd class="text-mono">${esc(runtime.node || '—')}</dd>
            <dt>操作系统</dt><dd class="text-mono">${esc(runtime.platform || '—')}</dd>
            <dt>应用版本</dt><dd class="text-mono">${esc(data?.version || '—')}</dd>
            <dt>运行时长</dt><dd>${esc(runtime.uptimeText || '—')}<span class="text-muted"> · 约 ${formatNumber(Math.round(Number(runtime.uptime || 0) / 86400))} 天</span></dd>
            <dt>内存占用</dt><dd>${formatNumber(runtime.memoryMB)} MB</dd>
          </dl>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-pad" style="padding-bottom:6px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('database')} 数据表分布</div>
            <div class="section-sub">共 ${formatNumber(Object.values(counts).reduce((s, n) => s + Number(n || 0), 0))} 条记录</div>
          </div>
        </div>
      </div>
      <table class="table">
        <thead><tr><th>数据表</th><th>说明</th><th class="num">记录数</th></tr></thead>
        <tbody>
          ${orderedCountKeys(counts).map((key) => `<tr data-count-key="${esc(key)}" style="cursor:default">
            <td><span class="text-mono">${esc(key)}</span></td>
            <td class="text-muted">${esc(COUNT_LABELS[key] || '—')}</td>
            <td class="num">${formatNumber(counts[key])}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function orderedCountKeys(counts) {
  const keys = Object.keys(counts || {});
  keys.sort((a, b) => {
    const ia = COUNT_ORDER.indexOf(a);
    const ib = COUNT_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return keys;
}

function statCard(label, value, iconName, foot) {
  return `<div class="card stat-card">
    <div class="stat-top">
      <span class="stat-label">${esc(label)}</span>
      <span class="stat-ico">${icon(iconName)}</span>
    </div>
    <div class="stat-value">${esc(String(value ?? '—'))}</div>
    <div class="stat-foot">${esc(foot || '')}</div>
  </div>`;
}

/* ================================================================== 备份与恢复 */

function renderBackupShell(container) {
  const panel = qs('[data-panel="backup"]', container);
  panel.innerHTML = `
    <div class="grid mb-6" style="grid-template-columns:minmax(0,1.05fr) minmax(0,1fr);gap:16px">
      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('archive')} 创建备份</div>
              <div class="section-sub">备份文件保存在服务端 backups 目录</div>
            </div>
          </div>

          <div class="field">
            <label>备份类型</label>
            <select class="select" id="bk-kind">
              ${BACKUP_KINDS.map((k) => `<option value="${esc(k.value)}">${esc(k.label)}</option>`).join('')}
            </select>
            <div class="field-hint" id="bk-kind-hint">全量备份会打包数据库快照与全部原始文件，数据量大时可能耗时较长，请耐心等待并避免中途刷新页面。</div>
          </div>

          <div class="field" id="bk-ws-field" hidden>
            <label>指定知识库</label>
            <select class="select" id="bk-ws"></select>
          </div>

          <div class="field">
            <label class="flex items-center gap-2" style="cursor:pointer">
              <input type="checkbox" id="bk-encrypt">
              <span>使用口令加密（导出 .kbpro 包）</span>
            </label>
            <div class="field-hint">加密后即使备份文件外泄，没有口令也无法还原。</div>
          </div>

          <div class="field" id="bk-pwd-field" hidden>
            <label>加密口令</label>
            <input class="input" type="password" id="bk-pwd" autocomplete="new-password" placeholder="至少 6 位">
            <div class="field-hint">口令不会保存在服务器上，请务必自行记牢——忘记口令将无法恢复该备份。</div>
          </div>

          <div class="field">
            <label>备注</label>
            <input class="input" id="bk-note" maxlength="200" placeholder="例如：发布 v1.2 前的例行备份">
          </div>

          <button class="btn btn-primary" data-act="create-backup">${icon('plus')}<span>开始备份</span></button>
        </div>
      </div>

      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div class="section-title">${icon('info')} 三种备份包含什么</div>
          </div>
          <div class="setting-desc" style="line-height:1.85">
            <strong>全量备份</strong>：数据库快照（用户、知识库、笔记、索引元数据）+ 全部原始文件。<br>
            适合迁移实例或灾难恢复，<strong>打包耗时较长</strong>，建议在低峰期执行。<br><br>
            <strong>仅元数据</strong>：只有数据库快照，不含原始文件。体积很小，适合定期留存结构化数据，恢复后文件需要另行补齐。<br><br>
            <strong>指定知识库</strong>：该知识库的文件夹、笔记、标签与原始文件。恢复时会作为一个新的「知识库（导入）」创建，不会覆盖现有数据。
          </div>
          <hr class="hr">
          <div class="setting-desc" style="line-height:1.85">
            勾选加密后导出的是 <code class="text-mono">.kbpro</code> 包，内部使用 scrypt 派生密钥 + AES-256-GCM 加密。
            <strong>只要有口令即可恢复</strong>，不依赖创建它的那台机器；反过来，口令丢失就没有任何后门可以解开。
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-pad" style="padding-bottom:6px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('list')} 备份列表</div>
            <div class="section-sub" id="bk-summary">加载中…</div>
          </div>
          <div class="section-actions">
            <button class="btn btn-sm btn-default" data-act="reload-backups">${icon('refresh')}<span>刷新</span></button>
          </div>
        </div>
      </div>
      <div id="bk-list">${skeleton(3)}</div>
    </div>`;

  applyIcons(panel);
}

async function loadBackups(container, ctx) {
  const panel = qs('[data-panel="backup"]', container);
  if (!panel) return;
  if (!qs('#bk-list', panel)) renderBackupShell(container);

  const host = qs('#bk-list', panel);
  const summary = qs('#bk-summary', panel);
  try {
    const data = await ctx.api.backups();
    const list = Array.isArray(data?.backups) ? data.backups : [];
    if (summary) summary.textContent = `共 ${list.length} 个备份 · 合计 ${data?.totalText || formatBytes(data?.total || 0)}`;
    host.innerHTML = list.length ? backupsTable(list) : emptyState({
      iconName: 'archive', title: '还没有备份', desc: '建议在做大改动之前先创建一份全量备份'
    });
    applyIcons(host);
    fillWorkspaceOptions(container, ctx);
  } catch (err) {
    if (summary) summary.textContent = '加载失败';
    host.innerHTML = emptyState({
      iconName: 'alert', title: '备份列表加载失败', desc: esc(err?.message || '未知错误'),
      actions: '<button class="btn btn-default" data-act="reload-backups">重试</button>'
    });
    applyIcons(host);
  }
}

function fillWorkspaceOptions(container, ctx) {
  const select = qs('#bk-ws', container);
  if (!select) return;
  const workspaces = ctx.store?.workspaces || [];
  const prev = select.value;
  select.innerHTML = workspaces.length
    ? workspaces.map((w) => `<option value="${esc(w.id)}">${esc(w.name)}${w.kind === 'team' ? '（团队）' : ''}</option>`).join('')
    : '<option value="">暂无可用知识库</option>';
  if (prev && workspaces.some((w) => w.id === prev)) select.value = prev;
}

function backupsTable(list) {
  return `<table class="table">
    <thead>
      <tr>
        <th>名称</th><th>类型</th><th class="num">大小</th><th>加密</th>
        <th>创建时间</th><th>创建者</th><th>文件</th><th class="text-right">操作</th>
      </tr>
    </thead>
    <tbody>
      ${list.map((b) => {
        const kind = BACKUP_KIND_LABEL[b.kind] || esc(b.kind || '—');
        return `<tr data-backup="${esc(b.id)}" data-kind="${esc(b.kind || '')}" data-encrypted="${b.encrypted ? '1' : '0'}" data-exists="${b.exists ? '1' : '0'}">
          <td><div class="truncate" style="max-width:280px" title="${esc(b.name)}">${esc(b.name)}${b.note ? `<div class="text-xs text-muted truncate">${esc(b.note)}</div>` : ''}</div></td>
          <td>${badge(kind, b.kind === 'full' ? '' : 'info')}</td>
          <td class="num">${esc(formatBytes(b.size))}</td>
          <td>${b.encrypted ? badge('已加密', 'success') : '<span class="text-muted">否</span>'}</td>
          <td class="text-xs text-muted nowrap">${esc(formatDateTime(b.createdAt))}<div class="text-xs">${esc(timeAgo(b.createdAt))}</div></td>
          <td class="text-xs">${esc(b.createdBy || '—')}</td>
          <td>${b.exists ? '<span class="text-success">存在</span>' : '<span class="text-danger">已丢失</span>'}</td>
          <td class="text-right nowrap">
            <button class="btn btn-sm btn-ghost" data-act="download-backup" data-id="${esc(b.id)}" data-name="${esc(b.name)}" ${b.exists ? '' : 'disabled'}>${icon('download')}<span>下载</span></button>
            <button class="btn btn-sm btn-ghost" data-act="restore-backup" data-id="${esc(b.id)}">${icon('refresh')}<span>恢复</span></button>
            <button class="btn btn-sm btn-ghost text-danger" data-act="delete-backup" data-id="${esc(b.id)}" data-name="${esc(b.name)}">${icon('trash')}<span>删除</span></button>
          </td>
        </tr>`;
      }).join('')}
    </tbody>
  </table>`;
}

function bindBackups(container, ctx) {
  const offs = [];
  const panel = qs('[data-panel="backup"]', container);

  offs.push(on(panel, 'change', '#bk-kind', () => {
    const kind = qs('#bk-kind', panel)?.value;
    const wsField = qs('#bk-ws-field', panel);
    const hint = qs('#bk-kind-hint', panel);
    if (wsField) wsField.hidden = kind !== 'workspace';
    if (hint) {
      hint.textContent = kind === 'full'
        ? '全量备份会打包数据库快照与全部原始文件，数据量大时可能耗时较长，请耐心等待并避免中途刷新页面。'
        : kind === 'metadata'
          ? '仅含数据库快照，体积小、速度快，但不包含原始文件。'
          : '仅打包所选知识库的文件夹、笔记、标签与原始文件，恢复时作为新知识库导入。';
    }
  }));

  offs.push(on(panel, 'change', '#bk-encrypt', () => {
    const checked = Boolean(qs('#bk-encrypt', panel)?.checked);
    const field = qs('#bk-pwd-field', panel);
    if (field) field.hidden = !checked;
  }));

  offs.push(on(panel, 'click', '[data-act="reload-backups"]', () => loadBackups(container, ctx)));

  offs.push(on(panel, 'click', '[data-act="create-backup"]', async (e, node) => {
    const kind = qs('#bk-kind', panel).value;
    const workspaceId = qs('#bk-ws', panel)?.value || '';
    const encrypt = Boolean(qs('#bk-encrypt', panel)?.checked);
    const password = qs('#bk-pwd', panel)?.value || '';
    const note = (qs('#bk-note', panel)?.value || '').trim();

    if (kind === 'workspace' && !workspaceId) { notify.warn('请选择要备份的知识库'); return; }
    if (encrypt && password.trim().length < 6) { notify.warn('加密口令至少 6 位'); return; }
    if (kind === 'full') {
      const ok = await confirmDialog({
        title: '创建全量备份',
        message: '全量备份会打包数据库与全部原始文件，数据量大时可能耗时较长（数分钟到数十分钟），期间请勿关闭页面。确定开始吗？',
        confirmText: '开始备份'
      });
      if (!ok) return;
    }

    await withLoading(node, async () => {
      try {
        const res = await ctx.api.createBackup({ kind, workspaceId: kind === 'workspace' ? workspaceId : undefined, encrypt, password: encrypt ? password : undefined, note });
        notify.success(`备份完成：${res?.backup?.name || ''}（${res?.backup?.sizeText || formatBytes(res?.backup?.size || 0)}）`);
        qs('#bk-note', panel).value = '';
        qs('#bk-pwd', panel).value = '';
        qs('#bk-encrypt', panel).checked = false;
        qs('#bk-pwd-field', panel).hidden = true;
        await loadBackups(container, ctx);
      } catch (err) {
        notify.error(err?.message || '备份失败');
      }
    })();
  }));

  offs.push(on(panel, 'click', '[data-act="download-backup"]', (e, node) => {
    try {
      downloadUrl(ctx.api.backupDownloadUrl(node.getAttribute('data-id')), node.getAttribute('data-name') || '');
      notify.info('下载已开始');
    } catch (err) {
      notify.error(err?.message || '下载失败');
    }
  }));

  offs.push(on(panel, 'click', '[data-act="delete-backup"]', async (e, node) => {
    const id = node.getAttribute('data-id');
    const name = node.getAttribute('data-name') || id;
    const ok = await confirmDialog({
      title: '删除备份',
      message: `确定删除「${esc(name)}」吗？备份文件会从服务端一并删除，此操作不可撤销。`,
      confirmText: '删除',
      danger: true
    });
    if (!ok) return;
    try {
      await ctx.api.deleteBackup(id);
      notify.success('备份已删除');
      await loadBackups(container, ctx);
    } catch (err) {
      notify.error(err?.message || '删除失败');
    }
  }));

  offs.push(on(panel, 'click', '[data-act="restore-backup"]', async (e, node) => {
    const id = node.getAttribute('data-id');
    const row = qs(`[data-backup="${cssEscape(id)}"]`, panel);
    const encrypted = row?.getAttribute('data-encrypted') === '1';
    const isFull = row?.getAttribute('data-kind') === 'full';
    await runRestore(ctx, container, { id, encrypted, isFull });
  }));

  return offs;
}

function runRestore(ctx, container, { id, encrypted, isFull }) {
  return new Promise((resolve) => {
    const m = modal({
      title: '恢复备份',
      sub: isFull ? '全量恢复会替换当前数据库，需要重启服务后完整生效' : '恢复将以合并方式导入数据',
      size: 'md',
      body: `
        <div class="setting-desc mb-4" style="line-height:1.85">
          ${isFull
            ? '恢复前系统会自动留存一份当前数据库的安全性快照。全量恢复完成后<strong>需要重启服务进程</strong>，运行中的连接才会使用恢复后的数据。'
            : '恢复会把备份中的数据合并进现有实例：同名知识库会以「（导入）」形式新建，不会覆盖已有内容。'}
        </div>
        ${encrypted ? `<div class="field">
          <label>备份口令</label>
          <input class="input" type="password" id="rs-pwd" autocomplete="off" placeholder="请输入创建备份时设置的口令">
          <div class="field-hint">口令错误将无法解密，服务端不会保存该口令。</div>
        </div>` : '<div class="field-hint mb-4">该备份未加密，无需口令。</div>'}
        <div class="field">
          <label>恢复模式</label>
          <select class="select" id="rs-mode">
            <option value="merge">合并（推荐）</option>
            <option value="replace">替换同名数据</option>
          </select>
          <div class="field-hint">合并模式最安全；替换模式会覆盖同 ID 的记录，请谨慎使用。</div>
        </div>
        ${isFull ? `<div class="field" style="margin-bottom:0">
          <label>请输入 <code class="text-mono">RESTORE</code> 以确认全量恢复</label>
          <input class="input" id="rs-confirm" autocomplete="off" placeholder="RESTORE">
          <div class="field-hint">全量恢复影响整实例数据，请确认你已经在低峰期操作。</div>
        </div>` : ''}`,
      actions: [
        { label: '取消', onClick: () => resolve(false) },
        {
          label: '开始恢复',
          primary: true,
          keepOpen: true,
          onClick: async (close, btn) => {
            const pwd = encrypted ? (qs('#rs-pwd', m.body)?.value || '') : '';
            const mode = qs('#rs-mode', m.body)?.value || 'merge';
            if (encrypted && !pwd) { notify.warn('请输入备份口令'); return; }
            if (isFull && (qs('#rs-confirm', m.body)?.value || '').trim() !== 'RESTORE') {
              notify.warn('请输入 RESTORE 以确认全量恢复');
              return;
            }
            await withLoading(btn, async () => {
              try {
                await ctx.api.restoreBackup(id, { password: pwd || undefined, mode });
                close(true);
                notify.success('恢复完成' + (isFull ? '，请重启服务以完全生效' : ''));
                await loadBackups(container, ctx);
                resolve(true);
              } catch (err) {
                notify.error(err?.message || '恢复失败');
              }
            })();
          }
        }
      ],
      onClose: () => resolve(false)
    });
    setTimeout(() => qs('#rs-pwd', m.body)?.focus(), 60);
  });
}

/* ================================================================== 审计日志 */

function renderLogsShell(container) {
  const panel = qs('[data-panel="logs"]', container);
  panel.innerHTML = `
    <div class="card mb-4">
      <div class="card-pad">
        <div class="flex flex-wrap items-end gap-3">
          <div class="field" style="margin-bottom:0;min-width:200px">
            <label>操作类型</label>
            <select class="select" id="log-action"><option value="">全部操作</option></select>
          </div>
          <div class="field" style="margin-bottom:0;min-width:220px;flex:1">
            <label>关键词</label>
            <input class="input" id="log-q" placeholder="搜索对象名称、用户或详情">
          </div>
          <div class="field" style="margin-bottom:0;min-width:200px">
            <label>知识库</label>
            <select class="select" id="log-ws"><option value="">全部知识库</option></select>
          </div>
          <div class="flex gap-2">
            <button class="btn btn-default" data-act="log-search">${icon('search')}<span>查询</span></button>
            <button class="btn btn-ghost" data-act="log-reset">重置</button>
            <button class="btn btn-danger" data-act="log-clear" title="仅删除 action 以 search 开头的检索日志">${icon('trash')}<span>清理搜索日志</span></button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-pad" style="padding-bottom:6px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('clipboard')} 审计日志</div>
            <div class="section-sub" id="log-summary">加载中…</div>
          </div>
          <div class="section-actions">
            <button class="btn btn-sm btn-default" data-act="log-reload">${icon('refresh')}<span>刷新</span></button>
          </div>
        </div>
      </div>
      <div style="padding:0 8px">
        <div class="log-row text-xs text-muted" style="font-weight:600">
          <span>时间</span><span>操作</span><span>对象 / 详情</span><span class="text-right">用户</span>
        </div>
      </div>
      <div id="log-list">${skeleton(4)}</div>
      <div class="card-pad flex items-center justify-between" id="log-pager"></div>
    </div>`;

  applyIcons(panel);
}

async function loadLogs(container, ctx) {
  const panel = qs('[data-panel="logs"]', container);
  if (!panel) return;
  if (!qs('#log-list', panel)) renderLogsShell(container);

  const host = qs('#log-list', panel);
  const summary = qs('#log-summary', panel);
  try {
    const data = await ctx.api.logs({
      limit: logState.limit,
      offset: logState.offset,
      action: logState.action || undefined,
      q: logState.q || undefined,
      workspaceId: logState.workspaceId || undefined
    });
    const logs = Array.isArray(data?.logs) ? data.logs : [];
    logState.total = Number(data?.total || 0);

    if (summary) {
      const from = logState.total ? logState.offset + 1 : 0;
      const to = Math.min(logState.offset + logs.length, logState.total);
      summary.textContent = `共 ${formatNumber(logState.total)} 条 · 当前显示 ${from}-${to}`;
    }

    host.innerHTML = logs.length ? logs.map(logRowHtml).join('') : emptyState({
      iconName: 'clipboard', title: '没有匹配的日志', desc: '换一个操作类型或关键词试试'
    });
    applyIcons(host);
    paintLogFilters(panel, data?.actions || []);
    paintLogWorkspaces(panel, ctx);
    paintPager(panel);
  } catch (err) {
    if (summary) summary.textContent = '加载失败';
    host.innerHTML = emptyState({
      iconName: 'alert', title: '日志加载失败', desc: esc(err?.message || '未知错误'),
      actions: '<button class="btn btn-default" data-act="log-reload">重试</button>'
    });
    applyIcons(host);
  }
}

function logRowHtml(row) {
  const created = row.created_at ? formatDateTime(sqliteToIso(row.created_at)) : '—';
  const target = row.resource_name
    ? `${esc(row.resource_name)}${row.resource_type ? ` <span class="text-muted">(${esc(row.resource_type)})</span>` : ''}`
    : '<span class="text-muted">—</span>';
  const detail = row.detail ? ` <span class="text-muted">· ${esc(row.detail)}</span>` : '';
  const extra = [row.ip ? `IP ${esc(row.ip)}` : ''].filter(Boolean).join(' · ');
  return `<div class="log-row">
    <span class="log-time" title="${esc(row.created_at || '')}">${esc(created)}</span>
    <span class="log-action" title="${esc(row.action || '')}">${esc(row.action || '—')}</span>
    <span class="log-main" title="${esc(row.resource_name || '')}">${target}${detail}</span>
    <span class="log-user" title="${esc(row.user_name || '')}${extra ? ` · ${extra}` : ''}">${esc(row.user_name || '系统')}</span>
  </div>`;
}

/** SQLite 'YYYY-MM-DD HH:MM:SS' → ISO，便于本地时区正确解析 */
function sqliteToIso(value) {
  const s = String(value || '');
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(s)) return `${s.replace(' ', 'T')}Z`;
  return s;
}

function paintLogFilters(panel, actions) {
  const select = qs('#log-action', panel);
  if (!select) return;
  const list = Array.isArray(actions) ? actions : [];
  select.innerHTML = `<option value="">全部操作</option>${list.map((a) => {
    const name = a.action || a.name || '';
    const n = a.n ?? a.count ?? '';
    return `<option value="${esc(name)}" ${name === logState.action ? 'selected' : ''}>${esc(name)}${n !== '' ? `（${esc(String(n))}）` : ''}</option>`;
  }).join('')}`;
}

function paintLogWorkspaces(panel, ctx) {
  const select = qs('#log-ws', panel);
  if (!select) return;
  const workspaces = ctx.store?.workspaces || [];
  select.innerHTML = `<option value="">全部知识库</option>${workspaces.map((w) =>
    `<option value="${esc(w.id)}" ${w.id === logState.workspaceId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}`;
}

function paintPager(panel) {
  const host = qs('#log-pager', panel);
  if (!host) return;
  const from = logState.total ? logState.offset + 1 : 0;
  const to = Math.min(logState.offset + logState.limit, logState.total);
  host.innerHTML = `
    <span class="text-xs text-muted">第 ${from}-${to} 条 / 共 ${formatNumber(logState.total)} 条 · 每页 ${logState.limit}</span>
    <span class="flex gap-2">
      <button class="btn btn-sm btn-default" data-act="log-prev" ${logState.offset <= 0 ? 'disabled' : ''}>${icon('chevronLeft')}<span>上一页</span></button>
      <button class="btn btn-sm btn-default" data-act="log-next" ${logState.offset + logState.limit >= logState.total ? 'disabled' : ''}><span>下一页</span>${icon('chevronRight')}</button>
    </span>`;
  applyIcons(host);
}

function bindLogs(container, ctx) {
  const offs = [];
  const panel = qs('[data-panel="logs"]', container);

  const runSearch = async () => {
    logState.action = qs('#log-action', panel)?.value || '';
    logState.q = (qs('#log-q', panel)?.value || '').trim();
    logState.workspaceId = qs('#log-ws', panel)?.value || '';
    logState.offset = 0;
    await loadLogs(container, ctx);
  };

  const debouncedSearch = debounce(() => {
    logState.q = (qs('#log-q', panel)?.value || '').trim();
    logState.offset = 0;
    loadLogs(container, ctx);
  }, 380);

  const qInput = qs('#log-q', panel);
  if (qInput) {
    const onInput = () => debouncedSearch();
    const onKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } };
    qInput.addEventListener('input', onInput);
    qInput.addEventListener('keydown', onKey);
    offs.push(() => {
      qInput.removeEventListener('input', onInput);
      qInput.removeEventListener('keydown', onKey);
    });
  }
  /* debounce 内部定时器也要在卸载时清掉 */
  offs.push(() => { if (typeof debouncedSearch.cancel === 'function') debouncedSearch.cancel(); });

  offs.push(on(panel, 'click', '[data-act="log-search"]', runSearch));

  offs.push(on(panel, 'change', '#log-action', () => {
    logState.action = qs('#log-action', panel)?.value || '';
    logState.offset = 0;
    loadLogs(container, ctx);
  }));

  offs.push(on(panel, 'change', '#log-ws', () => {
    logState.workspaceId = qs('#log-ws', panel)?.value || '';
    logState.offset = 0;
    loadLogs(container, ctx);
  }));

  offs.push(on(panel, 'click', '[data-act="log-reset"]', async () => {
    logState = { ...logState, offset: 0, action: '', q: '', workspaceId: '' };
    if (qs('#log-q', panel)) qs('#log-q', panel).value = '';
    await loadLogs(container, ctx);
  }));

  offs.push(on(panel, 'click', '[data-act="log-reload"]', () => loadLogs(container, ctx)));

  offs.push(on(panel, 'click', '[data-act="log-prev"]', async () => {
    logState.offset = Math.max(0, logState.offset - logState.limit);
    await loadLogs(container, ctx);
  }));

  offs.push(on(panel, 'click', '[data-act="log-next"]', async () => {
    if (logState.offset + logState.limit >= logState.total) return;
    logState.offset += logState.limit;
    await loadLogs(container, ctx);
  }));

  offs.push(on(panel, 'click', '[data-act="log-clear"]', async () => {
    const ok = await confirmDialog({
      title: '清理搜索日志',
      message: '将删除所有 action 以 search 开头的检索日志，其他审计记录（登录、下载、备份等）不受影响。确定继续吗？',
      confirmText: '清理',
      danger: true
    });
    if (!ok) return;
    try {
      await ctx.api.clearLogs();
      notify.success('搜索日志已清理');
      logState.offset = 0;
      await loadLogs(container, ctx);
    } catch (err) {
      notify.error(err?.message || '清理失败');
    }
  }));

  /* 首次加载 */
  loadLogs(container, ctx);

  return offs;
}

/* ================================================================== 实例设置 */

function renderSettingsShell(container) {
  const panel = qs('[data-panel="settings"]', container);
  panel.innerHTML = `<div class="card"><div class="card-pad">${skeleton(5)}</div></div>`;
}

async function loadSettings(container, ctx) {
  const panel = qs('[data-panel="settings"]', container);
  if (!panel) return;
  renderSettingsShell(container);
  try {
    const data = await ctx.api.settings();
    panel.innerHTML = settingsHtml(data?.settings || {});
    applyIcons(panel);
  } catch (err) {
    panel.innerHTML = `<div class="card"><div class="card-pad">
      ${emptyState({
        iconName: 'alert', title: '实例设置加载失败', desc: esc(err?.message || '未知错误'),
        actions: '<button class="btn btn-default" data-act="retry-settings">重试</button>'
      })}
    </div></div>`;
    applyIcons(panel);
  }
}

function settingsHtml(s) {
  const ai = s.ai || {};
  const maxUploadMb = s.maxUploadBytes ? Math.round((Number(s.maxUploadBytes) / 1048576) * 100) / 100 : 100;
  return `
    <div class="grid mb-6" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px">
      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('settings')} 实例参数</div>
              <div class="section-sub">这些值决定新请求的处理方式</div>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">单文件上传上限</div>
              <div class="setting-desc">超过该大小的文件会被服务端直接拒绝。修改后对新的上传请求立即生效，已有文件不受影响。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" type="number" min="1" max="4096" step="1" id="st-upload" value="${esc(String(maxUploadMb))}" style="width:110px">
              <span class="text-sm text-muted">MB</span>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">开放注册</div>
              <div class="setting-desc">关闭后仅管理员可以创建新账号，注册接口会直接返回错误。</div>
            </div>
            <div class="setting-ctl">
              <button class="btn ${s.allowSignup ? 'btn-primary' : 'btn-default'}" data-act="toggle-signup" data-value="${s.allowSignup ? '1' : '0'}">${s.allowSignup ? '已开启' : '已关闭'}</button>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">会话有效期</div>
              <div class="setting-desc">单位：天。该值影响之后签发的会话 Cookie；已登录的会话仍按签发时的有效期到期。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" type="number" min="1" max="365" step="1" id="st-session" value="${esc(String(s.sessionDays ?? 30))}" style="width:110px">
              <span class="text-sm text-muted">天</span>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">RAG 检索片段数</div>
              <div class="setting-desc">每次提问注入上下文的片段数量。越大回答越全面，也越消耗 token 与时间。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" type="number" min="1" max="50" step="1" id="st-topk" value="${esc(String(s.ragTopK ?? 8))}" style="width:110px">
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">分块大小</div>
              <div class="setting-desc">文本切分的字符数。需要重新解析文档后才会应用到已有内容。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" type="number" min="100" max="4000" step="50" id="st-chunk" value="${esc(String(s.ragChunkSize ?? 900))}" style="width:110px">
              <span class="text-sm text-muted">字符</span>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">分块重叠</div>
              <div class="setting-desc">相邻片段的重叠字符数，用于避免语义被切断。同样需要重建索引后生效。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" type="number" min="0" max="1000" step="10" id="st-overlap" value="${esc(String(s.ragChunkOverlap ?? 180))}" style="width:110px">
              <span class="text-sm text-muted">字符</span>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('robot')} AI 全局默认</div>
              <div class="section-sub">未在个人中心单独配置的账号会使用这里的值</div>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">提供商</div>
              <div class="setting-desc">auto 会按「已配置 OpenAI → 已配置 Ollama → 内置本地引擎」自动回退。</div>
            </div>
            <div class="setting-ctl">
              <select class="select input-sm" id="st-ai-provider" style="width:150px">
                ${AI_PROVIDERS.map((p) => `<option value="${esc(p.value)}" ${p.value === (ai.provider || 'auto') ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
              </select>
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">Base URL</div>
              <div class="setting-desc">OpenAI 兼容接口地址，例如 https://api.deepseek.com/v1。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" id="st-ai-base" value="${esc(ai.baseUrl || '')}" placeholder="https://…" style="width:230px">
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">对话模型</div>
              <div class="setting-desc">用于问答与摘要的模型名。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" id="st-ai-chat" value="${esc(ai.chatModel || '')}" placeholder="qwen2.5:7b" style="width:230px">
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">Embedding 模型</div>
              <div class="setting-desc">用于向量检索；留空则使用内置的本地哈希向量（无需联网）。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" id="st-ai-embed" value="${esc(ai.embedModel || '')}" placeholder="text-embedding-3-small" style="width:230px">
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">Ollama 地址</div>
              <div class="setting-desc">本地 Ollama 服务地址，默认 http://127.0.0.1:11434。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" id="st-ai-ollama" value="${esc(ai.ollamaUrl || '')}" placeholder="http://127.0.0.1:11434" style="width:230px">
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">温度</div>
              <div class="setting-desc">0 更稳定保守，1 更发散。问答场景建议 0.2 - 0.4。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" type="number" min="0" max="2" step="0.1" id="st-ai-temp" value="${esc(String(ai.temperature ?? 0.2))}" style="width:110px">
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">最大输出 token</div>
              <div class="setting-desc">单次回答的长度上限，过大可能触发接口方限制。</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" type="number" min="128" max="32768" step="128" id="st-ai-maxtokens" value="${esc(String(ai.maxTokens ?? 1600))}" style="width:120px">
            </div>
          </div>

          <div class="setting-row">
            <div class="setting-main">
              <div class="setting-title">全局 API Key</div>
              <div class="setting-desc">${ai.hasKey ? '已配置全局密钥。留空表示不修改，填写会覆盖旧值。' : '尚未配置全局密钥。仅 OpenAI 兼容接口需要。'}</div>
            </div>
            <div class="setting-ctl">
              <input class="input input-sm" type="password" id="st-ai-key" autocomplete="off" placeholder="${ai.hasKey ? '已保存，留空不修改' : 'sk-…'}" style="width:230px">
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-pad flex items-center justify-between flex-wrap gap-3">
        <div class="text-sm text-muted">
          保存后：会话有效期、上传上限等设置<strong>对新的请求生效</strong>；分块大小与重叠需要重建索引后才应用到已有文档；AI 配置会立即用于之后的问答。
        </div>
        <div class="flex gap-2">
          <button class="btn btn-default" data-act="reload-settings">${icon('refresh')}<span>重新载入</span></button>
          <button class="btn btn-primary" data-act="save-settings">${icon('check')}<span>保存设置</span></button>
        </div>
      </div>
    </div>`;
}

function bindSettings(container, ctx) {
  const offs = [];
  const panel = qs('[data-panel="settings"]', container);

  offs.push(on(panel, 'click', '[data-act="retry-settings"]', () => loadSettings(container, ctx)));
  offs.push(on(panel, 'click', '[data-act="reload-settings"]', () => loadSettings(container, ctx)));

  offs.push(on(panel, 'click', '[data-act="toggle-signup"]', (e, node) => {
    const next = node.getAttribute('data-value') !== '1';
    node.setAttribute('data-value', next ? '1' : '0');
    node.textContent = next ? '已开启' : '已关闭';
    node.classList.toggle('btn-primary', next);
    node.classList.toggle('btn-default', !next);
  }));

  offs.push(on(panel, 'click', '[data-act="save-settings"]', async (e, node) => {
    const uploadMb = Number(qs('#st-upload', panel)?.value || 0);
    const sessionDays = Number(qs('#st-session', panel)?.value || 0);
    const ragTopK = Number(qs('#st-topk', panel)?.value || 0);
    const ragChunkSize = Number(qs('#st-chunk', panel)?.value || 0);
    const ragChunkOverlap = Number(qs('#st-overlap', panel)?.value || 0);
    const temperature = Number(qs('#st-ai-temp', panel)?.value || 0);
    const maxTokens = Number(qs('#st-ai-maxtokens', panel)?.value || 0);
    const allowSignup = qs('[data-act="toggle-signup"]', panel)?.getAttribute('data-value') === '1';

    if (!(uploadMb > 0)) { notify.warn('上传上限需大于 0 MB'); return; }
    if (!(sessionDays >= 1)) { notify.warn('会话有效期至少 1 天'); return; }
    if (!(ragTopK >= 1)) { notify.warn('检索片段数至少为 1'); return; }
    if (!(ragChunkSize >= 100)) { notify.warn('分块大小至少 100 字符'); return; }
    if (ragChunkOverlap >= ragChunkSize) { notify.warn('分块重叠需要小于分块大小'); return; }
    if (temperature < 0 || temperature > 2) { notify.warn('温度需在 0 - 2 之间'); return; }
    if (!(maxTokens >= 128)) { notify.warn('最大 token 至少 128'); return; }

    const aiPayload = {
      provider: qs('#st-ai-provider', panel)?.value || 'auto',
      baseUrl: (qs('#st-ai-base', panel)?.value || '').trim(),
      chatModel: (qs('#st-ai-chat', panel)?.value || '').trim(),
      embedModel: (qs('#st-ai-embed', panel)?.value || '').trim(),
      ollamaUrl: (qs('#st-ai-ollama', panel)?.value || '').trim(),
      temperature,
      maxTokens
    };
    const aiKey = qs('#st-ai-key', panel)?.value || '';
    if (aiKey) aiPayload.apiKey = aiKey;

    await withLoading(node, async () => {
      try {
        await ctx.api.saveSettings({
          maxUploadBytes: Math.round(uploadMb * 1048576),
          allowSignup,
          sessionDays,
          ragTopK,
          ragChunkSize,
          ragChunkOverlap,
          ai: aiPayload
        });
        const keyInput = qs('#st-ai-key', panel);
        if (keyInput) keyInput.value = '';
        notify.success('设置已保存');
        await loadSettings(container, ctx);
      } catch (err) {
        notify.error(err?.message || '保存失败');
      }
    })();
  }));

  return offs;
}

/* ------------------------------------------------------------------ 工具 */

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(String(value));
  return String(value).replace(/["\\]/g, '\\$&');
}

export default { meta, mount, unmount };
