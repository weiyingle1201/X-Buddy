# X-Buddy · 投资研究 Agent 工作台

> 面向投资研究者的个人 Agent 工作台：给出一个研究目标，系统会**规划任务 → 调用金融工具 → 把每个数字记入证据账本 → 在需要时请你确认 → 输出区分「事实 / 推断 / 不确定」的可验证研究报告**，并且能停止、恢复、回滚、压缩上下文、记住你的偏好。

- **在线体验**：<https://claude.ai/artifact/AL9q3T8mfDPX94P4cDv5vK>（无需任何 Key，默认演示模式；也可在「设置」中填入扶摇 API Key 切换为实时数据）
- **源代码**：<https://github.com/weiyingle1201/X-Buddy>
- **配套文档**：[AI 使用与验证记录](docs/AI_USAGE.md) · [测试说明](docs/TESTING.md) 

---

## 1. 产品选择：为什么是“工作台”，而不是“聊天机器人”

投资研究的痛点不是“得到一段流畅的话”，而是：**数字从哪来、口径是什么、什么时候的、缺了什么、哪里矛盾、能不能复查**。所以 X-Buddy 的设计取舍是：

| 取舍 | 做法 |
|---|---|
| 可验证 > 流畅 | 报告里每个数字都是可点击的证据芯片（`E-012`），点开能看到接口路径、原始字段、参数、单位、口径、数据时点、原始记录；计算值显示公式与来源证据 |
| 显式不确定 > 静默补全 | 数据缺失 / 过期 / 冲突 / 调用失败都会进入「数据质量」区，相关结论自动降级为「不确定」，绝不静默输出“正常”结论 |
| 可控执行 > 自由发挥 | LLM（可选）只负责“理解意图/实体”和“写摘要”；任务展开、取数、计算全部由规则化 Harness 完成；LLM 输出必须通过 schema 校验、**证据数值校验**与合规审查，否则自动回退 |
| 人在回路 | 读取持仓（敏感）、写入长期记忆、超预算执行都会弹出审批卡片；拒绝后流程依然给出说明性结果 |
| 合规内建 | 不输出涨跌预测、收益承诺、买卖建议：输入侧改写、输出侧审查、结论分级三道关 |

**目标用户**：个人投资研究者 / 投研助理。**核心任务**：围绕一个研究目标（个股、同业对比、市场情绪、持仓体检、板块观察）快速得到一份“带出处、能复查”的研究底稿。

## 2. 研究流程如何映射到 Agent 概念

| 投资研究概念 | 产品中的对象 | 说明 |
|---|---|---|
| 研究课题 | **线程 Thread** | 左侧列表；同一线程内追问可省略标的（“再和五粮液比较一下”自动沿用线程实体），并复用缓存与上一轮摘要 |
| 一次研究请求 | **运行 Run** | 有完整状态机：planning → running ⇄ awaiting_approval → completed / stopped / failed / interrupted |
| 研究步骤 | **任务 Task（计划卡片）** | 两阶段规划：先解析实体/持仓/板块，再展开取数任务；显示能力、工具、数据源、耗时、重试、缓存、降级、错误 |
| 底稿与出处 | **证据 Evidence（右侧证据账本）** | 来源、端点、参数、字段、值、单位、口径、数据时点、获取时间、状态（正常/演示/计算/缺失/过期/冲突/失败）、公式与上游证据 |
| 研究报告 | **产物 Artifact** | 版本化；结论分级 + 动态图表 + 数据质量 + 免责声明；可导出 Markdown（含证据附录）与证据 JSON |
| 图表与表格 | **动态 UI 块** | Agent 按研究类型输出 `kpis / line / bars / table / claims / quality / notice` 块，由前端渲染器统一渲染 |
| 研究习惯 | **长期记忆** | 画像/偏好自动注入上下文；持仓为敏感项需授权读取；研究笔记写入需确认；30 天以上的笔记标注“可能过期” |

## 3. Agent Harness 运行机制

```
用户目标
  │
  ├─ 输入合规审查（预测/荐股/收益承诺 → 改写；内幕/操纵 → 拒绝）
  ├─ 记忆检索（画像/偏好/同标的研究笔记 → 上下文 pinned）
  ├─ 规划：LLM 意图/实体解析（可选，schema 校验）→ 失败回退规则规划
  ├─ 预算预估（超阈值 → 审批卡片）
  ▼
调度循环（runtime.ts）
  for 每轮：
    停止规则检查（用户停止 / 调用次数 / 步数 / 时长 / 成本 / Token / 连续失败 / 鉴权熔断）
    依赖失败级联跳过；runAlways 任务（计算/报告）总会执行
    权限检查：sensitive_read / write → 审批卡片（暂停等待）
    并发执行就绪任务（默认 3）：
      参数校验 → 缓存 → 超时 → 可重试错误指数退避 → 降级链（fallbackTool）
      → 证据入账（E-xxx）→ 上下文观测（超限压缩）→ 计划展开（expand）→ 写检查点
  ▼
报告：结论分级（事实/推断/不确定）→ 输出合规审查 → LLM 摘要（数值校验，不过则模板）→ 产物
```

