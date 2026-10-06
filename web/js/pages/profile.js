/**
 * KBPRO — 个人中心
 * 资料 / 安全 / AI 引擎 / 存储
 */
import {
  qs, qsa, on, applyIcons, icon, notify, confirmDialog, emptyState, esc,
  badge, progressHtml, avatarHtml, skeleton, downloadUrl,
  withLoading, formatBytes, formatNumber, formatDateTime
} from '../ui.js';

export const meta = { title: '个人中心', icon: 'user' };

/* ------------------------------------------------------------------ 常量 */

const AI_PROVIDERS = [
  { value: 'auto', label: '自动（推荐）' },
  { value: 'ollama', label: 'Ollama 本地大模型' },
  { value: 'openai', label: 'OpenAI 兼容接口' },
  { value: 'local', label: '内置本地引擎' }
];

const PROVIDER_BADGE = {
  local: { text: '内置本地引擎', kind: 'info' },
  ollama: { text: 'Ollama 本地大模型', kind: '' },
  openai: { text: 'OpenAI 兼容接口', kind: '' }
};

const AVATAR_MAX_BYTES = 200 * 1024;

let cleanup = [];

/* ------------------------------------------------------------------ 挂载 */

export async function mount(container, ctx) {
  const { store } = ctx;
  const user = store?.user || {};

  container.innerHTML = `<div class="page">
    <div class="page-head">
      <div>
        <h1 class="page-title">个人中心</h1>
        <p class="page-desc">管理个人资料、登录安全、AI 引擎与存储用量</p>
      </div>
      <div class="page-actions">
        <button class="btn btn-default" data-act="refresh">${icon('refresh')}<span>刷新</span></button>
      </div>
    </div>

    <div class="tabs" role="tablist">
      <button class="tab is-active" data-tab="info" role="tab">资料</button>
      <button class="tab" data-tab="security" role="tab">安全</button>
      <button class="tab" data-tab="ai" role="tab">AI 引擎</button>
      <button class="tab" data-tab="storage" role="tab">存储</button>
    </div>

    <section class="tab-panel" data-panel="info"></section>
    <section class="tab-panel" data-panel="security" hidden></section>
    <section class="tab-panel" data-panel="ai" hidden></section>
    <section class="tab-panel" data-panel="storage" hidden></section>
  </div>`;

  renderInfo(container, ctx);
  renderSecurity(container, ctx);
  renderAi(container, ctx, null);
  renderStorage(container, ctx, null);

  const offs = [];

  /* 标签切换 */
  offs.push(on(container, 'click', '[data-tab]', (e, node) => {
    const tab = node.getAttribute('data-tab');
    qsa('[data-tab]', container).forEach((n) => n.classList.toggle('is-active', n === node));
    qsa('[data-panel]', container).forEach((p) => { p.hidden = p.getAttribute('data-panel') !== tab; });
  }));

  offs.push(...bindInfo(container, ctx));
  offs.push(...bindSecurity(container, ctx));
  offs.push(...bindAi(container, ctx));
  offs.push(...bindStorage(container, ctx));

  /* 刷新：重新拉取 AI 状态与存储用量 */
  offs.push(on(container, 'click', '[data-act="refresh"]', async () => {
    await Promise.all([
      loadAi(container, ctx),
      loadStorage(container, ctx)
    ]);
  }));

  applyIcons(container);

  /* 首屏异步数据 */
  loadAi(container, ctx);
  loadStorage(container, ctx);

  cleanup = offs;
}

export function unmount() {
  for (const off of cleanup) {
    try { typeof off === 'function' && off(); } catch { /* 忽略 */ }
  }
  cleanup = [];
}

/* ================================================================== 资料 */

