/**
 * KBPRO — 个人 & 团队轻量化智能知识库平台
 * 服务端入口：HTTP 服务器 / 路由分发 / 静态资源 / 优雅关闭
 *
 * 启动： node server/index.js
 */
import http from 'node:http';
import path from 'node:path';
import url from 'node:url';
import fs from 'node:fs';
import os from 'node:os';

import {
  ROOT, WEB_DIR, DATA_DIR, FILES_DIR, DB_PATH, ensureDirs, loadConfig
} from './config.js';
import { getDb, closeDb, audit, all, get, run, scalar, tableCounts, dbSizeBytes } from './db.js';
import {
  Router, readJson, parseQuery, sendJson, sendError, sendText, serveStatic, HttpError, clientIp
} from './lib/http.js';
import { authenticate, requireUser, bootstrap, publicUser, findUserByEmail, createSession, cookieHeader } from './auth.js';
import { registerCoreRoutes } from './routes/core.js';
import { registerContentRoutes } from './routes/content.js';
import { registerAiRoutes } from './routes/ai.js';
import { queueState } from './lib/pipeline.js';
import { probeOllama } from './lib/ai.js';

const cfg = loadConfig();
ensureDirs();
getDb();

/* ------------------------------------------------------------------ 路由装配 */

const router = new Router();

registerCoreRoutes(router);
registerContentRoutes(router);
registerAiRoutes(router);

router.get('/api/health', async (req, res) => {
  sendJson(res, 200, {
    ok: true,
    service: 'kbpro',
    version: '1.0.0',
    time: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    queue: queueState(),
    db: { size: dbSizeBytes() }
  });
});

/* ------------------------------------------------------------------ 测试专用

   仅当环境变量 KBPRO_TEST_LOGIN=1 时挂载，用于自动化浏览器端到端测试
   （无头浏览器需要先获得一个会话 Cookie）。生产环境绝不启用。
   ------------------------------------------------------------------ */
if (process.env.KBPRO_TEST_LOGIN === '1') {
  console.warn('[kbpro] ⚠ KBPRO_TEST_LOGIN=1 —— 已启用测试登录接口，切勿在生产环境使用');

  const testRouter = new Router();
  testRouter.get('/api/test/login', async (req, res) => {
    const as = String(req.url.split('as=')[1] || '').split('&')[0];
    const email = as ? decodeURIComponent(as) : loadConfig().bootstrap.email;
    const user = findUserByEmail(email);
    if (!user) return sendError(res, 404, `测试账号不存在：${email}`);
    const { token } = createSession(user.id, { ip: '127.0.0.1', ua: 'kbpro-browser-test' });
    res.setHeader('Set-Cookie', cookieHeader(token));
    sendJson(res, 200, { ok: true, token, user: publicUser(user, { self: true }) });
  });
  // 无头浏览器的 virtual-time 会因 SSE 长连接永不推进而挂起，测试模式下直接结束
  testRouter.get('/api/events', async (req, res) => {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  });
  testRouter.get('/api/collab/:resourceType/:resourceId/stream', async (req, res) => {
    res.writeHead(204, { 'Cache-Control': 'no-store' });
    res.end();
  });

  // 必须置于业务路由之前：Router 只匹配首个命中的路由
  router.routes.unshift(...testRouter.routes);
}

/* ------------------------------------------------------------------ 安全头 */

const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "frame-src 'self' blob:",
  "object-src 'self' blob:",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

function applySecurityHeaders(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (!String(req.url).startsWith('/api/files') && !String(req.url).startsWith('/api/assets')) {
    res.setHeader('Content-Security-Policy', CSP);
  }
}

/* ------------------------------------------------------------------ 请求处理 */

