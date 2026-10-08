#!/usr/bin/env node
/**
 * KBPRO 演示文档上传器
 * ====================
 *
 * 把 scripts/make-demo-docs.py 生成的文档按主题上传到知识库对应的文件夹里。
 * 目录名即文件夹名：demo-docs/学习资料/* -> 知识库中的「学习资料」文件夹。
 *
 * 用法：
 *   node scripts/upload-demo-docs.mjs
 *   node scripts/upload-demo-docs.mjs --base http://127.0.0.1:8787 \
 *        --email admin@kbpro.local --password admin12345 \
 *        --dir demo-docs --workspace all
 *
 * 参数：
 *   --base       服务地址（默认 http://127.0.0.1:8787）
 *   --email      登录邮箱（默认 admin@kbpro.local）
 *   --password   登录密码（默认 admin12345）
 *   --dir        文档目录（默认 demo-docs）
 *   --workspace  all | personal | team（默认 all）
 *   --force      即使同名文件已存在也重新上传
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const out = {
    base: 'http://127.0.0.1:8787',
    email: 'admin@kbpro.local',
    password: 'admin12345',
    dir: 'demo-docs',
    workspace: 'all',
    force: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') out.base = argv[++i];
    else if (a === '--email') out.email = argv[++i];
    else if (a === '--password') out.password = argv[++i];
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--workspace') out.workspace = argv[++i];
    else if (a === '--force') out.force = true;
  }
  out.base = out.base.replace(/\/+$/, '');
  out.dir = path.isAbsolute(out.dir) ? out.dir : path.join(ROOT, out.dir);
  return out;
}

const args = parseArgs(process.argv.slice(2));
let cookie = '';

/* ------------------------------------------------------------------ 工具 */