| 题目要求 | 实现 | 代码 |
|---|---|---|
| 能力/工具注册 | `ToolRegistry`：每个工具声明能力分组、来源、端点、权限级别、参数校验、超时、重试次数、缓存 TTL、预估调用数、降级工具；LLM 只能从注册目录中选择 | `src/core/registry.ts`、`src/core/tools.ts` |
| 计划执行 | 意图分类 + 实体抽取 → 初始计划 → 根据中间结果**两阶段展开**（板块观察会展开两次）；依赖调度、并发、级联跳过 | `src/core/planner.ts`、`src/core/runtime.ts` |
| 上下文压缩 | token 预算（默认 900，便于观察）；系统约束/目标/画像 pinned；早期观测合并为摘要并**保留证据 ID**，原始数据仍在账本中，压缩不丢证据 | `src/core/context.ts` |
| 记忆 | 跨线程长期记忆（画像/偏好/自选/持仓/研究笔记），敏感分级、按标的召回、过期标注、可删除 | `src/core/memory.ts` |
| 检查点与恢复 | 每个任务完成/审批/停止都写检查点（保留 15 个）；页面刷新/崩溃后标记 `interrupted` 并可续跑；可回滚到任一检查点；已完成任务不重复执行 | `runtime.ts: checkpoint / recoverInterrupted / resume / restore` |
| 权限与审批 | 三级权限：`read` / `sensitive_read` / `write`；预算审批；拒绝后的路径都有明确结果 | `runtime.ts: permissionApproval / approve` |
| 停止规则 | 工具调用数、步数、运行时长、LLM 成本、Token、连续失败熔断、鉴权失败熔断、用户手动停止；触发后基于已有证据生成**部分结果**，可“放宽预算 ×2 继续” | `runtime.ts: stopRule / finalizePartial` |
| 成本/时延 | 每个 span 记录时延；运行级统计调用数、外部请求、重试、缓存命中、耗时、Token、成本（单价可配） | 计划卡片底部、「观测」面板 |
| 可观测性 | Span 时间线（工具/LLM/审批/检查点/压缩/合规）、P50/P95、错误率、事件日志、可导出 Trace JSON | `Inspector.tsx: TraceTab` |
| 失败降级与恢复 | 估值接口失败 → 静态 PE（口径标注）；最新财报期无数据 → 上一期年报；iFinD 资讯失败 → 扶摇快讯；实体检索失败 → 本地别名表；LLM 失败/输出不合格 → 规则规划/模板摘要 | `tools.ts: fallbackTool`、`report.ts` |
| 故障演练 | 「工具/故障演练」面板可为任意工具注入：服务错误、超时、首次限流、鉴权失败、返回空、数据过期；LLM 可注入错误/超时 | `Inspector.tsx: ToolsTab`、`adapters/fuyao.ts: applyFault` |

## 4. 数据来源

**扶摇（同花顺金融数据 API，REST，`X-api-key` 鉴权）** —— 浏览器直连（已实测该服务对跨域请求返回 `Access-Control-Allow-Origin` 并允许 `x-api-key` 头）：

| 工具 | 端点 | 用途 / 口径 |
|---|---|---|
| `ticker_search` / `resolve_entities` | `/api/meta/tickers/search` | 名称/代码 → thscode |
| `price_snapshot` | `/api/a-share/prices/snapshot` | 最新价、涨跌幅、成交额（批量） |
| `index_snapshot` | `/api/a-share-index/prices/snapshot` | 指数/板块快照 |
| `price_history` | `/api/a-share/prices/historical` | 日 K，前复权；区间涨跌/年化波动/最大回撤 |
| `valuation_snapshot` | `/api/a-share/valuations/snapshot` | PE(TTM/MRQ)、PB(MRQ)、PS(TTM)、PCF(TTM) |
| `income_statements` | `/api/a-share/financials/income-statements` | 合并利润表·年报：营收、归母净利润、基本 EPS |
| `financial_indicators` | `/api/a-share/financials/indicators` | 成长/盈利/偿债指标（报告期 `yyyy-4`） |
| `stock_sectors` | `/api/a-share-index/constituents/ths-index-list-by-stock` | 行业/概念归属 |
| `index_constituents` | `/api/a-share-index/constituents/ths-stock-list` | 板块成分股 |
| `limit_up_stats` | `/api/a-share/special-data/limit-up-statistics` | 涨停/炸板/封板率 |
| `hot_stock_list` | `/api/a-share/special-data/hot-stock-list` | 同花顺热股榜 |
| `news_flash` | `/api/news/flash/list` | 快讯（资讯降级源） |

**iFinD MCP（Streamable HTTP / JSON-RPC）**：`search_news`（资讯）、`get_edb_data`（宏观）。地址与密钥来自 iFinD 终端的一键配置；若浏览器跨域受限，可用 `npm run proxy` 启动本地零依赖代理。