async function handleRequest(req, res) {
  const reqUrl = req.url || '/';
  let parsed;
  let pathname;
  try {
    parsed = new URL(reqUrl, 'http://localhost');
    pathname = decodeURI(parsed.pathname || '/');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '请求路径编码非法' }));
    return;
  }
  const query = parseQuery(reqUrl);

  applySecurityHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400'
    });
    res.end();
    return;
  }

  const matched = router.match(req.method, pathname);

  if (matched?.route) {
    const ctx = { params: matched.params, query, url: reqUrl, pathname, body: {}, ...authenticate(req) };
    ctx.requireUser = () => requireUser(req).user;

    // 解析请求体（multipart 由各路由自行处理）
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const ct = String(req.headers['content-type'] || '');
      if (ct.includes('application/json') || ct === '') {
        try {
          ctx.body = await readJson(req);
        } catch (err) {
          return sendError(res, err.status || 400, err.message);
        }
      }
    }
    // 兼容：部分客户端用 DELETE 带 body
    if (req.method === 'DELETE' && String(req.headers['content-type'] || '').includes('application/json')) {
      try { ctx.body = await readJson(req); } catch { ctx.body = {}; }
    }

    try {
      await matched.route.handler(req, res, ctx);
    } catch (err) {
      if (res.writableEnded) return;
      const status = err instanceof HttpError ? err.status : (err?.status || 500);
      if (status >= 500) {
        console.error(`[kbpro] ${req.method} ${pathname} -> ${status}`, err?.stack || err);
      }
      sendError(res, status, err?.message || '服务器内部错误', err?.extra || {});
    }
    return;
  }

  if (matched?.methodMismatch) {
    sendError(res, 405, `方法 ${req.method} 不被支持`);
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendError(res, 404, `接口不存在：${req.method} ${pathname}`);
    return;
  }

  // 静态资源（SPA 回退到 index.html）
  const served = await serveStatic(req, res, WEB_DIR, pathname, { spa: true });
  if (!served) {
    const indexHtml = path.join(WEB_DIR, 'index.html');
    if (fs.existsSync(indexHtml)) {
      const buf = await fs.promises.readFile(indexHtml);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': buf.length });
      res.end(buf);
    } else {
      sendText(res, 404, 'KBPRO 前端资源缺失，请确认 web/index.html 存在');
    }
  }
}

/* ------------------------------------------------------------------ 服务器 */

const server = http.createServer((req, res) => {
  const started = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - started;
    if (process.env.KBPRO_QUIET === '1') return;
    if (String(req.url).startsWith('/api/events') || String(req.url).includes('/stream')) return;
    if (ms < 200 && /\.(css|js|svg|png|ico|woff2?)$/.test(req.url || '')) return;
    console.log(`[kbpro] ${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
  });
  handleRequest(req, res).catch((err) => {
    console.error('[kbpro] 未捕获异常', err);
    if (!res.writableEnded) sendError(res, 500, '服务器内部错误');
  });
});

server.headersTimeout = 0;
server.requestTimeout = 0;
server.keepAliveTimeout = 72000;

/* ------------------------------------------------------------------ 启动 */

function localAddresses() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

export async function start({ port = cfg.port, host = cfg.host, silent = false } = {}) {
  const info = bootstrap();
  if (info.created && !silent) {
    console.log('');
    console.log('  ┌────────────────────────────────────────────────────────────┐');
    console.log('  │  KBPRO 初始化完成，已创建默认管理员账号                    │');
    console.log('  └────────────────────────────────────────────────────────────┘');
    console.log(`     邮箱：${info.admin.email}`);
    console.log(`     密码：${info.admin.password}`);
    console.log('     ⚠️  请在「个人中心 → 安全设置」中立即修改密码');
    console.log('');
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  if (!silent) {
    const counts = tableCounts();
    let ollama = { ok: false, models: [] };
    try { ollama = await probeOllama(cfg.ai.ollamaUrl, 1200); } catch { /* */ }

    console.log('');
    console.log('  \x1b[1mKBPRO\x1b[0m  个人 & 团队轻量化智能知识库平台  v1.0.0');
    console.log('  ────────────────────────────────────────────────────────────');
    console.log(`  ▸ 访问地址   http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`);
    for (const ip of (host === '0.0.0.0' ? localAddresses() : [])) {
      console.log(`  ▸ 局域网     http://${ip}:${actualPort}`);
    }
    console.log(`  ▸ 数据目录   ${DATA_DIR}`);
    console.log(`  ▸ 知识库     ${counts.workspaces} 个 · 文件 ${counts.files} · 笔记 ${counts.notes} · 用户 ${counts.users}`);
    console.log(`  ▸ AI 引擎    ${ollama.ok ? `Ollama 可用（${ollama.models.length} 个模型）` : '内置本地抽取式引擎（可在个人中心接入大模型）'}`);
    console.log('  ────────────────────────────────────────────────────────────');
    console.log('  按 Ctrl+C 停止服务');
    console.log('');
  }

  return { server, port: actualPort, host, url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}` };
}

export async function stop() {
  await new Promise((resolve) => server.close(() => resolve()));
  closeDb();
}

/* ------------------------------------------------------------------ 直接运行 */

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(url.fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) {
  start().catch((err) => {
    if (err?.code === 'EADDRINUSE') {
      console.error(`\n  ✖ 端口 ${cfg.port} 已被占用。请设置环境变量 KBPRO_PORT 指定其它端口，例如：`);
      console.error(`     $env:KBPRO_PORT=8899; node server/index.js\n`);
    } else {
      console.error('启动失败：', err);
    }
    process.exit(1);
  });

  const shutdown = async (signal) => {
    console.log(`\n[kbpro] 收到 ${signal}，正在关闭…`);
    try {
      await stop();
      console.log('[kbpro] 已安全退出');
    } catch { /* */ }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (err) => {
    console.error('[kbpro] 未处理的 Promise 拒绝：', err);
  });
}

export { router, server };