function renderInfo(container, ctx) {
  const user = ctx.store?.user || {};
  qs('[data-panel="info"]', container).innerHTML = `
    <div class="grid mb-6" style="grid-template-columns:minmax(0,1.55fr) minmax(0,1fr);gap:16px">
      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('user')} 基本资料</div>
              <div class="section-sub">这些信息会展示在协作成员、评论与审计日志中</div>
            </div>
          </div>

          <div class="flex items-center gap-4 mb-6">
            <button class="avatar xl" data-act="avatar" title="点击更换头像" style="padding:0;overflow:hidden;cursor:pointer;border:1px solid var(--c-border-2);background:var(--c-ink-50)">${avatarBox(user)}</button>
            <input type="file" accept="image/*" data-avatar-input hidden>
            <div class="flex-1" style="min-width:0">
              <div class="text-sm font-medium">${esc(user.name || '未命名用户')}</div>
              <div class="text-xs text-muted mt-1">${esc(user.email || '')}</div>
              <div class="flex gap-2 mt-3">
                <button class="btn btn-sm btn-default" data-act="avatar">${icon('upload')}<span>上传头像</span></button>
                <button class="btn btn-sm btn-ghost" data-act="avatar-clear">移除头像</button>
              </div>
              <div class="field-hint">支持 JPG / PNG / WebP，建议小于 ${formatBytes(AVATAR_MAX_BYTES)}，过大会被自动压缩。</div>
            </div>
          </div>

          <div class="field">
            <label>昵称 <span class="text-danger">*</span></label>
            <input class="input" id="pf-name" maxlength="60" value="${esc(user.name || '')}" placeholder="如何称呼你">
            <div class="field-hint">必填，最多 60 个字符。</div>
          </div>

          <div class="field">
            <label>职位</label>
            <input class="input" id="pf-title" maxlength="80" value="${esc(user.title || '')}" placeholder="例如：产品经理 / 前端工程师">
          </div>

          <div class="field" style="margin-bottom:0">
            <label>个人简介</label>
            <textarea class="textarea" id="pf-bio" maxlength="500" placeholder="简单介绍你的关注领域，最多 500 字">${esc(user.bio || '')}</textarea>
            <div class="field-hint"><span data-bio-count>${(user.bio || '').length}</span> / 500</div>
          </div>

          <hr class="hr">

          <div class="flex items-center gap-2">
            <button class="btn btn-primary" data-act="save-info">${icon('check')}<span>保存资料</span></button>
            <span class="text-xs text-muted">修改后立即生效。</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div class="section-title">${icon('info')} 账号信息</div>
          </div>
          <dl class="kv">
            <dt>邮箱</dt><dd>${esc(user.email || '—')}</dd>
            <dt>角色</dt><dd>${user.role === 'admin' ? badge('管理员', 'success') : badge('普通成员')}</dd>
            <dt>状态</dt><dd>${user.status === 'active' ? '正常' : esc(user.status || '—')}</dd>
            <dt>注册时间</dt><dd>${esc(user.createdAt ? formatDateTime(user.createdAt) : '—')}</dd>
            <dt>上次登录</dt><dd>${esc(user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '—')}</dd>
          </dl>
        </div>
      </div>
    </div>`;
}

/** 与侧边栏一致的头像内容（带配色兜底） */
function avatarBox(user) {
  const html = avatarHtml(user);
  const m = html.match(/<span class="avatar[^"]*"[^>]*>([\s\S]*)<\/span>$/);
  const inner = m ? m[1] : esc((user?.name || '?').slice(0, 2));
  return `<span style="display:grid;place-items:center;width:100%;height:100%">${inner}</span>`;
}

