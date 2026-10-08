/**
 * KBPRO — 示例知识库种子数据
 * 通过 HTTP API 向正在运行的服务导入一批示例文档（Markdown），用于体验检索与智能问答。
 * 幂等：同名文档已存在则跳过。
 *
 * 用法：
 *   先启动服务： node server/index.js
 *   另开终端：   node scripts/seed-demo.mjs   （或 npm run seed）
 *
 * 可用环境变量覆盖：
 *   KBPRO_SEED_BASE      默认 http://127.0.0.1:8787
 *   KBPRO_SEED_EMAIL     默认取 config.json 的 bootstrap.email
 *   KBPRO_SEED_PASSWORD  默认取 config.json 的 bootstrap.password
 *   KBPRO_SEED_WORKSPACE 指定目标知识库 id（默认导入到个人知识库）
 */
import path from 'node:path';
import url from 'node:url';
import { loadConfig } from '../server/config.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
void __dirname;
const cfg = loadConfig();
const BASE = (process.env.KBPRO_SEED_BASE || `http://${cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host}:${cfg.port}`).replace(/\/+$/, '');
const EMAIL = process.env.KBPRO_SEED_EMAIL || cfg.bootstrap.email;
const PASSWORD = process.env.KBPRO_SEED_PASSWORD || cfg.bootstrap.password;

