# KBPRO · 个人 & 团队轻量化智能知识库平台

> 把散落的文档，变成可对话的知识。

KBPRO 是一套**零外部依赖**的智能知识库系统：文档存储 → 智能解析 → 问答检索 → 知识沉淀。
后端仅使用 Node.js 内置模块（`node:sqlite` / `node:zlib` / `node:crypto` / `node:http`），
前端为原生 ES Module，**无需 npm install、无需构建、无需 CDN**，`node server/index.js` 即可运行。

```
┌──────────────────────────────────────────────────────────────┐
│  文件库          笔记中心         智能问答        团队协作     │
│  PDF/Word/…      富文本+版本      RAG+引用来源    权限+共享    │
└──────────────────────────────────────────────────────────────┘
       文档解析引擎            混合检索引擎          AI 抽象层
   PDF·DOCX·XLSX·PPTX·MD   BM25 + 向量 + RRF融合   Ollama/OpenAI/本地
```

---

## 目录

- [核心能力](#核心能力)
- [快速开始](#快速开始)
- [功能地图](#功能地图)
- [架构说明](#架构说明)
- [配置项](#配置项)
- [接入大模型](#接入大模型)
- [测试与验证](#测试与验证)
- [数据与安全](#数据与安全)
- [商用部署建议](#商用部署建议)
- [能力边界（诚实说明）](#能力边界诚实说明)

---

## 核心能力

| 能力 | 说明 |
|---|---|
| **多格式解析** | PDF（含 Type0/ToUnicode 中文、加密文档、损坏 xref 恢复）、DOCX、XLSX、PPTX、Markdown、TXT、CSV、JSON、HTML、代码文件；自动识别 UTF-8 / GBK / UTF-16 编码 |
| **在线预览** | PDF 内联渲染、Word/Excel/PPT 转结构化 HTML、Markdown 渲染、图片/音视频直出，无需下载 |
| **混合检索** | BM25（中文二元组分词 + 持久化倒排表）＋ 向量召回 ＋ RRF 融合，标题/标签/收藏/时效加权，结果关键词高亮 |
| **RAG 问答** | 文档分块 → 向量化 → 混合召回 → 重排 → 生成；答案**逐句标注引用来源**（文件 + 页码 + 章节），可点击跳转 |
| **智能解析** | 摘要、结构化大纲、关键词与术语提取、多文档对比、知识拓展 |
| **知识关联** | 基于内容向量的相关文档推荐与知识图谱（主题聚类） |
| **笔记系统** | 富文本编辑器（图片/代码块/表格/链接）、自动保存、历史版本留存与一键恢复 |
| **团队协作** | 个人与团队知识库双体系隔离、5 级角色权限、资源级共享、分享链接、评论、编辑协同与实时动态 |
| **数据安全** | scrypt 口令哈希、AES-256-GCM 私密文件加密、访问审计日志、加密备份包、知识库导出 |

---

## 快速开始

### 环境要求

- **Node.js ≥ 22.5**（需要内置 `node:sqlite`；开发环境使用 v24.15 验证）
- 无需数据库、无需 Redis、无需 npm 依赖

### 启动

```bash
cd kbpro
node server/index.js
```

打开终端输出的地址（默认 <http://127.0.0.1:8787>）。

**默认管理员账号**（首次启动自动创建）：

```
邮箱：admin@kbpro.local
密码：admin12345
```

> ⚠️ 首次登录后请立即在「个人中心 → 安全」中修改密码。

### 指定端口 / 数据目录

```powershell
# PowerShell
$env:KBPRO_PORT=8899
$env:KBPRO_DATA="D:\kbpro-data"
node server/index.js
```

```bash
# bash
KBPRO_PORT=8899 KBPRO_DATA=/var/lib/kbpro node server/index.js
```

### 局域网访问（团队场景）

```bash
KBPRO_HOST=0.0.0.0 KBPRO_PORT=8787 node server/index.js
```

启动时会打印局域网地址，团队成员通过该地址访问即可。

---

## 功能地图

### 基础功能

| 需求 | 实现 |
|---|---|
| 视觉规范 #1F2937 极简黑灰 | `web/css/app.css` 设计令牌系统，全部颜色由 CSS 变量驱动 |
| 极简留白、卡片轻量化 | 三级低对比阴影、1px 描边卡片、大量负空间 |
| 首页 / 文件库 / 笔记中心 / 分类文件夹 / 个人中心 | 5 个一级页面 + 团队 / 检索 / 问答 / 回收站 / 管理 |
| 新建文件夹、分层分类管理 | 无限层级目录树、拖拽移动、防循环校验、级联删除策略选择 |
| 手动新建笔记、在线编辑、保存 | contenteditable 富文本编辑器，工具栏 + 快捷键 |
| 文件上传、预览、列表展示 | 拖拽/选择上传、进度条、列表与网格双视图 |
| 上传进度条与成败提示 | 全局上传面板，逐文件进度、失败原因与重试 |
| 笔记自动保存与状态提示 | 900ms 防抖自动保存，保存状态点（编辑中/已保存/失败） |
| 列表 hover / 选中高亮 | 行级 hover 高亮、多选状态、全选与批量操作条 |

### 进阶功能

| 需求 | 实现 |
|---|---|
| PDF/Word/TXT 在线预览 | PDF 内联 iframe；DOCX/XLSX/PPTX 转安全 HTML；TXT/MD/CSV/代码直出 |
| 文件重命名 / 移动 / 批量管理 / 收藏置顶 | 单条与批量接口，支持标签、私密、导出 |
| 关键词全局检索 | BM25 倒排索引，支持标题、正文、标签、扩展名、目录、收藏筛选 |
| 检索结果高亮 | 服务端生成含 `<mark>` 的命中片段，标题二次高亮 |
| 内容模糊检索 | BM25 无结果时自动回退子串匹配；亦可显式选择「模糊匹配」模式 |
| 标签检索 | 标签表 + 关联表，支持多标签过滤与标签云 |
| 富文本笔记 / 图片 / 代码块 / 表格 | 编辑器工具栏全部支持，图片走内嵌资源接口 |
| 笔记历史版本留存 | 按时间与改动量自动留存快照（保留最近 30 个），可预览与恢复 |
| 页面过渡与展开收起动画 | `pageIn` / `modalIn` / `drawerIn` / 树形展开折叠动画 |
| 多端适配 | 3 档响应式断点，移动端抽屉式导航与列表 |

### 商用功能

| 需求 | 实现 |
|---|---|
| 海量文档智能解析 | 并发限流后台队列，上传即返回，解析进度实时可见 |
| 内容结构化梳理 / 重点提炼 / 摘要生成 | 生成式（接入大模型）与抽取式（本地）双通道 |
| 基于私有文档智能问答 | 完整 RAG 链路，流式输出，引用可追溯 |
| 知识关联 / 问题解答 / 内容拓展 | 相关文档、知识图谱聚类、延伸问题生成 |
| 多人协作 / 文档共享 / 权限设置 | 团队知识库、5 级角色、资源级共享、分享链接 |
| 协作编辑 | 编辑锁 + 实时活动广播 + 多人查看提示 |
| 个人与团队知识库双体系隔离 | 独立工作区模型，权限完全独立 |
| 云端存储 / 数据备份 / 私密加密 | 可配置数据目录（对接对象存储网关）、全量/元数据/单库备份 |
| 访问记录 | 全量审计日志：登录、上传、下载、检索、共享、AI 调用 |
| 文档导出 / 批量备份 | 单文件导出 MD/TXT/HTML；知识库打包为 ZIP；备份包可口令加密 |

---

## 架构说明

```
kbpro/
├── server/
│   ├── index.js              HTTP 服务器 / 路由分发 / 安全头 / 优雅关闭
│   ├── config.js             配置（默认值 ← data/config.json ← 环境变量）
│   ├── db.js                 node:sqlite 连接、Schema、迁移、BM25 倒排维护、审计
│   ├── auth.js               认证、会话、知识库隔离、权限模型、共享
│   ├── routes/
│   │   ├── core.js           认证 / 用户 / 知识库 / 团队 / 文件夹 / 标签
│   │   ├── content.js        文件 / 笔记 / 检索 / 共享 / 评论 / 协作 / 资源
│   │   └── ai.js             RAG 问答 / 文档解析 / 知识图谱 / 备份 / 审计
│   └── lib/
│       ├── pdf.js            PDF 解析器（自研，零依赖）
│       ├── officedoc.js      DOCX/XLSX/PPTX → HTML
│       ├── zip.js            ZIP 读写
│       ├── archive.js        ZIP 归档（导出/备份）
│       ├── extract.js        文档抽取统一入口 + 编码探测
│       ├── markdown.js       Markdown → HTML
│       ├── search.js         BM25 / 向量 / RRF 融合检索
│       ├── rag.js            分块、索引、召回、提示词、问答
│       ├── vector.js         哈希嵌入、向量工具、k-means
│       ├── ai.js             AI 提供商抽象（Ollama / OpenAI 兼容 / 本地）
│       ├── localai.js        本地抽取式引擎（TextRank 摘要、抽取式问答）
│       ├── backup.js         备份 / 恢复 / 导出
│       ├── storage.js        文件存储（透明加解密）
│       ├── multipart.js      流式上传解析器
│       ├── tags.js           标签与文件夹服务
│       ├── pipeline.js       文档处理流水线（并发队列）
│       ├── bus.js            进程内事件总线（SSE）
│       ├── crypto.js         scrypt / AES-256-GCM
│       ├── http.js           路由、请求/响应、SSE、静态资源
│       └── text.js           分词、高亮、净化、片段
├── web/
│   ├── index.html            应用壳
│   ├── css/app.css           设计系统（470+ 类）
│   └── js/
│       ├── app.js            启动、认证、路由、命令面板、实时事件
│       ├── api.js            API 客户端
│       ├── ui.js             组件库
│       ├── store.js          状态容器
│       ├── icons.js          图标库
│       ├── format.js         格式化
│       ├── md.js             Markdown 渲染
│       ├── uploader.js       上传管理器
│       └── pages/            11 个页面模块
├── tests/                    测试套件
└── data/                     运行时数据（自动创建）
    ├── kbpro.sqlite          数据库
    ├── files/                文件存储
    ├── backups/              备份包
    └── .master.key           主密钥（0600）
```

### 关键设计

**检索：DB 持久化倒排索引。** 分词结果写入 `postings` / `term_df` / `doc_stats` 三张表，
BM25 打分直接用 SQL 取倒排链，无需启动时重建内存索引，进程重启后立即可用。

**中文分词。** 连续 CJK 片段切成二元组（bigram），拉丁文按词切分，均带停用词过滤。
二元组在中文检索上的召回显著优于单字与整句匹配，且实现零依赖。

**向量降级策略。** 默认使用 512 维哈希嵌入（词 + 字符三元组 + CJK 二元组混合散列，L2 归一化），
离线可用、确定性、零依赖。由于哈希碰撞会产生假阳性，本地向量仅作为**召回增强**，
要求候选片段与查询词存在字面交集；接入真实 embedding 模型后该约束自动解除
（`chunk_vectors.model` 字段记录来源模型）。

**AI 三级降级。** `ollama` → `openai 兼容` → `local 抽取式引擎`，任何一级不可用都自动回退，
保证知识库的摘要、问答、关联能力**永远可用**，不会因为没配密钥而变成空壳。

---

## 配置项

配置优先级（后者覆盖前者）：**内置默认值 → 项目根目录 `config.json` → 运行时 `data/config.json` → 环境变量**。

### 项目根目录 `config.json`（推荐，可直接编辑）

仓库根目录自带 `config.json`，把常用配置与**大模型接入**集中在这里，编辑后重启服务生效：

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "ai": {
    "provider": "openai",
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "sk-xxxxxxxx",
    "chatModel": "deepseek-chat",
    "embedModel": "text-embedding-3-small",
    "ollamaUrl": "http://127.0.0.1:11434"
  }
}
```

- `provider`：`auto`（自动探测）｜`ollama`（本地模型）｜`openai`（任意 OpenAI 兼容接口）｜`local`（内置抽取式引擎）。
- 留空 `apiKey` 时不会启用远程模型，自动回退到内置本地引擎，功能仍然可用。
- 也可在「个人中心 → AI 引擎」中按用户单独配置（密钥以 AES-256-GCM 加密存入数据库，优先级高于全局配置）。

> ⚠️ `config.json` 会被 Git 跟踪；**请勿把真实 API Key 提交到公开仓库**。生产环境建议改用环境变量（见下表）或在「系统管理 → 实例设置」中配置运行时 `data/config.json`。

### 运行时配置 / 环境变量

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `KBPRO_HOST` | `127.0.0.1` | 监听地址，`0.0.0.0` 对外提供服务 |
| `KBPRO_PORT` | `8787` | 监听端口 |
| `KBPRO_DATA` | `./data` | 数据目录 |
| `KBPRO_QUIET` | – | `1` 关闭访问日志 |
| `KBPRO_INDEX_CONCURRENCY` | `2` | 文档解析并发数 |
| `KBPRO_AI_BASE_URL` | – | OpenAI 兼容接口地址 |
| `KBPRO_AI_API_KEY` | – | 接口密钥 |
| `KBPRO_AI_MODEL` | – | 对话模型名 |
| `KBPRO_AI_EMBED_MODEL` | – | 嵌入模型名 |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama 地址（会自动归一化，见下） |
| `KBPRO_OLLAMA_URL` | – | Ollama 地址（优先于 `OLLAMA_HOST`） |
| `KBPRO_TEST_LOGIN` | – | **仅测试用**，启用后开放免密测试登录接口 |

> `OLLAMA_HOST` 在 Ollama 自身语义里是**服务端监听地址**（常见为 `0.0.0.0`），并不是
> 客户端连接 URL。KBPRO 会自动归一化：`0.0.0.0` / `::` / `localhost` → `127.0.0.1`，
> 缺协议补 `http://`，`http` 缺端口补 `11434`，`https` 不强加端口。

`data/config.json` 可配置项（含上传上限、会话天数、分块大小、RAG 召回数量、AI 全局默认值等）
可在「系统管理 → 实例设置」中图形化调整。

### AI Base URL 安全策略（SSRF 防护）

AI Base URL 可由用户自定义，而请求是由**服务端**发出的，因此 KBPRO 内置了 SSRF 防护：

- **始终拒绝**：云厂商元数据地址（`169.254.169.254`、`fd00:ec2::254`、`100.100.100.200`、
  `metadata.google.internal` 等）、链路本地 / 组播 / 保留网段、非 `http(s)` 协议
- **域名解析校验**：同时解析域名并检查解析结果，防止「域名指向内网」的绕过
- **默认放行回环与私有网段**：因为「指向本机 / 内网的 vLLM、one-api 等自建推理服务」是常见且合法的用法
- 加固部署可关闭默认放行并配置主机白名单：

```json
{
  "ai": {
    "allowLoopbackBaseUrl": false,
    "allowPrivateBaseUrl": false,
    "allowedBaseUrlHosts": ["api.deepseek.com", "llm.corp.internal"]
  }
}
```

---

## 接入大模型

KBPRO **开箱即用**：不配置任何模型时，使用内置本地抽取式引擎完成摘要、问答与关联。
接入大模型可获得生成式摘要与更强的问答能力。

### 方式一：Ollama（本地模型，数据不出内网）

```bash
ollama serve
ollama pull qwen2.5:7b          # 对话模型
ollama pull nomic-embed-text    # 可选：嵌入模型
```

然后在「个人中心 → AI 引擎」中选择 **Ollama**，模型名填 `qwen2.5:7b`，保存后点击「测试连接」。

### 方式二：任意 OpenAI 兼容接口

支持 DeepSeek、通义千问、Kimi、vLLM、one-api、OpenAI 等。

在「个人中心 → AI 引擎」中选择 **OpenAI 兼容**：

| 字段 | 示例 |
|---|---|
| Base URL | `https://api.deepseek.com/v1` |
| API Key | `sk-...` |
| 模型名 | `deepseek-chat` |

> API Key 使用 AES-256-GCM 加密后存入数据库，不会明文落盘。

### 方式三：内置本地引擎（默认）

无需任何配置。摘要与问答由 TextRank 句子图排序 + 词频加权的抽取式算法产出，
结果**完全来自你的原文**，不会编造；代价是不做改写润色，措辞即原文措辞。

### 无依据时的行为

当知识库中检索不到与问题相关的资料时：

- **已接入大模型**（Ollama / OpenAI 兼容）且 `ai.answerWithoutContext` 为 `true`（默认）：仍会调用大模型，以通用知识作答，并在回答开头声明「以下为通用回答，未引用知识库资料」。
- 未接入大模型（内置本地引擎），或把该项设为 `false`：返回固定的「暂无依据」提示，不调用模型。

在 `config.json` 的 `ai` 段中配置：

```json
{ "ai": { "answerWithoutContext": false } }
```

### 思考型模型（DeepSeek deepseek-flash / deepseek-reasoner）

KBPRO 会按官方协议自动携带思考参数。当 Base URL 含 `deepseek` 且模型名为
`deepseek-flash` / `deepseek-reasoner` 时，请求体自动附加：

```json
{ "thinking": { "type": "enabled" }, "reasoning_effort": "high" }
```

也可在 `config.json` 的 `ai` 段显式控制（对其它兼容接口同样适用）：

```json
{ "ai": { "thinking": true, "reasoningEffort": "high" } }
```

- `thinking`：`true` 始终开启、`false` 从不、`null`/缺省为自动（仅 DeepSeek 思考型模型）。
- `reasoningEffort`：`low` | `medium` | `high`。

### 排错：为什么「没看到请求大模型」

上游请求由**服务端进程**发出，浏览器 DevTools 只能看到对 `127.0.0.1:8787` 的请求，看不到 `api.deepseek.com`。要看真实上游调用，观察**服务端终端日志**：

```
[kbpro:ai] POST https://api.deepseek.com/v1/chat/completions model=deepseek-chat stream=false key=set
[kbpro:ai] ← 200 https://api.deepseek.com/v1/chat/completions
```

- 用 `KBPRO_AI_DEBUG=0` 可关闭（`KBPRO_QUIET=1` 也会静默）。
- 常见错误：模型名写错（DeepSeek 只有 `deepseek-chat` / `deepseek-reasoner`）→ 日志会显示 `← 400 ...`。

---

## 示例数据

想快速体验检索与问答，可在服务启动后另开终端导入一批示例文档（Markdown）：

```bash
node server/index.js          # 终端 1：启动服务
node scripts/seed-demo.mjs    # 终端 2：导入示例文档
# 或
npm run seed
```

会导入到默认个人知识库；可用环境变量 `KBPRO_SEED_WORKSPACE` 指定目标知识库，
`KBPRO_SEED_EMAIL` / `KBPRO_SEED_PASSWORD` 指定登录账号。

---

## 测试与验证

```bash
node tests/run-all.mjs          # 前端契约 + 后端 API + 多格式解析
node tests/run-all.mjs --full   # 追加 PDF / Office 解析器单测
```

| 套件 | 命令 | 覆盖 |
|---|---|---|
| 前端契约审计 | `node tests/test-frontend.mjs` | 语法、页面契约、289 处 import、345 处图标、181 处 API 调用、路由、CSS |
| 后端 API 端到端 | `node tests/test-api.mjs` | 认证、隔离、权限、文件夹、上传、检索、笔记版本、RAG、存储配额、备份、审计 |
| 多格式解析 | `node tests/test-formats.mjs` | 22 种 PDF 场景 + DOCX/XLSX/PPTX + 文本族 + 分块 + 批量 |
| 大模型容错与安全 | `node tests/test-ai-fallback.mjs` | 流中断、SSE 错误负载、thinking 参数重试、通用回答标记、SSRF 防护 |
| Office 解析单测 | `node tests/test-officedoc.mjs` | zip 读写、OOXML 转换、XSS 转义、畸形输入、位翻转模糊 |
| PDF 解析单测 | `node tests/test-pdf.mjs` | 6 种过滤器、ToUnicode、加密、损坏恢复、敌对输入 |
| 浏览器渲染 | `node tests/test-browser.mjs` | 无头 Chromium 渲染全部路由，校验无崩溃、无控制台异常 |

> `test-ai-fallback.mjs` 使用**内置的假 OpenAI 兼容上游**，无需任何真实 API Key 即可
> 稳定复现上游各类异常：流到一半断开、SSE 中回吐 error 负载、拒绝 `thinking` 参数、
> 无视 `stream` 参数等。

> 浏览器套件需要 Chromium 内核（Chrome / Edge）。若运行环境禁止浏览器所需的
> 命名管道 IPC，该套件会明确报告 **SKIP** 而不是假装通过。

详见 [docs/验证报告.md](docs/验证报告.md)。

---

## 数据与安全

| 项目 | 实现 |
|---|---|
| 口令存储 | scrypt（N=16384, r=8, p=1, 64 字节），每用户独立 16 字节盐 |
| 会话 | 32 字节随机 token，HttpOnly + SameSite=Lax Cookie，可配置有效期 |
| 私密文件 | AES-256-GCM 落盘加密（`KBP1` 魔数 + 12 字节 IV + 16 字节认证标签） |
| 主密钥 | `data/.master.key`，首次启动生成，权限 0600 |
| AI 密钥 | 同样使用 AES-256-GCM 加密存储 |
| 备份包 | 可选口令加密：scrypt 派生密钥 + AES-256-GCM，**仅凭口令即可恢复** |
| 传输安全 | 会话 Cookie 为 HttpOnly + SameSite=Lax；生产环境请置于 HTTPS 反向代理之后 |
| 内容净化 | 笔记 HTML 白名单净化（剔除 script / 事件属性 / `javascript:`）；文档转换全程转义 |
| 审计 | 登录、上传、下载、检索、共享、备份、AI 调用等全量记录，含 IP 与 UA |
| 权限 | 服务器端逐请求校验，前端仅做体验层禁用 |

**重要说明（不夸大）**：KBPRO 的加密是**服务端对称加密**，用于保护静态数据与备份包，
**不是端到端零知识加密**——服务进程持有主密钥，因此管理员在技术上具备读取能力。
如需零知识方案，请在上传前于客户端加密敏感文件。

---

## 商用部署建议

### 单机部署

```bash
# 使用 systemd / pm2 / nssm 托管
KBPRO_HOST=0.0.0.0 KBPRO_DATA=/var/lib/kbpro node server/index.js
```

前置 Nginx 反向代理并启用 HTTPS：

```nginx
server {
    listen 443 ssl http2;
    server_name kb.example.com;
    ssl_certificate     /etc/ssl/kb.crt;
    ssl_certificate_key /etc/ssl/kb.key;

    client_max_body_size 512m;          # 与上传上限保持一致

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        # SSE 长连接
        proxy_buffering off;
        proxy_read_timeout 3600s;
    }
}
```

### 备份策略

- **日常**：系统管理 → 创建 `metadata` 备份（秒级，仅数据库）
- **每周**：`full` 全量备份 + 口令加密，异地保存
- **交付/迁移**：知识库导出（ZIP，含 Markdown 与原始文件，可读性强）

```bash
# 定时全量备份（示例）
0 3 * * * curl -s -X POST http://127.0.0.1:8787/api/backups \
  -H "Content-Type: application/json" \
  -H "Cookie: kbpro_session=<管理员会话>" \
  -d '{"kind":"full","encrypt":true,"password":"<强口令>"}'
```

### 容量参考

| 规模 | 建议 |
|---|---|
| 个人（< 5 千文档） | 单机默认配置即可 |
| 团队（1–50 人，< 5 万文档） | 4 核 8G，SSD；解析并发调至 4 |
| 企业（> 50 人） | 建议将 `KBPRO_DATA` 指向高性能存储，并把重解析任务放到独立实例；接入外部向量库时可在 `lib/rag.js` 替换召回层 |

SQLite 单库可稳定支撑数万文档与数十万知识块；如需水平扩展，检索层与存储层均已按接口隔离，便于替换。

---

## 能力边界（诚实说明）

以下为**已知限制**，不做夸大宣传：

**PDF 解析**
- 未内嵌 `/ToUnicode` 且使用自定义编码的子集字体，中文可能乱码（无嵌入式 cmap 反查）
- 非标准安全处理器（如公钥加密）可识别但无法解密
- 扫描件、纯图片 PDF 无文本层，**不做 OCR**（会明确提示，而非静默返回空）
- Type3 字体、竖排（Identity-V）阅读顺序、XFA 表单、标签化 PDF 的逻辑顺序未处理

**检索与 AI**
- 内置哈希嵌入是**词面近似**，不是真正的语义嵌入；同义改写查询的召回依赖大模型 embedding
- 未接入大模型时，问答为**抽取式**（原文句子组织），不做改写润色
- 知识图谱基于文档级向量聚类，文档数少于 3 时无法生成聚类

**协作**
- 协同编辑为「编辑锁 + 实时广播 + 后写覆盖」，**不是 OT/CRDT**；多人同时编辑同一段可能互相覆盖（有锁提示与应用内提示）
- 团队所有者不支持在线转让，团队删除未开放

**运维**
- 全量备份恢复需要重启服务进程
- 会话为服务端存储，无分布式会话；多实例部署需共享数据库

---

## 许可

MIT