**演示数据**：没有 Key 时默认使用 `src/data/fixtures.ts` 中**人工构造的样例数据**（字段结构严格对齐扶摇文档，不代表真实市场；页面顶部、每份报告、每条证据都会标注“演示/构造”）。演示数据中刻意埋入了三类问题用于展示质量控制：比亚迪“净利润同比”指标与利润表推算值冲突、银行/保险毛利率与流动比率为 null、部分市现率缺失。资讯与宏观在演示模式下**只返回占位并按缺失处理，不编造新闻或宏观数值**。用户画像与持仓全部为构造的匿名数据。

## 5. AI 在产品中的角色

- **默认无 LLM 也能完整运行**：规则引擎负责意图/实体解析与模板化写作，这同时就是“模型失败”时的降级路径。
- **可选接入 LLM**（OpenAI 兼容如 DeepSeek/通义/Kimi，或 Anthropic；Key 只存 sessionStorage）：
  - 规划：只输出 `{intent, mentions}`，越界意图/非法 JSON → 回退规则规划并记录降级；
  - 摘要：必须对含数字的句子标注 `[E-xxx]`，`verifyNarrative` 逐句校验数字与被引证据一致（支持元↔亿元、比例↔百分比换算），不通过或含违规表述 → 回退模板摘要；
  - LLM 永远不直接产生数据，所有数字来自工具与本地计算。

## 6. 启动方式

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # 50 个用例（Vitest）
npm run build      # 产物在 dist/；部署到子路径时设置 BASE_PATH=/X-Buddy/
npm run proxy      # 可选：本地 CORS 代理（见 .env.example）
```

**环境变量**：前端无需 `.env`，所有 Key 在页面「设置」中填写，只保存在当前标签页的 sessionStorage，直接从浏览器请求数据源，不经过任何第三方服务器、不写入仓库。可选代理使用 `IFIND_MCP_URL`、`LLM_BASE`、`FUYAO_BASE`、`PORT`；构建子路径使用 `BASE_PATH`。见 `.env.example`。

**部署**：推送到 `main` 后，GitHub Actions（`.github/workflows/deploy.yml`）会执行测试与构建，并把 `dist/` 发布到 `gh-pages` 分支（GitHub Pages）。

**技术栈**：React 18 + TypeScript + Vite，无后端、无 UI 库、图表为手写 SVG；状态持久化在 localStorage（检查点/运行/记忆）与 sessionStorage（密钥）。

```
src/
  core/        Harness：types, registry, tools, planner, runtime, context, memory, compliance, metrics, report, llm, store
  adapters/    fuyao.ts（REST + 错误码映射 + 节流 + 故障注入）, ifind.ts（MCP 客户端）, demo.ts（演示数据客户端）
  data/        fixtures.ts（构造演示数据）
  ui/          App, RunCard（计划/审批/报告）, Blocks（动态 UI 渲染）, Inspector（证据/观测/上下文/检查点/记忆/工具）, SettingsDrawer
tests/         主链路、失败降级、状态恢复、合规边界、LLM 与适配器
server/        proxy.mjs（可选本地 CORS 代理）
```

## 7. 已知边界与未做事项

- **实时数据未用真实 Key 端到端验证**：开发环境没有扶摇/iFinD 账号 Key。已完成的验证：按官方文档实现全部请求与字段解析；对真实服务实测了 CORS 与鉴权错误（缺失/无效 Key 实际返回 `code=2003`，与文档写的 `2001` 不一致，已兼容）；用无效 Key 跑通了实时模式的“鉴权失败 → 熔断 → 不确定结论 + 部分报告”路径。填入有效 Key 后若个别字段与文档不符，相关证据会显示为“缺失”，而不会被当成正常值。
- **iFinD MCP**：工具名取自官方文档（`search_news`、`get_edb_data`），返回为文本片段，目前按段落切分为可引用片段，未做结构化字段抽取；地址需从 iFinD 终端获取，浏览器直连可能受 CORS 限制（提供本地代理）。
- 交易日历未参与新鲜度判断（使用“4 个自然日”近似，覆盖周末，不覆盖长假）；市场宽度（全市场涨跌家数）与主力资金未接入（扶摇将部分资金/高频数据限定在同花顺 AI 客户端内）。
- 意图/实体规则解析覆盖常见句式与约 50 个常用标的别名；别名表外的名称在实时模式下通过 `ticker_search` 解析，演示模式只覆盖 8 只样例股票。
- 检查点存在浏览器本地（单用户、单设备）；无账号体系与多端同步；未做服务端持久化与多用户隔离。
- 估值“历史分位”、同行业全样本比较、季度财务、现金流量表分析未实现。
- 移动端可用但以桌面端为主要体验。

## 8. 合规声明

本产品输出仅供研究参考，不构成投资建议；不输出确定性涨跌预测、收益承诺或直接买卖建议；所有事实标注来源、时点、单位与口径，推断与不确定信息单独标识。仓库中不包含任何 API Key、真实用户隐私或受限数据。