const DOCS = [
  {
    name: '公司简介.md',
    tags: '示例,公司',
    content: `# 星澜科技 · 公司简介

## 一、基本信息
星澜科技（StellarWave）成立于 2018 年 3 月，总部位于杭州，是一家专注于企业级知识管理与人工智能应用的软件公司。
公司现有员工 186 人，其中研发人员 112 人，在成都与西安设有研发中心。2025 年完成 B 轮融资 2.3 亿元人民币。

## 二、主营业务
- 智能知识库平台（KBPRO）：面向个人与团队的知识沉淀与智能问答。
- 企业文档中台：多格式解析、检索与权限治理。
- AI 应用咨询与落地实施。

## 三、企业文化
价值观：客户第一、求真务实、长期主义。
服务理念：让散落的文档变成可对话的知识，帮助组织把经验沉淀为可复用的资产。

## 四、联系方式
- 官网：https://example.com
- 商务合作：bd@example.com
- 客服热线：400-000-1234（工作日 9:00–18:00）
`
  },
  {
    name: 'KBPRO产品手册.md',
    tags: '示例,产品',
    content: `# KBPRO 产品手册

KBPRO 是一套零外部依赖的智能知识库系统，覆盖“文档存储 → 智能解析 → 问答检索 → 知识沉淀”。

## 核心能力
1. 多格式解析：支持 PDF、Word（DOCX）、Excel（XLSX）、PPT（PPTX）、Markdown、TXT、CSV、JSON、HTML 与常见代码文件；自动识别 UTF-8 / GBK / UTF-16 编码。
2. 在线预览：PDF 内联渲染，Office 转结构化 HTML，无需下载。
3. 混合检索：BM25（中文二元组分词）+ 向量召回 + RRF 融合，结果关键词高亮。
4. RAG 问答：文档分块 → 向量化 → 混合召回 → 重排 → 生成，答案逐句标注引用来源（文件 + 页码 + 章节）。
5. 团队协作：个人与团队知识库双体系隔离，5 级角色权限，支持资源级共享与分享链接。

## 部署与运行
- 环境要求：Node.js 22.5 及以上。
- 启动命令：node server/index.js
- 默认访问地址：http://127.0.0.1:8787
- 数据默认存放于项目根目录的 data 目录。

## 能力边界
- 内置哈希嵌入为词面近似，非真正的语义嵌入；接入大模型 embedding 后可提升语义召回。
- 未接入大模型时，问答为抽取式，不做改写润色。
- 加密为服务端对称加密，非端到端零知识。
`
  },
  {
    name: '2026年第三季度经营报告.md',
    tags: '示例,财报',
    content: `# 2026 年第三季度经营报告

## 一、核心结论
本季度营业收入 1.27 亿元，同比增长 23.4%；其中企业服务业务收入 5,180 万元，同比增长 41.2%，是主要增长驱动力。
客户留存率达到 94.7%，较上季度提升 2.1 个百分点。
付费客户数达到 863 家，本季度净增 96 家。
毛利率 68.5%，同比下降 0.8 个百分点。

## 二、分业务收入
| 业务线 | 收入（万元） | 同比 |
|---|---:|---:|
| 企业服务 | 5180 | +41.2% |
| 知识库订阅 | 4260 | +18.9% |
| 实施与培训 | 2180 | +9.5% |
| 其它 | 1080 | -3.2% |

## 三、风险提示
供应链成本上升 8.3%，预计下季度毛利率承压约 1.5 个百分点。
海外市场合规成本增加，需要在第四季度前完成数据合规审计。

## 四、下季度计划
1. 重点投入智能知识库产品的研发，目标是在十二月底前发布商用版本。
2. 计划新增 3 个行业解决方案：金融、医疗、制造业。
3. 团队规模扩充至 220 人，重点补充算法与实施岗位。
`
  },
  {
    name: '新员工入职指南.md',
    tags: '示例,HR',
    content: `# 新员工入职指南

## 一、入职第一天
1. 到前台领取工牌与办公设备。
2. 由 HR 引导完成劳动合同签署与信息登记。
3. 加入所在部门的企业微信群，认识导师与同事。

## 二、账号与权限
- 邮箱与办公账号由 IT 部门统一开通，通常当天完成。
- 内部知识库 KBPRO 账号由所在部门管理员邀请加入。
- 需要额外系统权限时，在工单系统提交申请，由直属主管审批。

## 三、试用期与转正
试用期一般为 3 个月，表现优异者可提前转正。
转正需提交试用期工作总结，并由主管进行转正评估。

## 四、常用资源
- 报销流程与标准见《财务报销制度》。
- 请假、调休通过 OA 系统提交，需提前一个工作日申请。
- 公司每月最后一周周五举办技术分享会。
`
  },
  {
    name: '常见问题FAQ.md',
    tags: '示例,FAQ',
    content: `# 常见问题 FAQ

**Q1：KBPRO 需要联网吗？**
不需要。系统仅使用 Node.js 内置模块，可完全离线运行。接入云端大模型时才需要外网。

**Q2：支持哪些大模型？**
支持 Ollama 本地模型、任意 OpenAI 兼容接口（如 DeepSeek、通义千问、Kimi、智谱），以及内置的本地抽取式引擎。

**Q3：上传的文件存在哪里？**
默认存放在项目根目录的 data/files 目录下，按知识库与月份分桶存储；私密文件会以 AES-256-GCM 加密落盘。

**Q4：如何备份数据？**
在「系统管理 → 备份」中创建 metadata（仅数据库）或 full（数据库 + 文件）备份，full 备份可选口令加密。

**Q5：忘记管理员密码怎么办？**
可删除 data 目录下的 kbpro.sqlite 重置（会清空数据），或在其他管理员账号的「系统管理」中重置。

**Q6：检索不到刚上传的文档？**
文档上传后需要后台解析完成才能被检索，可在文件库查看解析状态，或手动点击「重建索引」。
`
  },
  {
    name: '产品需求文档-PRD-智能问答.md',
    tags: '示例,产品,PRD',
    content: `# PRD：智能问答（RAG）v2.0

## 背景
用户希望在私有知识库上直接提问，答案必须可追溯、不编造。当前版本仅支持抽取式回答，重排与引用体验一般。

## 目标
- 问答首字延迟 < 2 秒（流式）。
- 引用来源可点击跳转到原文对应页码/章节。
- 支持“限定文件问答”：只在一个或若干文档范围内回答。

## 功能需求
1. 检索增强生成：BM25 + 向量 + RRF 融合，TopK 默认 8，单文件最多引用 4 个片段。
2. 流式输出：SSE 推送 token，前端逐步渲染。
3. 无依据兜底：知识库无相关内容时，若已接入大模型则以通用知识作答并声明；否则提示上传资料。
4. 答案反馈：支持点赞/点踩，用于后续评估。

## 验收标准
- 引用必须指向真实存在的文档与片段，不允许出现虚构来源。
- 回答中出现的数字必须能在引用片段中找到。
- 并发 20 路问答时 P95 延迟 < 6 秒。

## 非目标
- 本期不做多轮函数调用与联网搜索。
`
  },
  {
    name: '后端API接口文档.md',
    tags: '示例,技术,API',
    content: `# KBPRO 后端 API 接口文档

所有接口以 /api 为前缀，认证使用会话 Cookie（kbpro_session）。错误返回 { ok:false, error:"..." }。

## 认证
- POST /api/auth/login  登录，body: { email, password }
- POST /api/auth/logout 退出
- GET  /api/auth/me     当前用户与知识库列表

## 文件
- POST /api/files/upload 上传（multipart，字段 workspaceId/folderId/tags/file）
- GET  /api/files?workspaceId=&trash=  文件列表
- GET  /api/files/:id   文件详情
- GET  /api/files/:id/content?inline=1 原始内容（支持 Range）
- POST /api/files/:id/reindex 重新解析

## 检索与问答
- GET  /api/search?workspaceId=&q=  混合检索
- POST /api/ai/ask   RAG 问答，body: { question, workspaceId, fileIds?, stream? }
- GET  /api/ai/status 探测当前生效的 AI 提供商

## 鉴权约定
- 所有资源接口在服务端逐请求校验权限：知识库级 + 资源级（私有/共享）。
- 401 未登录，403 权限不足，404 资源不存在。

## 速率与限额
- 单文件上传上限默认 200 MB。
- 单次问答引用片段上限 8 条。
`
  },
  {
    name: '数据库设计说明.md',
    tags: '示例,技术,数据库',
    content: `# 数据库设计说明（SQLite）

KBPRO 使用单文件 SQLite（data/kbpro.sqlite），开启 WAL 模式。

## 核心表
- users：用户与 AI 配置（ai_provider / ai_model / ai_base_url / ai_key_enc）。
- workspaces：知识库，kind 为 personal 或 team，owner_id 关联用户。
- team_members：团队成员与角色（owner/admin/editor/commenter/viewer）。
- files / notes：文件与笔记，含 acl_level（inherit/private）、folder_id、tags(JSON)。
- file_text：解析结果（text/html/status/page_count/engine）。
- chunks / chunk_vectors：知识块与向量（dim/vec/model）。
- postings / term_df / doc_stats：BM25 倒排索引，持久化到库。
- shares：资源级共享（user/team/link + token）。
- access_logs：审计日志。

## 设计要点
- 检索：DB 持久化倒排索引，进程重启后立即可用，无需内存重建。
- 向量降级：默认 512 维哈希嵌入；接入远程 embedding 后 chunk_vectors.model 记录来源。
- 权限：服务器端逐请求校验，前端仅做体验层禁用。
`
  },
  {
    name: '运维部署手册.md',
    tags: '示例,技术,运维',
    content: `# 运维部署手册

## 单机部署
1. 安装 Node.js 22.5+。
2. 拉取代码后直接运行：KBPRO_HOST=0.0.0.0 KBPRO_DATA=/var/lib/kbpro node server/index.js
3. 使用 systemd / pm2 / nssm 托管进程，配置开机自启。

## Nginx 反向代理
- 开启 HTTPS，client_max_body_size 与上传上限保持一致（如 512m）。
- SSE 长连接：proxy_buffering off; proxy_read_timeout 3600s;

## 备份策略
- 日常：系统管理 → metadata 备份（秒级）。
- 每周：full 全量备份 + 口令加密，异地保存。
- 交付/迁移：知识库导出为 ZIP。

## 监控与日志
- 访问日志默认打印到 stdout，KBPRO_QUIET=1 可关闭。
- 审计日志记录登录、上传、下载、检索、共享、AI 调用等。
- 建议对磁盘占用、解析失败率、AI 调用失败率设置告警。

## 故障排查
- 端口被占用：设置 KBPRO_PORT 换端口。
- 解析失败：查看文件解析状态与错误信息，或重建索引。
- 大模型不生效：检查 Base URL、模型名、Key，并查看 [kbpro:ai] 日志。
`
  },
  {
    name: '市场分析报告.md',
    tags: '示例,市场',
    content: `# 企业知识管理市场分析报告（2026）

## 市场规模
据估算，2026 年国内企业知识管理与文档协作市场规模约 180 亿元，年复合增长率 21%。
其中 AI 增强的知识库细分市场增速最快，达到 45%。

## 竞争格局
- 国际厂商：以协作套件为主，AI 能力依赖第三方模型，本地化部署成本高。
- 国内大厂：生态完整但偏重公有云，私有化交付周期长。
- 中小厂商：灵活但多为单一功能，缺乏完整 RAG 链路。

## 机会点
1. 私有化 + 零依赖部署，满足金融、政务、医疗的数据不出内网诉求。
2. 多格式解析与中文检索体验，是国产替代的关键差异点。
3. 团队协作与权限治理，是从个人工具走向企业采购的必经环节。

## 威胁
- 大模型厂商向下整合应用层，可能压缩中间件空间。
- 价格战与免费开源替代带来的毛利压力。

## 结论
聚焦“私有化智能知识库”，以零依赖和中文体验建立差异化，优先突破 50–500 人规模的知识密集型企业。
`
  },
  {
    name: '项目周报-第32周.md',
    tags: '示例,项目',
    content: `# 项目周报 · 第 32 周（08/04 – 08/10）

## 本周进展
- 完成混合检索 RRF 融合调优，中文召回率提升 12%。
- 修复上传接口并发重入缺陷，上传成功率 100%。
- 智能问答接入 DeepSeek，支持思考型模型与流式输出。

## 下周计划
- 上线文档对比与知识图谱聚类。
- 完善备份包口令加密与恢复流程。
- 补充端到端测试用例至 230 条以上。

## 风险与阻塞
- 无头浏览器渲染测试受沙箱限制无法执行，需在 CI 环境补跑。
- 语义嵌入仍依赖外部模型，离线场景召回有待提升。

## 指标
- 本周提交 47 次，修复缺陷 10 个，测试断言 986 条全部通过。
`
  },
  {
    name: '技术选型对比.md',
    tags: '示例,技术',
    content: `# 技术选型对比

## 运行环境
| 方案 | 依赖 | 离线能力 | 结论 |
|---|---|---|---|
| Node.js 内置模块 | 零依赖 | 完全离线 | 采用 |
| Python + 向量库 | 重依赖 | 需额外安装 | 未采用 |

## 存储
| 方案 | 说明 | 结论 |
|---|---|---|
| SQLite（WAL） | 单文件、免运维、可支撑数万文档 | 采用 |
| PostgreSQL + pgvector | 水平扩展强、运维成本高 | 大集群可选 |

## 检索
- BM25：中文用二元组分词，召回稳、零依赖。
- 向量：默认为哈希嵌入（词面近似），接入真实 embedding 后可用于语义召回。
- 融合：RRF 将两路结果合并，兼顾问准与召回。

## 大模型接入
- 统一走 OpenAI 兼容协议，支持 DeepSeek / 通义 / Kimi / 智谱 / vLLM / one-api。
- 未配置时回退内置抽取式引擎，保证能力永远可用。
`
  }
];