async function api(method, p, body) {
  const headers = { Cookie: cookie };
  let payload = body;
  if (body !== undefined && !(body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(args.base + p, { method, headers, body: payload });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    if (c.startsWith('kbpro_session=')) cookie = c.split(';')[0];
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => null) : await res.text();
  return { status: res.status, data };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function humanSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

/* ------------------------------------------------------------------ 主流程 */

async function main() {
  console.log('KBPRO 演示文档上传');
  console.log('─'.repeat(64));
  console.log(`服务地址：${args.base}`);
  console.log(`文档目录：${args.dir}`);

  if (!fs.existsSync(args.dir)) {
    console.error(`\n✗ 目录不存在：${args.dir}\n  请先运行：python scripts/make-demo-docs.py demo-docs`);
    process.exit(1);
  }

  // 登录
  const login = await api('POST', '/api/auth/login', { email: args.email, password: args.password });
  if (login.status !== 200) {
    console.error(`\n✗ 登录失败（${login.status}）：${login.data?.error || '请检查账号密码与服务地址'}`);
    process.exit(1);
  }
  console.log(`✓ 登录成功：${login.data.user.name}`);

  // 收集待上传文档：{ 主题: [文件路径] }
  const themes = {};
  for (const entry of await fsp.readdir(args.dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(args.dir, entry.name);
    const files = (await fsp.readdir(dir)).filter((f) => !f.startsWith('~') && !f.startsWith('.'));
    if (files.length) themes[entry.name] = files.map((f) => path.join(dir, f));
  }
  const themeNames = Object.keys(themes).sort();
  if (!themeNames.length) {
    console.error('\n✗ 没有找到任何主题目录');
    process.exit(1);
  }
  const totalFiles = themeNames.reduce((s, t) => s + themes[t].length, 0);
  console.log(`✓ 待上传：${themeNames.length} 个主题 / ${totalFiles} 个文档`);

  // 目标知识库
  const wsRes = await api('GET', '/api/workspaces');
  let workspaces = wsRes.data.workspaces || [];
  if (args.workspace === 'personal') workspaces = workspaces.filter((w) => w.kind === 'personal');
  else if (args.workspace === 'team') workspaces = workspaces.filter((w) => w.kind === 'team');
  if (!workspaces.length) {
    console.error('\n✗ 没有匹配的知识库');
    process.exit(1);
  }

  const uploaded = [];   // { workspaceId, folderName, name, fileId }
  const skipped = [];
  const failed = [];

  for (const ws of workspaces) {
    console.log('');
    console.log(`知识库：${ws.name}（${ws.kind}）`);

    // 文件夹名 -> id
    const folderRes = await api('GET', `/api/workspaces/${ws.id}/folders`);
    const folderByName = new Map();
    for (const fid of (folderRes.data.flat || [])) {
      folderByName.set(fid.name, fid.id);
    }

    for (const theme of themeNames) {
      const folderId = folderByName.get(theme);
      if (!folderId) {
        console.log(`  ⚠ 跳过「${theme}」：该知识库中没有同名文件夹`);
        continue;
      }

      // 该文件夹下已存在的文件名（用于跳过）
      const existing = new Set();
      if (!args.force) {
        const listRes = await api('GET', `/api/files?workspaceId=${ws.id}&folderId=${folderId}&limit=200`);
        for (const f of (listRes.data.files || [])) existing.add(f.name);
      }

      console.log(`  📁 ${theme}`);
      for (const full of themes[theme]) {
        const name = path.basename(full);
        if (existing.has(name)) {
          skipped.push(name);
          console.log(`     ─ 已存在，跳过  ${name}`);
          continue;
        }
        try {
          const buf = await fsp.readFile(full);
          const fd = new FormData();
          fd.append('workspaceId', ws.id);
          fd.append('folderId', folderId);
          fd.append('file', new Blob([buf]), name);
          const res = await fetch(`${args.base}/api/files/upload`, {
            method: 'POST', headers: { Cookie: cookie }, body: fd
          });
          const data = await res.json().catch(() => null);
          if (res.ok && data?.ok && data.files?.length) {
            uploaded.push({ workspaceId: ws.id, theme, name, fileId: data.files[0].id });
            console.log(`     ✓ ${name}  (${humanSize(buf.length)})`);
          } else {
            failed.push({ name, reason: data?.error || `HTTP ${res.status}` });
            console.log(`     ✗ ${name}  ${data?.error || res.status}`);
          }
        } catch (err) {
          failed.push({ name, reason: err.message });
          console.log(`     ✗ ${name}  ${err.message}`);
        }
        await sleep(60);   // 轻量节流，避免一次性打满解析队列
      }
    }
  }

  /* ---------------- 等待解析完成 ---------------- */
  if (uploaded.length) {
    console.log('');
    console.log(`等待 ${uploaded.length} 个文档解析完成…`);
    const pending = new Map(uploaded.map((u) => [u.fileId, u]));
    const deadline = Date.now() + 5 * 60 * 1000;
    let lastReport = 0;
    while (pending.size && Date.now() < deadline) {
      for (const [fileId, info] of [...pending]) {
        const r = await api('GET', `/api/files/${fileId}/text`);
        const status = r.data?.status;
        if (status === 'ok' || status === 'empty' || status === 'failed') {
          info.status = status;
          info.chars = r.data?.chars || 0;
          info.pages = r.data?.pages || 0;
          info.warning = r.data?.error || '';
          pending.delete(fileId);
        }
      }
      const done = uploaded.length - pending.size;
      if (done !== lastReport) {
        lastReport = done;
        process.stdout.write(`\r  进度 ${done}/${uploaded.length}`);
      }
      if (pending.size) await sleep(600);
    }
    process.stdout.write('\r' + ' '.repeat(40) + '\r');
  }

  /* ---------------- 汇总 ---------------- */
  const ok = uploaded.filter((u) => u.status === 'ok');
  const empty = uploaded.filter((u) => u.status === 'empty');
  const parseFailed = uploaded.filter((u) => u.status === 'failed');
  const timedOut = uploaded.filter((u) => !u.status);

  console.log('─'.repeat(64));
  console.log(`上传成功 ${uploaded.length} 个${skipped.length ? ` · 跳过 ${skipped.length} 个` : ''}${failed.length ? ` · 上传失败 ${failed.length} 个` : ''}`);
  console.log(`解析完成 ${ok.length} 个${empty.length ? ` · 无文本 ${empty.length} 个` : ''}${parseFailed.length ? ` · 解析失败 ${parseFailed.length} 个` : ''}${timedOut.length ? ` · 超时未完成 ${timedOut.length} 个` : ''}`);

  if (ok.length) {
    console.log('\n已建立索引的文档（按知识库 / 文件夹）：');
    const byWs = new Map();
    for (const u of ok) {
      if (!byWs.has(u.workspaceId)) byWs.set(u.workspaceId, []);
      byWs.get(u.workspaceId).push(u);
    }
    for (const ws of workspaces) {
      const list = byWs.get(ws.id) || [];
      if (!list.length) continue;
      console.log(`  ${ws.name}：`);
      const byTheme = new Map();
      for (const u of list) {
        if (!byTheme.has(u.theme)) byTheme.set(u.theme, []);
        byTheme.get(u.theme).push(u);
      }
      for (const [theme, items] of byTheme) {
        console.log(`    ${theme}（${items.length}）`);
        for (const it of items) {
          console.log(`      - ${it.name}  ${it.chars} 字${it.pages ? ` · ${it.pages} 页` : ''}`);
        }
      }
    }
  }

  for (const e of [...empty, ...parseFailed]) {
    console.log(`\n  ⚠ ${e.name}：${e.status === 'empty' ? '未提取到文本' : '解析失败'}${e.warning ? `（${e.warning}）` : ''}`);
  }
  for (const f of failed) {
    console.log(`\n  ✗ ${f.name}：${f.reason}`);
  }

  console.log('');
  console.log(ok.length ? '✓ 文档已进入知识库，可在「全局检索」与「智能问答」中体验。' : '✗ 没有文档成功入库。');
  process.exit(failed.length || parseFailed.length ? 1 : 0);
}

main().catch((err) => {
  console.error('\n执行异常：', err);
  process.exit(1);
});