function bindInfo(container, ctx) {
  const offs = [];
  const panel = qs('[data-panel="info"]', container);

  const bio = qs('#pf-bio', panel);
  if (bio) {
    const counter = qs('[data-bio-count]', panel);
    const onInput = () => { if (counter) counter.textContent = String(bio.value.length); };
    bio.addEventListener('input', onInput);
    offs.push(() => bio.removeEventListener('input', onInput));
  }

  offs.push(on(panel, 'click', '[data-act="avatar"]', () => {
    const input = qs('[data-avatar-input]', panel);
    if (!input) return;
    input.value = '';
    input.click();
  }));

  const avatarInput = qs('[data-avatar-input]', panel);
  if (avatarInput) {
    const onChange = async () => {
      const file = avatarInput.files && avatarInput.files[0];
      if (!file) return;
      if (!/^image\//i.test(file.type || '')) { notify.warn('请选择图片文件'); return; }
      if (file.size > AVATAR_MAX_BYTES) {
        notify.warn(`图片 ${formatBytes(file.size)} 超过 ${formatBytes(AVATAR_MAX_BYTES)}，建议换一张更小的图片（仍会尝试压缩读取）`);
      }
      try {
        const dataUrl = await readAsDataURL(file);
        const box = qs('.avatar.xl', panel);
        const name = ctx.store?.user?.name || ctx.store?.user?.email || '?';
        if (box) box.innerHTML = `<img src="${esc(dataUrl)}" alt="${esc(name)}" style="width:100%;height:100%;object-fit:cover">`;
        panel.dataset.avatarDraft = dataUrl;
        notify.info('头像已选择，点击「保存资料」后生效');
      } catch (err) {
        notify.error(err?.message || '读取图片失败');
      }
    };
    avatarInput.addEventListener('change', onChange);
    offs.push(() => avatarInput.removeEventListener('change', onChange));
  }

  offs.push(on(panel, 'click', '[data-act="avatar-clear"]', () => {
    const box = qs('.avatar.xl', panel);
    if (box) box.innerHTML = avatarBox({ ...(ctx.store?.user || {}), avatar: '' });
    panel.dataset.avatarDraft = '';
    notify.info('头像已移除，点击「保存资料」后生效');
  }));

  offs.push(on(panel, 'click', '[data-act="save-info"]', async (e, node) => {
    const nameInput = qs('#pf-name', panel);
    const titleInput = qs('#pf-title', panel);
    const bioInput = qs('#pf-bio', panel);
    const name = (nameInput?.value || '').trim();
    if (!name) { notify.warn('昵称不能为空'); nameInput?.focus(); return; }
    if (name.length > 60) { notify.warn('昵称最多 60 个字符'); return; }
    if ((bioInput?.value || '').length > 500) { notify.warn('个人简介最多 500 字'); return; }

    await withLoading(node, async () => {
      try {
        const payload = {
          name,
          title: (titleInput?.value || '').trim(),
          bio: bioInput?.value || ''
        };
        if (panel.dataset.avatarDraft !== undefined) payload.avatar = panel.dataset.avatarDraft;
        const res = await ctx.api.updateMe(payload);
        if (res?.user && ctx.store) ctx.store.user = res.user;
        delete panel.dataset.avatarDraft;
        notify.success('资料已保存');
        try { await ctx.reload(); } catch { /* 侧边栏刷新失败不影响保存结果 */ }
      } catch (err) {
        notify.error(err?.message || '保存失败');
      }
    })();
  }));

  return offs;
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

/* ================================================================== 安全 */

function renderSecurity(container, ctx) {
  const user = ctx.store?.user || {};
  qs('[data-panel="security"]', container).innerHTML = `
    <div class="grid mb-6" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px">
      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('lock')} 修改密码</div>
              <div class="section-sub">修改后当前会话会自动续期，其他设备需重新登录</div>
            </div>
          </div>

          <div class="field">
            <label>原密码</label>
            <input class="input" type="password" id="pw-old" autocomplete="current-password" placeholder="请输入当前密码">
          </div>

          <div class="field">
            <label>新密码</label>
            <input class="input" type="password" id="pw-new" autocomplete="new-password" placeholder="至少 8 位，建议混合大小写与数字">
            <div class="flex items-center gap-3 mt-2">
              <div class="flex-1" id="pw-meter">${progressHtml(0)}</div>
              <span class="text-xs text-muted nowrap" data-pw-strength>强度：—</span>
            </div>
            <div class="field-hint">至少 8 位；包含大小写字母、数字、符号可显著提升强度。</div>
          </div>

          <div class="field">
            <label>确认新密码</label>
            <input class="input" type="password" id="pw-confirm" autocomplete="new-password" placeholder="再次输入新密码">
            <div class="field-hint" data-pw-hint></div>
          </div>

          <button class="btn btn-primary" data-act="change-pw">${icon('key')}<span>更新密码</span></button>
        </div>
      </div>

      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('shield')} 当前会话</div>
              <div class="section-sub">登录凭据保存在服务端的 HttpOnly Cookie 中</div>
            </div>
          </div>
          <dl class="kv">
            <dt>账号</dt><dd>${esc(user.email || '—')}</dd>
            <dt>上次登录</dt><dd>${esc(user.lastLoginAt ? formatDateTime(user.lastLoginAt) : '未记录')}</dd>
            <dt>本次会话</dt><dd>Cookie 会话（服务端可随时吊销）</dd>
            <dt>浏览器</dt><dd class="text-xs text-mono" style="word-break:break-word">${esc(shortenUa(navigator.userAgent))}</dd>
            <dt>客户端 IP</dt><dd class="text-muted">由服务端记录，界面暂不提供</dd>
          </dl>
          <hr class="hr">
          <button class="btn btn-danger" data-act="logout">${icon('logout')}<span>退出登录</span></button>
          <div class="field-hint">退出后需要重新输入邮箱与密码。</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-pad">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('shield')} 数据安全说明</div>
            <div class="section-sub">下面是这套系统实际采用的做法，不含超出实现的承诺</div>
          </div>
        </div>
        <div class="grid grid-2">
          ${securityItem('key', '口令哈希（scrypt）', '登录口令使用 Node 内置 crypto 的 scrypt 加盐派生后存储，数据库中不保存明文口令。')}
          ${securityItem('lock', '私密文件加密（AES-256-GCM）', '上传时可勾选「加密存储」，文件以 AES-256-GCM 加密后落盘；未勾选的文件按普通文件存储。属于服务端加密，不是端到端零知识加密。')}
          ${securityItem('clipboard', '访问审计日志', '登录、下载、导出、恢复备份、修改设置等敏感操作会写入审计日志，管理员可在「系统管理 → 审计日志」中检索。')}
          ${securityItem('archive', '备份与导出', '支持全量 / 仅元数据 / 指定知识库三种备份，可选口令加密为 .kbpro 包；也可随时把知识库导出为 ZIP。')}
        </div>
      </div>
    </div>`;
}

function securityItem(iconName, title, desc) {
  return `<div class="flex items-start gap-3" style="padding:10px 0">
    <span class="stat-ico">${icon(iconName)}</span>
    <div class="flex-1" style="min-width:0">
      <div class="setting-title">${esc(title)}</div>
      <div class="setting-desc">${esc(desc)}</div>
    </div>
  </div>`;
}

function shortenUa(ua) {
  const s = String(ua || '未知');
  return s.length > 120 ? `${s.slice(0, 120)}…` : s;
}

function passwordStrength(pw) {
  const s = String(pw || '');
  if (!s) return { level: 0, label: '—', status: '' };
  let score = 0;
  if (s.length >= 8) score++;
  if (s.length >= 12) score++;
  if (/[a-z]/.test(s) && /[A-Z]/.test(s)) score++;
  if (/\d/.test(s)) score++;
  if (/[^A-Za-z0-9]/.test(s)) score++;
  if (s.length < 8) return { level: 1, label: '弱', status: 'danger', percent: 25 };
  if (score <= 2) return { level: 1, label: '弱', status: 'danger', percent: 33 };
  if (score <= 4) return { level: 2, label: '一般', status: '', percent: 66 };
  return { level: 3, label: '强', status: 'success', percent: 100 };
}

function bindSecurity(container, ctx) {
  const offs = [];
  const panel = qs('[data-panel="security"]', container);

  const newInput = qs('#pw-new', panel);
  const confirmInput = qs('#pw-confirm', panel);
  const meter = qs('#pw-meter .progress', panel);
  const strengthText = qs('[data-pw-strength]', panel);
  const hint = qs('[data-pw-hint]', panel);

  const refresh = () => {
    const st = passwordStrength(newInput?.value || '');
    if (meter) {
      meter.classList.toggle('is-danger', st.status === 'danger');
      meter.classList.toggle('is-success', st.status === 'success');
      const bar = qs('span', meter);
      if (bar) bar.style.width = `${st.percent || 0}%`;
    }
    if (strengthText) strengthText.textContent = `强度：${st.label}`;
    if (hint) {
      const cur = confirmInput?.value || '';
      hint.textContent = cur && cur !== (newInput?.value || '') ? '两次输入的密码不一致' : '';
      hint.className = cur && cur !== (newInput?.value || '') ? 'field-hint text-danger' : 'field-hint';
    }
  };
  newInput?.addEventListener('input', refresh);
  confirmInput?.addEventListener('input', refresh);
  offs.push(() => {
    newInput?.removeEventListener('input', refresh);
    confirmInput?.removeEventListener('input', refresh);
  });

  offs.push(on(panel, 'click', '[data-act="change-pw"]', async (e, node) => {
    const oldPw = qs('#pw-old', panel).value;
    const newPw = qs('#pw-new', panel).value;
    const confirmPw = qs('#pw-confirm', panel).value;
    if (!oldPw) { notify.warn('请输入原密码'); return; }
    if (!newPw || newPw.length < 8) { notify.warn('新密码至少 8 位'); return; }
    if (newPw !== confirmPw) { notify.warn('两次输入的新密码不一致'); return; }
    if (newPw === oldPw) { notify.warn('新密码不能与原密码相同'); return; }

    await withLoading(node, async () => {
      try {
        await ctx.api.changePassword(oldPw, newPw);
        qs('#pw-old', panel).value = '';
        qs('#pw-new', panel).value = '';
        qs('#pw-confirm', panel).value = '';
        refresh();
        notify.success('密码已更新');
      } catch (err) {
        notify.error(err?.message || '修改密码失败');
      }
    })();
  }));

  offs.push(on(panel, 'click', '[data-act="logout"]', async () => {
    const ok = await confirmDialog({
      title: '退出登录',
      message: '确定要退出当前账号吗？退出后需要重新登录。',
      confirmText: '退出登录',
      danger: true
    });
    if (!ok) return;
    try {
      await ctx.api.logout();
    } catch (err) {
      notify.error(err?.message || '退出失败');
      return;
    }
    document.dispatchEvent(new CustomEvent('kbpro:logout'));
    location.reload();
  }));

  return offs;
}

/* ================================================================== AI 引擎 */

function renderAi(container, ctx, data) {
  const panel = qs('[data-panel="ai"]', container);
  panel.innerHTML = `
    <div id="pf-ai-status" class="mb-6">${data ? '' : `<div class="card"><div class="card-pad">${skeleton(2)}</div></div>`}</div>
    <div class="grid mb-6" style="grid-template-columns:minmax(0,1.35fr) minmax(0,1fr);gap:16px">
      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div>
              <div class="section-title">${icon('settings')} AI 提供商配置</div>
              <div class="section-sub">个人配置优先于实例全局默认；留空则跟随全局设置</div>
            </div>
          </div>

          <div class="field">
            <label>提供商</label>
            <select class="select" id="ai-provider">
              ${AI_PROVIDERS.map((p) => `<option value="${esc(p.value)}">${esc(p.label)}</option>`).join('')}
            </select>
          </div>

          <div class="field">
            <label>模型名</label>
            <input class="input" id="ai-model" placeholder="例如 qwen2.5:7b / deepseek-chat / gpt-4o-mini">
            <div class="field-hint">Ollama 需要填已拉取的模型名；OpenAI 兼容接口填对方提供的模型 ID。</div>
            <div id="ai-models" class="mt-2"></div>
          </div>

          <div class="field">
            <label>Base URL</label>
            <input class="input" id="ai-base" placeholder="https://api.deepseek.com/v1">
            <div class="field-hint">仅 OpenAI 兼容接口需要；必须以 http(s):// 开头。</div>
          </div>

          <div class="field">
            <label>API Key</label>
            <div class="input-group">
              <input class="input" type="password" id="ai-key" placeholder="sk-…" autocomplete="off" style="flex:1">
              <button class="btn btn-default nowrap" data-act="clear-key" hidden>清除密钥</button>
            </div>
            <div class="field-hint" id="ai-key-hint">密钥在服务端加密存储，接口只返回「是否已保存」。</div>
          </div>

          <div class="flex items-center gap-2">
            <button class="btn btn-primary" data-act="save-ai">${icon('check')}<span>保存配置</span></button>
            <button class="btn btn-default" data-act="test-ai">${icon('activity')}<span>测试连接</span></button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-pad">
          <div class="section-head">
            <div class="section-title">${icon('bulb')} 三种引擎怎么选</div>
          </div>
          <div class="setting-desc mb-4" style="line-height:1.8">
            <strong>Ollama</strong>：本地大模型，默认地址 <code class="text-mono">http://127.0.0.1:11434</code>，需自行安装并启动 Ollama、提前 <code class="text-mono">ollama pull</code> 模型；数据不出本机。<br><br>
            <strong>OpenAI 兼容</strong>：任意 OpenAI 协议的接口（DeepSeek / 通义 / vLLM / one-api 等），填 Base URL 与 Key 即可，回答质量最好但需要外部网络与额度。<br><br>
            <strong>内置本地引擎</strong>：抽取式摘要与问答，完全离线、无需密钥，永不报「不可用」；能力限于从已有文本中抽取与拼接，不做自由生成。
          </div>
          <div class="field-hint">选「自动」时，系统按「已配置 OpenAI → 已配置 Ollama → 内置本地引擎」的顺序回退。</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-pad">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('layers')} 索引维护</div>
            <div class="section-sub">索引是检索与问答的数据来源，按知识库分别重建</div>
          </div>
        </div>
        <div class="field-hint mb-4" style="line-height:1.8">
          换了 Embedding 模型、上传后索引失败、或检索结果明显不对时，需要重建索引。<br>
          <strong>重建向量索引</strong>会调用当前 AI 引擎重新计算所有知识块的向量，耗时较长且可能消耗接口额度；<br>
          <strong>重建全文索引</strong>只重新解析文本与分块，走本地流程，速度更快也更省事。
        </div>
        <div id="pf-index-list"></div>
      </div>
    </div>`;

  applyIcons(panel);
  paintAiStatus(panel, data);
  paintIndexList(container, ctx);
  paintModels(panel);
}

async function loadAi(container, ctx) {
  const panel = qs('[data-panel="ai"]', container);
  if (!panel) return;
  try {
    const data = await ctx.api.aiConfig();
    paintAiStatus(panel, data);
    paintIndexList(container, ctx);
    paintModels(panel);
  } catch (err) {
    const host = qs('#pf-ai-status', panel);
    if (host) {
      host.innerHTML = `<div class="card"><div class="card-pad">
        ${emptyState({ iconName: 'alert', title: 'AI 配置加载失败', desc: esc(err?.message || '未知错误') })}
      </div></div>`;
    }
  }
}

function paintAiStatus(panel, data, { fillForm = true } = {}) {
  const host = qs('#pf-ai-status', panel);
  if (!host || !data) return;

  const status = data.status || {};
  panel._aiModels = Array.isArray(status.models) ? status.models.slice(0, 24) : [];
  const config = data.config || {};
  const global = data.global || {};
  if (fillForm) panel._aiData = data;
  const provider = status.provider || config.provider || 'local';
  const effective = config.effective || {};

  const badgeInfo = PROVIDER_BADGE[provider] || { text: provider, kind: '' };
  const stateBadge = provider === 'local'
    ? badge('可用 · 内置本地引擎', 'info')
    : (status.available ? badge('可用', 'success') : badge('不可用', 'danger'));

  if (fillForm) {
    /* 回填表单当前值 */
    const providerSelect = qs('#ai-provider', panel);
    if (providerSelect && config.provider) providerSelect.value = config.provider;
    const modelInput = qs('#ai-model', panel);
    if (modelInput) modelInput.value = config.model || effective.model || '';
    const baseInput = qs('#ai-base', panel);
    if (baseInput) baseInput.value = config.baseUrl || '';

    /* 已保存密钥：显示状态与清除入口 */
    const keyInput = qs('#ai-key', panel);
    const clearBtn = qs('[data-act="clear-key"]', panel);
    const keyHint = qs('#ai-key-hint', panel);
    if (config.hasKey) {
      if (clearBtn) clearBtn.hidden = false;
      if (keyInput) keyInput.placeholder = '已保存密钥（••••••••），留空则保持不变';
      if (keyHint) keyHint.textContent = '已保存个人密钥。留空表示不修改；填写新值会覆盖旧密钥。';
    } else {
      if (clearBtn) clearBtn.hidden = true;
      if (keyInput) keyInput.placeholder = 'sk-…';
      if (keyHint) keyHint.textContent = '密钥在服务端加密存储，接口只返回「是否已保存」。';
    }
  }

  host.innerHTML = `
    <div class="card">
      <div class="card-pad">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('robot')} 当前生效的 AI 引擎</div>
            <div class="section-sub">${esc(status.note || '')}</div>
          </div>
          <div class="flex items-center gap-2">${badgeInfo.kind ? badge(badgeInfo.text, badgeInfo.kind) : badge(badgeInfo.text)}${stateBadge}</div>
        </div>
        <div class="stat-inline mb-4">
          <div class="stat-inline-item"><span class="stat-inline-value">${esc(effective.provider || provider)}</span><span class="stat-inline-label">生效提供商</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value">${esc(effective.model || status.model || '—')}</span><span class="stat-inline-label">对话模型</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value" style="word-break:break-all">${esc(effective.baseUrl || status.baseUrl || '—')}</span><span class="stat-inline-label">接口地址</span></div>
          <div class="stat-inline-item"><span class="stat-inline-value">${config.hasKey ? '已保存' : '未保存'}</span><span class="stat-inline-label">个人密钥</span></div>
        </div>
        <div class="field-hint">
          个人配置：${esc(config.provider || '未设置')} · ${esc(config.model || '未指定模型')}${config.baseUrl ? ` · ${esc(config.baseUrl)}` : ''}<br>
          实例默认：${esc(global.provider || '—')} · ${esc(global.chatModel || '—')}${global.baseUrl ? ` · ${esc(global.baseUrl)}` : ''} · Ollama ${esc(global.ollamaUrl || '—')} · 全局密钥${global.hasKey ? '已配置' : '未配置'}
        </div>
      </div>
    </div>`;
}

function paintModels(panel) {
  const host = qs('#ai-models', panel);
  if (!host) return;
  const models = Array.isArray(panel._aiModels) ? panel._aiModels : [];
  if (!models.length) {
    host.innerHTML = '<span class="text-xs text-muted">未探测到模型列表（Ollama 需先启动服务并拉取模型）</span>';
    return;
  }
  host.innerHTML = `<div class="flex flex-wrap gap-1 items-center">
    <span class="text-xs text-muted nowrap">发现的模型：</span>
    ${models.map((m) => `<span class="chip chip-btn" data-model="${esc(m)}">${esc(m)}</span>`).join('')}
  </div>`;
}

function paintIndexList(container, ctx) {
  const panel = qs('[data-panel="ai"]', container);
  const host = qs('#pf-index-list', panel);
  if (!host) return;

  const workspaces = ctx.store?.workspaces || [];
  if (!workspaces.length) {
    host.innerHTML = emptyState({ iconName: 'layers', title: '还没有知识库', desc: '创建知识库并上传文档后即可重建索引' });
    return;
  }

  host.innerHTML = workspaces.map((w) => `
    <div class="setting-row">
      <div class="setting-main">
        <div class="setting-title">${esc(w.name)}</div>
        <div class="setting-desc">${w.kind === 'team' ? '团队知识库' : '个人知识库'} · ${esc(w.id)}</div>
      </div>
      <div class="setting-ctl">
        <button class="btn btn-sm btn-default" data-act="reindex" data-embed="0" data-ws="${esc(w.id)}">${icon('refresh')}<span>重建全文索引</span></button>
        <button class="btn btn-sm btn-default" data-act="reindex" data-embed="1" data-ws="${esc(w.id)}">${icon('zap')}<span>重建向量索引</span></button>
      </div>
    </div>`).join('');
  applyIcons(host);
}

function bindAi(container, ctx) {
  const offs = [];
  const panel = qs('[data-panel="ai"]', container);

  function readAiForm() {
    return {
      provider: qs('#ai-provider', panel)?.value || 'auto',
      model: (qs('#ai-model', panel)?.value || '').trim(),
      baseUrl: (qs('#ai-base', panel)?.value || '').trim(),
      apiKey: qs('#ai-key', panel)?.value || ''
    };
  }
  /** 返回错误文案；合法时返回空串。避免「填了 key 却静默不生效」 */
  function validateAiForm(v) {
    if (v.baseUrl && !/^https?:\/\//i.test(v.baseUrl)) {
      return 'Base URL 必须以 http:// 或 https:// 开头';
    }
    if (v.provider === 'openai') {
      if (!v.baseUrl) return 'OpenAI 兼容接口必须填写 Base URL（例如 https://api.deepseek.com/v1）';
      if (!v.model) return 'OpenAI 兼容接口必须填写模型名（DeepSeek 请填 deepseek-chat）';
    }
    if (v.provider === 'ollama' && !v.model) {
      return 'Ollama 需要填写已拉取的模型名（例如 qwen2.5:7b）';
    }
    if (v.provider === 'auto' && v.apiKey && !v.baseUrl) {
      return '选择「自动」时若填写了 API Key，必须同时填写 Base URL，否则不会启用大模型';
    }
    return '';
  }

  /* 保存个人 AI 配置 */
  offs.push(on(panel, 'click', '[data-act="save-ai"]', async (e, node) => {
    const { provider, model, baseUrl, apiKey } = readAiForm();
    const problem = validateAiForm({ provider, model, baseUrl, apiKey });
    if (problem) { notify.warn(problem); return; }

    await withLoading(node, async () => {
      try {
        const res = await ctx.api.saveAiConfig({ provider, model, baseUrl, apiKey });
        paintAiStatus(panel, { status: res?.status || {}, config: { provider, model, baseUrl, hasKey: Boolean(apiKey) }, global: {} });
        await loadAi(container, ctx);
        notify.success('AI 配置已保存');
      } catch (err) {
        notify.error(err?.message || '保存失败');
      }
    })();
  }));

  /* 清除已保存密钥 */
  offs.push(on(panel, 'click', '[data-act="clear-key"]', async () => {
    const ok = await confirmDialog({
      title: '清除密钥',
      message: '清除后，若提供商需要密钥，AI 能力会回退到内置本地引擎。确定继续吗？',
      confirmText: '清除',
      danger: true
    });
    if (!ok) return;
    try {
      await ctx.api.saveAiConfig({ clearKey: true });
      const keyInput = qs('#ai-key', panel);
      if (keyInput) keyInput.value = '';
      await loadAi(container, ctx);
      notify.success('密钥已清除');
    } catch (err) {
      notify.error(err?.message || '清除失败');
    }
  }));

  /* 测试连接：使用表单当前值（无需先保存），且不覆盖已填内容 */
  offs.push(on(panel, 'click', '[data-act="test-ai"]', async (e, node) => {
    const { provider, model, baseUrl, apiKey } = readAiForm();
    const problem = validateAiForm({ provider, model, baseUrl, apiKey });
    if (problem) { notify.warn(problem); return; }
    await withLoading(node, async () => {
      try {
        const res = await ctx.api.testAiConfig({ provider, model, baseUrl, apiKey });
        const status = res?.status || {};
        if (status.provider === 'local') {
          // 请求的提供商不可用时会回退到本地引擎，按实际情况提示而非误报成功
          notify.warn(status.note || '连接失败，已回退到内置本地引擎');
        } else if (status.available) {
          const count = Array.isArray(status.models) ? status.models.length : 0;
          notify.success(`连接正常：${status.provider}${count ? ` · 发现 ${count} 个模型` : ''}`);
        } else {
          notify.warn(status.note || '当前引擎不可用');
        }
        // 仅刷新状态卡片（不回填表单），并让「生效」信息反映本次探测结果
        const base = panel._aiData || { config: {}, global: {} };
        paintAiStatus(panel, {
          ...base,
          status,
          config: {
            ...(base.config || {}),
            effective: { provider: status.provider, model: status.model, baseUrl: status.baseUrl || base.config?.baseUrl }
          }
        }, { fillForm: false });
      } catch (err) {
        notify.error(err?.message || '测试失败');
      }
    })();
  }));

  /* 模型建议 */
  offs.push(on(panel, 'click', '[data-model]', (e, node) => {
    const input = qs('#ai-model', panel);
    if (input) input.value = node.getAttribute('data-model');
    qsa('[data-model]', panel).forEach((n) => n.classList.toggle('is-active', n === node));
  }));

  /* 重建索引 */
  offs.push(on(panel, 'click', '[data-act="reindex"]', async (e, node) => {
    const workspaceId = node.getAttribute('data-ws');
    const embed = node.getAttribute('data-embed') === '1';
    const ws = (ctx.store?.workspaces || []).find((w) => w.id === workspaceId);
    const ok = await confirmDialog({
      title: embed ? '重建向量索引' : '重建全文索引',
      message: embed
        ? `将调用当前 AI 引擎为「${ws?.name || workspaceId}」的所有知识块重算向量，可能耗时较久并消耗接口额度。确定继续吗？`
        : `将重新解析并分块「${ws?.name || workspaceId}」的全部文档（本地流程，不调用大模型）。确定继续吗？`,
      confirmText: '开始重建'
    });
    if (!ok) return;
    await withLoading(node, async () => {
      try {
        const res = await ctx.api.reindex({ workspaceId, embed });
        if (embed) notify.success(`向量索引重建完成：更新 ${formatNumber(res?.updated || 0)} 个知识块`);
        else notify.success(`已加入重建队列：${formatNumber(res?.queued || 0)} 个文档`);
      } catch (err) {
        notify.error(err?.message || '重建失败');
      }
    })();
  }));

  return offs;
}

/* ================================================================== 存储 */

function renderStorage(container, ctx, data) {
  const panel = qs('[data-panel="storage"]', container);
  panel.innerHTML = data
    ? storageHtml(data, ctx)
    : `<div class="card"><div class="card-pad">${skeleton(3)}</div></div>`;
  if (data) applyIcons(panel);
}

async function loadStorage(container, ctx) {
  const panel = qs('[data-panel="storage"]', container);
  if (!panel) return;
  try {
    const data = await ctx.api.storage();
    panel.innerHTML = storageHtml(data, ctx);
    applyIcons(panel);
  } catch (err) {
    panel.innerHTML = `<div class="card"><div class="card-pad">
      ${emptyState({
        iconName: 'alert', title: '存储信息加载失败', desc: esc(err?.message || '未知错误'),
        actions: '<button class="btn btn-default" data-act="reload-storage">重试</button>'
      })}
    </div></div>`;
    applyIcons(panel);
  }
}

function storageHtml(data, ctx) {
  const used = Number(data?.used || 0);
  const trashed = Number(data?.trashed || 0);
  const quota = Number(data?.quota || 0);
  const limited = quota > 0;
  const percent = limited ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  const byType = Array.isArray(data?.byType) ? data.byType : [];
  const totalBytes = byType.reduce((s, t) => s + Number(t.bytes || 0), 0) || used || 1;
  const current = ctx.workspace;

  return `
    <div class="grid grid-4 mb-6">
      <div class="card stat-card">
        <div class="stat-top"><span class="stat-label">已用空间</span><span class="stat-ico">${icon('database')}</span></div>
        <div class="stat-value">${esc(data?.usedText || formatBytes(used))}</div>
        <div class="stat-foot">${limited ? `配额 ${formatBytes(quota)} · ${percent}%` : '实例未设置个人配额'}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-top"><span class="stat-label">回收站占用</span><span class="stat-ico">${icon('trash')}</span></div>
        <div class="stat-value">${esc(data?.trashedText || formatBytes(trashed))}</div>
        <div class="stat-foot"><a href="#/trash">前往回收站清理</a></div>
      </div>
      <div class="card stat-card">
        <div class="stat-top"><span class="stat-label">文件类型</span><span class="stat-ico">${icon('layers')}</span></div>
        <div class="stat-value">${formatNumber(byType.length)}</div>
        <div class="stat-foot">按占用空间排序的前 12 类</div>
      </div>
      <div class="card stat-card">
        <div class="stat-top"><span class="stat-label">当前知识库</span><span class="stat-ico">${icon('book')}</span></div>
        <div class="stat-value truncate" style="font-size:var(--fs-lg)">${esc(current?.name || '—')}</div>
        <div class="stat-foot">${current ? '可导出为 ZIP' : '请先创建知识库'}</div>
      </div>
    </div>

    <div class="card mb-6">
      <div class="card-pad">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('database')} 空间用量</div>
            <div class="section-sub">${limited ? `已用 ${data?.usedText || formatBytes(used)} / 配额 ${formatBytes(quota)}` : `已用 ${data?.usedText || formatBytes(used)} · 不限额`}</div>
          </div>
          <div class="section-actions"><span class="text-sm text-muted">${limited ? `${percent}%` : '不限额'}</span></div>
        </div>
        ${limited
          ? progressHtml(percent, { status: percent >= 90 ? 'danger' : (percent >= 70 ? '' : 'success') })
          : `<div class="progress"><span style="width:100%;opacity:.28"></span></div>`}
        <div class="field-hint mt-2">${limited
          ? '接近配额时请清理回收站或删除不再需要的文件，否则上传会被拒绝。'
          : '当前账号未设置存储配额，用量只受服务器磁盘容量限制。'}</div>
      </div>
    </div>

    <div class="card mb-6">
      <div class="card-pad" style="padding-bottom:6px">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('file')} 按类型分布</div>
            <div class="section-sub">仅统计未删除的文件</div>
          </div>
        </div>
      </div>
      ${byType.length ? `<table class="table">
        <thead><tr><th>类型</th><th class="num">文件数</th><th class="num">占用</th><th style="width:34%">占比</th></tr></thead>
        <tbody>
          ${byType.map((t) => {
            const share = (Number(t.bytes || 0) / totalBytes) * 100;
            return `<tr>
              <td><span class="text-mono">${esc(String(t.ext || '—').toUpperCase())}</span></td>
              <td class="num">${formatNumber(t.count)}</td>
              <td class="num">${esc(t.text || formatBytes(t.bytes))}</td>
              <td>
                <div class="flex items-center gap-2">
                  <div class="flex-1">${progressHtml(share)}</div>
                  <span class="text-xs text-muted nowrap">${share.toFixed(1)}%</span>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>` : emptyState({ iconName: 'file', title: '还没有文件', desc: '上传文档后这里会显示存储分布' })}
    </div>

    <div class="card">
      <div class="card-pad">
        <div class="section-head">
          <div>
            <div class="section-title">${icon('download')} 导出数据</div>
            <div class="section-sub">把当前知识库导出为 ZIP，包含笔记 Markdown 与原始文件</div>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-wrap">
          <button class="btn btn-primary" data-act="export-all" ${current ? '' : 'disabled'}>${icon('download')}<span>导出全部数据（含原始文件）</span></button>
          <button class="btn btn-default" data-act="export-lite" ${current ? '' : 'disabled'}>${icon('archive')}<span>仅导出笔记与元数据</span></button>
        </div>
        <div class="field-hint mt-2">导出为流式下载，包内含 README 与 manifest.json 便于二次处理。导出操作会写入审计日志。</div>
      </div>
    </div>

    <div class="text-xs text-muted mt-4">统计刷新时间：${esc(formatDateTime(new Date().toISOString()))} · 数据来源 /api/users/me/storage</div>`;
}

function bindStorage(container, ctx) {
  const offs = [];
  const panel = qs('[data-panel="storage"]', container);

  offs.push(on(panel, 'click', '[data-act="reload-storage"]', () => loadStorage(container, ctx)));

  const doExport = (includeFiles) => {
    const ws = ctx.workspace;
    if (!ws) { notify.warn('请先创建或选择一个知识库'); return; }
    try {
      downloadUrl(ctx.api.exportWorkspaceUrl(ws.id, includeFiles));
      notify.info('导出已开始，请留意浏览器下载');
    } catch (err) {
      notify.error(err?.message || '导出失败');
    }
  };

  offs.push(on(panel, 'click', '[data-act="export-all"]', () => doExport(true)));
  offs.push(on(panel, 'click', '[data-act="export-lite"]', () => doExport(false)));

  return offs;
}

export default { meta, mount, unmount };