async function main() {
  console.log(`KBPRO 示例数据导入 · 服务地址 ${BASE}`);

  let login;
  try {
    login = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD })
    });
  } catch {
    console.error(`✗ 无法连接服务 ${BASE}，请先运行： node server/index.js`);
    process.exit(1);
  }
  if (!login.ok) {
    console.error(`✗ 登录失败（${login.status}）。请确认账号密码（可用 KBPRO_SEED_EMAIL / KBPRO_SEED_PASSWORD 覆盖）。`);
    process.exit(1);
  }
  const cookie = (login.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  console.log(`✓ 登录成功：${EMAIL}`);

  const wsData = await (await fetch(`${BASE}/api/workspaces`, { headers: { cookie } })).json();
  const list = wsData.workspaces || [];
  const target = process.env.KBPRO_SEED_WORKSPACE
    ? list.find((w) => w.id === process.env.KBPRO_SEED_WORKSPACE)
    : (list.find((w) => w.kind === 'personal') || list[0]);
  if (!target) {
    console.error('✗ 没有可导入的知识库，请先在应用中创建一个知识库。');
    process.exit(1);
  }
  console.log(`✓ 目标知识库：${target.name}（${target.id}）`);

  // 幂等：收集已存在的文件名，跳过重复
  const existing = new Set();
  try {
    const fl = await (await fetch(`${BASE}/api/files?workspaceId=${target.id}&limit=200`, { headers: { cookie } })).json();
    for (const f of fl.files || []) existing.add(f.name);
  } catch { /* 忽略 */ }

  let ok = 0;
  let skipped = 0;
  for (const doc of DOCS) {
    if (existing.has(doc.name)) { skipped++; continue; }
    const fd = new FormData();
    fd.append('workspaceId', target.id);
    fd.append('tags', doc.tags || '');
    fd.append('file', new Blob([doc.content], { type: 'text/markdown' }), doc.name);
    const up = await fetch(`${BASE}/api/files/upload`, { method: 'POST', headers: { cookie }, body: fd });
    const data = await up.json().catch(() => ({}));
    if (up.ok && data.ok) {
      ok++;
      console.log(`  ✓ 已导入 ${doc.name}`);
    } else {
      console.log(`  ✗ ${doc.name} 导入失败：${data.error || up.status}`);
    }
  }

  console.log(`\n完成：新增 ${ok} 篇，跳过已存在 ${skipped} 篇，共 ${DOCS.length} 篇。`);
  console.log('等待后台解析完成后，即可在「全局检索」和「智能问答」中体验。');
}

main().catch((err) => {
  console.error('导入异常：', err?.message || err);
  process.exit(1);
});
