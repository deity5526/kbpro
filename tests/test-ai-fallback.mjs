/**
 * KBPRO — 大模型交互链路的容错测试
 *
 * 用**假的 OpenAI 兼容上游**复现真实世界里的上游异常，验证 KBPRO 的降级行为是否正确：
 *   1. 正常流式 / 非流式
 *   2. 流到一半连接被中断（部分内容已吐给用户）
 *   3. 上游在流中回吐 error 负载
 *   4. 上游拒绝 thinking 参数（400）
 *   5. 无知识库依据 + 大模型失败时的输出是否干净
 *   6. 用户自定义 Base URL 的 SSRF 防护
 *
 * 不需要任何真实 API Key，全部走本地假上游。
 * 运行： node tests/test-ai-fallback.mjs
 */
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';

const TMP_ROOT = path.join(os.tmpdir(), `kbpro-ai-${Date.now().toString(36)}`);
process.env.KBPRO_DATA = TMP_ROOT;
process.env.KBPRO_QUIET = '1';

let passed = 0, failed = 0;
const failures = [];
let section = '';

function head(n) { section = n; console.log(`\n\x1b[36m▸ ${n}\x1b[0m`); }
function check(cond, label, detail) {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}`); }
  else {
    failed++;
    failures.push(`[${section}] ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)?.slice(0, 400)}` : ''}`);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail !== undefined ? `  → ${JSON.stringify(detail)?.slice(0, 320)}` : ''}`);
  }
}

/* ================================================================== 假上游 */

const hits = [];          // { scenario, path, thinking }
let upstreamPort = 0;

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}
function sseChunk(text) {
  return { id: 'x', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: text } }] };
}

const upstream = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const parts = u.pathname.split('/').filter(Boolean);
  // 场景名取第一段；允许带后缀（例如 rejectthinking-deepseek 用于让 baseUrl 含 deepseek）
  const KNOWN = ['ok-nonstream', 'ok', 'midfail', 'errorpayload', 'rejectthinking', 'servererror', 'unreachable'];
  const seg = parts[0] || 'ok';
  const scenario = KNOWN.find((k) => seg === k || seg.startsWith(`${k}-`)) || seg;

  let raw = '';
  for await (const c of req) raw += c;
  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch { /* */ }

  hits.push({ scenario, path: u.pathname, thinking: !!body.thinking });

  // 模型列表
  if (u.pathname.endsWith('/models')) {
    if (scenario === 'unreachable') { res.destroy(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'fake-model' }, { id: 'other-model' }] }));
    return;
  }

  if (!u.pathname.endsWith('/chat/completions')) {
    res.writeHead(404); res.end('not found'); return;
  }

  switch (scenario) {
    /* ---- 正常 ---- */
    case 'ok': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, sseChunk('上游'));
      sse(res, sseChunk('回答'));
      sse(res, sseChunk('完成'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    case 'ok-nonstream': {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { role: 'assistant', content: '非流式回答' } }],
        usage: { total_tokens: 7 }
      }));
      return;
    }

    /* ---- 流到一半断开：部分内容已经发给用户 ---- */
    case 'midfail': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, sseChunk('前半段'));
      sse(res, sseChunk('内容'));
      setTimeout(() => { try { res.destroy(); } catch { /* */ } }, 30);
      return;
    }

    /* ---- 流中回吐 error 负载 ---- */
    case 'errorpayload': {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, sseChunk('开始'));
      sse(res, { error: { message: 'rate limit exceeded', type: 'rate_limit_error' } });
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    /* ---- 上游不支持 thinking 参数：带 thinking 就 400，不带才成功 ---- */
    case 'rejectthinking': {
      if (body.thinking || body.reasoning_effort) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: thinking' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      sse(res, sseChunk('不带 thinking 也'));
      sse(res, sseChunk('能成功'));
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    /* ---- 永远 500 ---- */
    case 'servererror': {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'internal error' } }));
      return;
    }

    default: {
      res.writeHead(404); res.end('unknown scenario');
    }
  }
});

/* ================================================================== 客户端 */

let BASE = '', cookie = '';

async function api(method, p, body) {
  const headers = { Cookie: cookie };
  let payload = body;
  if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${p}`, { method, headers, body: payload });
  for (const c of (res.headers.getSetCookie?.() || [])) {
    if (c.startsWith('kbpro_session=')) cookie = c.split(';')[0];
  }
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/** 调 /api/ai/ask 并收集流式 token */
async function askStream(question, workspaceId, extra = {}) {
  const res = await fetch(`${BASE}/api/ai/ask`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ question, workspaceId, stream: true, ...extra })
  });
  if (!res.ok) {
    const d = await res.json().catch(() => null);
    return { ok: false, status: res.status, error: d?.error, text: '', events: [], done: null };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder('utf-8');
  let buf = '', text = '', done = null;
  const events = [];
  for (;;) {
    const { done: fin, value } = await reader.read();
    if (fin) break;
    buf += dec.decode(value, { stream: true });
    const blocks = buf.split('\n\n');
    buf = blocks.pop() || '';
    for (const b of blocks) {
      if (!b.trim() || b.startsWith(':')) continue;
      const ev = b.split('\n').find((l) => l.startsWith('event:'))?.slice(6).trim();
      const dataLine = b.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n');
      if (!ev) continue;
      if (!events.includes(ev)) events.push(ev);
      let d = null;
      try { d = JSON.parse(dataLine); } catch { /* */ }
      if (ev === 'token') text += d?.text || '';
      if (ev === 'done') done = d;
    }
  }
  return { ok: true, text, events, done };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================================================================== 主流程 */

async function main() {
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  upstreamPort = upstream.address().port;
  const UP = `http://127.0.0.1:${upstreamPort}`;
  console.log('KBPRO 大模型容错测试');
  console.log(`假上游：${UP}`);

  const { start, stop } = await import('../server/index.js');
  const started = await start({ port: 0, host: '127.0.0.1', silent: true });
  BASE = started.url;
  console.log(`服务：${BASE}\n`);

  try {
    await api('POST', '/api/auth/login', { email: 'admin@kbpro.local', password: 'admin12345' });
    const me = await (await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } })).json();
    const ws = me.workspaces.find((w) => w.kind === 'personal');

    /* ---------------- 1. 正常路径 ---------------- */
    head('正常路径 · 流式与非流式');
    {
      // —— 流式端点 ——
      await api('PUT', '/api/users/me/ai', { provider: 'openai', baseUrl: `${UP}/ok/v1`, model: 'fake-model', apiKey: 'test-key' });
      const r = await askStream('随便问一个问题', ws.id);
      check(r.ok, '流式问答请求成功');
      check(r.text.includes('上游回答完成'), '流式内容完整拼接', r.text);
      check(!r.text.includes('本地'), '未触发降级', r.text);
      check(r.done && r.done.provider === 'openai', 'done 事件报告 openai', r.done?.provider);

      // —— 非流式端点 ——
      await api('PUT', '/api/users/me/ai', { provider: 'openai', baseUrl: `${UP}/ok-nonstream/v1`, model: 'fake-model', apiKey: 'test-key' });
      const nr = await api('POST', '/api/ai/ask', { question: '非流式', workspaceId: ws.id, stream: false });
      check(nr.data?.answer === '非流式回答', '非流式回答正确', nr.data?.answer);
      check(nr.data?.provider === 'openai', '非流式 provider 正确');
    }

    /* ---------------- 1b. 上游无视 stream:false，仍返回 SSE ---------------- */
    head('兼容性 · 上游无视 stream:false 仍返回 SSE');
    {
      await api('PUT', '/api/users/me/ai', { provider: 'openai', baseUrl: `${UP}/ok/v1`, model: 'fake-model', apiKey: 'k' });
      const r = await api('POST', '/api/ai/ask', { question: '非流式但上游给 SSE', workspaceId: ws.id, stream: false });
      check(r.status === 200, '请求成功');
      check(r.data?.answer === '上游回答完成', '仍能正确解析出完整回答', r.data?.answer);
    }

    /* ---------------- 2. 流到一半断开 ---------------- */
    head('流中断 · 部分内容已输出后上游断开');
    {
      await api('PUT', '/api/users/me/ai', { provider: 'openai', baseUrl: `${UP}/midfail/v1`, model: 'fake-model', apiKey: 'k' });
      const r = await askStream('请给出一段较长的回答', ws.id);
      check(r.ok, '请求未把连接搞崩');
      check(r.text.includes('前半段'), '已输出的部分内容保留给用户', r.text.slice(0, 80));
      // 关键：降级内容不能悄悄拼接到已输出的半截内容后面
      check(!/本地引擎|抽取式引擎从知识库原文|依据知识库内容的回答/.test(r.text),
        '流中断后不得把完整本地答案拼接在半截大模型输出之后', r.text.slice(0, 200));
      check(/中断|失败|不完整|截断/.test(r.text), '明确告知用户回答被中断/不完整', r.text.slice(0, 200));
      check(r.done && r.done.error, 'done 事件带上错误信息', r.done?.error);
    }

    /* ---------------- 3. 流中 error 负载 ---------------- */
    head('流中错误负载 · 上游在 SSE 里回吐 error');
    {
      await api('PUT', '/api/users/me/ai', { provider: 'openai', baseUrl: `${UP}/errorpayload/v1`, model: 'fake-model', apiKey: 'k' });
      const r = await askStream('任意问题', ws.id);
      check(r.ok, '请求正常返回');
      check(r.text.includes('开始'), '已收到部分内容', r.text.slice(0, 60));
      check(!/^开始$/.test(r.text.trim()), '不能把「开始」当成完整答案静默返回', r.text);
      check(r.done && (r.done.error || r.done.fallback), '错误负载被识别并上报', r.done);
    }

    /* ---------------- 4. 上游拒绝 thinking ---------------- */
    head('参数兼容 · 上游拒绝 thinking 参数');
    {
      hits.length = 0;
      // baseUrl 需包含 deepseek，才会触发思考参数逻辑
      await api('PUT', '/api/users/me/ai', { provider: 'openai', baseUrl: `${UP}/rejectthinking-deepseek/v1`, model: 'deepseek-flash', apiKey: 'k' });
      const r = await askStream('问一个问题', ws.id);
      const attempts = hits.filter((h) => h.scenario === 'rejectthinking' && h.path.endsWith('/chat/completions'));
      check(attempts.length >= 2, '带 thinking 被 400 后会重试一次', attempts.length);
      check(attempts.some((a) => a.thinking), '首次请求确实带了 thinking');
      check(attempts.some((a) => !a.thinking), '重试时去掉了 thinking');
      check(r.text.includes('能成功'), '重试后成功拿到回答', r.text);
    }

    /* ---------------- 5. 无依据 + 大模型失败 ---------------- */
    head('无知识库依据 · 大模型失败时的输出必须干净');
    {
      await api('PUT', '/api/users/me/ai', { provider: 'openai', baseUrl: `${UP}/servererror/v1`, model: 'fake-model', apiKey: 'k' });
      const r = await askStream('这个知识库里完全没有的问题', ws.id);
      check(r.ok, '请求正常返回');
      check(!r.text.includes('本地引擎未获得可用输入'), '不得把内部占位文案吐给用户', r.text.slice(0, 200));
      check(r.text.includes('暂无') || r.text.includes('没有'), '给出「知识库暂无依据」的明确提示', r.text.slice(0, 160));
      check((r.text.match(/知识库中暂无/g) || []).length <= 1, '提示文案不重复出现', r.text.slice(0, 240));
    }

    /* ---------------- 6. 通用回答必须被标记 ---------------- */
    head('可信度 · 未引用知识库的通用回答必须带标记且能持久化');
    {
      await api('PUT', '/api/users/me/ai', { provider: 'openai', baseUrl: `${UP}/ok/v1`, model: 'fake-model', apiKey: 'k' });
      const r = await askStream('一个知识库里完全没有的内容', ws.id);
      check(r.done && r.done.general === true, '无依据时 done 事件标记 general=true', r.done);
      check(Array.isArray(r.done?.citations) && r.done.citations.length === 0,
        '通用回答不携带任何引用来源', r.done?.citations);
      check(r.text.includes('上游回答完成'), '通用回答内容正常返回', r.text);

      // 刷新会话后标记必须还在，否则用户会误以为它来自自己的文档
      const chatId = r.done?.chatId;
      check(!!chatId, '拿到会话 ID', chatId);
      const detail = await api('GET', `/api/chats/${chatId}`);
      const asst = (detail.data?.messages || []).filter((m) => m.role === 'assistant').pop();
      check(!!asst, '会话详情包含助手消息');
      check(asst?.general === true, '重新打开会话后 general 标记仍在（持久化生效）', asst);
      check((asst?.citations || []).length === 0, '持久化的通用回答同样没有引用', asst?.citations);
    }

    /* ---------------- 7. 有依据时不得误标 ---------------- */
    head('可信度 · 有知识库依据时不得误报「未引用知识库」');
    {
      // 先往知识库放一份文档并等待索引
      const content = '# 唯一标记文档\n\n本文件包含唯一标记 UNIQMARK42，用于验证引用判定。\n';
      const fd = new FormData();
      fd.append('workspaceId', ws.id);
      fd.append('file', new Blob([content], { type: 'text/markdown' }), '唯一标记.md');
      const up = await (await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: { Cookie: cookie }, body: fd })).json();
      check(up.ok, '上传用于验证的文档');
      const fileId = up.files[0].id;
      for (let i = 0; i < 40; i++) {
        const t = await api('GET', `/api/files/${fileId}/text`);
        if (t.data?.status === 'ok') break;
        await sleep(200);
      }

      const r = await askStream('UNIQMARK42 是什么？', ws.id);
      check(r.done && r.done.general !== true, '命中知识库时不得标记为通用回答', r.done?.general);
      check(Array.isArray(r.done?.citations) && r.done.citations.length > 0,
        '命中知识库时带引用来源', r.done?.citations?.length);
    }

    /* ---------------- 8b. 推理模型思维链过滤 ---------------- */
    head('推理模型 · 思维链不得泄漏给用户');
    {
      const { createThinkFilter, stripThinkTags } = await import('../server/lib/ai.js');

      check(stripThinkTags('<think>我要仔细想想……\n1+1=2</think>答案是 2。') === '答案是 2。',
        '非流式：思维链被完整剥离');
      check(stripThinkTags('没有思维链的普通回答') === '没有思维链的普通回答', '非流式：无标签时原样返回');
      check(stripThinkTags('<thinking>长推理</thinking>结论') === '结论', '兼容 <thinking> 变体');

      // 流式：把内容切成小块喂入，模拟 token 流（含标签被切断的情况）
      const cases = [
        [['<think>推理过程</think>最终答案'], '最终答案'],
        [['<thi', 'nk>推理', '</thi', 'nk>最终', '答案'], '最终答案'],
        [['前缀<think>中段推理</think>后缀'], '前缀后缀'],
        [['<think>只有推理没有正文</think>'], ''],
        [['普通回答'], '普通回答'],
        [['答案里提到 think 这个词'], '答案里提到 think 这个词']
      ];
      for (const [chunks, expected] of cases) {
        let out = '';
        const f = createThinkFilter((t) => { out += t; });
        for (const c of chunks) f.push(c);
        f.flush();
        check(out === expected, `流式分块剥离：${JSON.stringify(chunks.join(''))}`, { got: out, expected });
      }

      // 逐字节切分（最坏情况）也不能泄漏标签碎片
      let out2 = '';
      const f2 = createThinkFilter((t) => { out2 += t; });
      for (const ch of '<think>a</think>BB<thinking>c</thinking>CC') f2.push(ch);
      f2.flush();
      check(out2 === 'BBCC', '逐字节切分也不泄漏标签碎片', out2);
    }

    /* ---------------- 9. SSRF 防护 ---------------- */
    head('安全 · 用户自定义 Base URL 的 SSRF 防护');
    {
      const cloud = [
        ['http://169.254.169.254/latest/meta-data/v1', '云元数据地址 169.254.169.254'],
        ['http://100.100.100.200/v1', '阿里云元数据 100.100.100.200'],
        ['http://[fd00:ec2::254]/v1', 'IPv6 元数据地址']
      ];
      for (const [url, label] of cloud) {
        const r = await api('POST', '/api/users/me/ai/test', { provider: 'openai', baseUrl: url, model: 'm', apiKey: 'k' });
        check(r.status >= 400, `测试连接拒绝${label}`, { status: r.status, error: r.data?.error });
      }
      const save = await api('PUT', '/api/users/me/ai', { provider: 'openai', baseUrl: 'http://169.254.169.254/v1', model: 'm', apiKey: 'k' });
      check(save.status >= 400, '保存配置时同样拒绝云元数据地址', save.status);

      // 不能误伤本地推理服务（这是常见且合法的用法）
      const localOk = await api('POST', '/api/users/me/ai/test', { provider: 'openai', baseUrl: `${UP}/ok/v1`, model: 'fake-model', apiKey: 'k' });
      check(localOk.status === 200, '仍然允许本机/局域网的本地推理服务', { status: localOk.status, error: localOk.data?.error });

      const badScheme = await api('POST', '/api/users/me/ai/test', { provider: 'openai', baseUrl: 'file:///etc/passwd', model: 'm' });
      check(badScheme.status >= 400, '拒绝非 http(s) 协议', badScheme.status);
    }

    /* ---------------- 10. 恢复可用配置 ---------------- */
    head('恢复 · 回到正常配置');
    {
      await api('PUT', '/api/users/me/ai', { provider: 'openai', baseUrl: `${UP}/ok/v1`, model: 'fake-model', apiKey: 'k' });
      const st = await api('GET', '/api/users/me/ai');
      check(st.data?.status?.provider === 'openai', '状态恢复为 openai', st.data?.status);
      const r = await askStream('再问一次', ws.id);
      check(r.text.includes('上游回答完成'), '恢复正常回答', r.text);
    }

  } finally {
    await stop();
    await new Promise((r) => upstream.close(r));
    await fsp.rm(TMP_ROOT, { recursive: true, force: true }).catch(() => {});
  }

  console.log('\n' + '─'.repeat(64));
  console.log(`  通过 ${passed} · 失败 ${failed}`);
  if (failures.length) {
    console.log('\n\x1b[31m失败明细：\x1b[0m');
    for (const f of failures) console.log(`  · ${f}`);
  }
  console.log('─'.repeat(64));
  console.log(failed === 0 ? '\x1b[32mRESULT: PASS\x1b[0m' : '\x1b[31mRESULT: FAIL\x1b[0m');
  process.exitCode = failed === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 100);
}

main().catch((err) => {
  console.error('\n\x1b[31m测试执行异常：\x1b[0m', err);
  process.exit(1);
});
