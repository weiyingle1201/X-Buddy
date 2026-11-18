import { extractJson, LlmClient } from './llm';
import { Intent, PlanTask } from './types';
import { latestAnnualReport } from './util';

/** 常用标的别名（离线解析兜底；Live 模式下未命中者通过 ticker_search 解析） */
export const ALIASES: Record<string, string> = {
  贵州茅台: '600519.SH', 茅台: '600519.SH', 五粮液: '000858.SZ', 宁德时代: '300750.SZ', 宁王: '300750.SZ', 比亚迪: '002594.SZ',
  美的集团: '000333.SZ', 美的: '000333.SZ', 中国平安: '601318.SH', 平安: '601318.SH', 招商银行: '600036.SH', 招行: '600036.SH',
  中芯国际: '688981.SH', 泸州老窖: '000568.SZ', 山西汾酒: '600809.SH', 格力电器: '000651.SZ', 海尔智家: '600690.SH',
  东方财富: '300059.SZ', 同花顺: '300033.SZ', 隆基绿能: '601012.SH', 长江电力: '600900.SH', 中国神华: '601088.SH',
  工商银行: '601398.SH', 建设银行: '601939.SH', 农业银行: '601288.SH', 中国银行: '601988.SH', 兴业银行: '601166.SH',
  中信证券: '600030.SH', 恒瑞医药: '600276.SH', 迈瑞医疗: '300760.SZ', 药明康德: '603259.SH', 立讯精密: '002475.SZ',
  海康威视: '002415.SZ', 京东方A: '000725.SZ', 紫金矿业: '601899.SH', 万华化学: '600309.SH', 伊利股份: '600887.SH',
  海天味业: '603288.SH', 中国移动: '600941.SH', 中国石油: '601857.SH', 寒武纪: '688256.SH', 中际旭创: '300308.SZ',
  北方华创: '002371.SZ', 赛力斯: '601127.SH', 小米: '', 腾讯: '',
};

const STOP =
  /研究报告|研究|分析|一下|看看|看下|帮我|帮忙|请问|请|我想|想要|了解|基本面|估值|财务|盈利能力|盈利|能力|现金流|成长性|风险|情况|怎么样|如何|水平|质量|报告|深度|一份|写|做|吗|呢|还有|以及|最近|近期|今年|一年|近一年|现在|目前|当前|今天|今日|走势|行情|表现|公司|股票|个股|这只|这个|对比|比较|相比|板块|行业|概念|赛道|整体|主要|关键|指标|数据|变化|再和|再跟|再|它的|它|其|和|与|及|跟|的|vs|VS|PK|[，,。、？?！!：:；;（）()\s]+/g;

export interface ParsedGoal {
  intent: Intent;
  mentions: string[]; // 原始提及（名称或代码）
  resolvedHints: Record<string, string>; // 名称 → thscode（来自别名表）
  sectorQuery?: string;
  source: 'rule' | 'llm';
}

export function inferSuffix(code: string): string {
  if (/^(60|68|90)/.test(code)) return `${code}.SH`;
  if (/^(00|30|20)/.test(code)) return `${code}.SZ`;
  if (/^(8|4|92)/.test(code)) return `${code}.BJ`;
  return `${code}.SH`;
}

export function extractMentions(goal: string): { mentions: string[]; hints: Record<string, string>; residual: string[] } {
  const mentions: string[] = [];
  const hints: Record<string, string> = {};
  let rest = goal;
  for (const m of goal.matchAll(/\b(\d{6})(\.(SH|SZ|BJ))?\b/gi)) {
    const code = m[2] ? `${m[1]}.${m[3].toUpperCase()}` : inferSuffix(m[1]);
    mentions.push(code);
    hints[code] = code;
    rest = rest.replace(m[0], ' ');
  }
  // 长名优先匹配，避免“平安”抢先于“中国平安”
  const names = Object.keys(ALIASES).sort((a, b) => b.length - a.length);
  for (const n of names) {
    if (rest.includes(n)) {
      const code = ALIASES[n];
      if (code && !Object.values(hints).includes(code)) {
        mentions.push(n);
        hints[n] = code;
      } else if (!code) mentions.push(n); // 已知但非 A 股（如港股），交给解析步骤报告
      rest = rest.split(n).join(' ');
    }
  }
  const residual = rest
    .replace(STOP, ' ')
    .split(/\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 10 && /[一-龥A-Za-z]/.test(s));
  return { mentions, hints, residual };
}

export function classify(goal: string, mentionCount: number): Intent {
  if (/持仓|组合|仓位|我的股票|体检/.test(goal)) return 'portfolio';
  if (mentionCount === 0 && /大盘|市场|情绪|涨停|复盘|热榜|热点|全市场|指数/.test(goal)) return 'market';
  if (mentionCount === 0 && /板块|行业|概念|赛道/.test(goal)) return 'sector';
  if (mentionCount >= 2 || (mentionCount >= 1 && /对比|比较|vs|相比|PK/i.test(goal))) return 'compare';
  if (mentionCount === 1) return 'stock';
  return 'unknown';
}

export function ruleParse(goal: string, threadEntities: { thscode: string; name: string }[] = []): ParsedGoal {
  const { mentions, hints, residual } = extractMentions(goal);
  let intent = classify(goal, mentions.length);
  let all = [...mentions];
  if ((intent === 'unknown' || intent === 'stock' || intent === 'compare') && residual.length) {
    // 未命中别名的残余词作为候选标的名，交给 ticker_search 解析
    if (intent === 'unknown' || /对比|比较|和|与|vs/i.test(goal)) all = [...all, ...residual.slice(0, 3)];
    intent = classify(goal, all.length);
  }
  // 线程延续：追问中省略标的时沿用线程实体
  if (threadEntities.length && (intent === 'unknown' || (intent === 'compare' && all.length < 2) || (/再和|再跟|它|其/.test(goal) && all.length <= 1))) {
    const carry = threadEntities.filter((e) => !Object.values(hints).includes(e.thscode)).map((e) => e.thscode);
    if (intent === 'unknown' && carry.length) {
      all = [carry[0]];
      hints[carry[0]] = carry[0];
      intent = 'stock';
    } else if (carry.length && all.length >= 1) {
      all = [carry[0], ...all];
      hints[carry[0]] = carry[0];
      intent = 'compare';
    }
  }
  const sectorQuery = intent === 'sector' ? residual[0] ?? goal.replace(STOP, '').slice(0, 6) : undefined;
  return { intent, mentions: all.slice(0, 4), resolvedHints: hints, sectorQuery, source: 'rule' };
}

/** LLM 只负责“理解”（意图 + 实体），输出受白名单校验；执行计划仍由规则展开，保证可控 */
export async function llmParse(goal: string, llm: LlmClient, catalog: string, signal?: AbortSignal): Promise<{ parsed: ParsedGoal | null; tokensIn: number; tokensOut: number; error?: string }> {
  const system =
    '你是投资研究 Agent 的规划器。只输出 JSON：{"intent":"stock|compare|market|portfolio|sector|unknown","mentions":["标的名称或6位代码"],"sector":"板块名或空"}。' +
    '不得输出任何涨跌预测或买卖建议。可用工具目录：\n' +
    catalog;
  try {
    const r = await llm.complete(system, `研究目标：${goal}`, { signal, maxTokens: 200 });
    const j = extractJson(r.text);
    const intents: Intent[] = ['stock', 'compare', 'market', 'portfolio', 'sector', 'unknown'];
    if (!j || !intents.includes(j.intent) || !Array.isArray(j.mentions) || j.mentions.some((m: unknown) => typeof m !== 'string' || (m as string).length > 20)) {
      return { parsed: null, tokensIn: r.tokensIn, tokensOut: r.tokensOut, error: 'LLM 规划输出未通过 schema 校验' };
    }
    const hints: Record<string, string> = {};
    const mentions: string[] = j.mentions.slice(0, 4);
    for (const m of mentions) {
      if (ALIASES[m]) hints[m] = ALIASES[m];
      const code = m.match(/^(\d{6})(\.(SH|SZ|BJ))?$/i);
      if (code) hints[m] = code[2] ? m.toUpperCase() : inferSuffix(code[1]);
    }
    return { parsed: { intent: j.intent, mentions, resolvedHints: hints, sectorQuery: j.sector || undefined, source: 'llm' }, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
  } catch (e: any) {
    return { parsed: null, tokensIn: 0, tokensOut: 0, error: e?.message ?? String(e) };
  }
}

// ---------------- 计划生成 ----------------
type TaskInit = Omit<PlanTask, 'status' | 'attempts' | 'evidenceIds'>;
const mk = (t: TaskInit): PlanTask => ({ ...t, status: 'pending', attempts: 0, evidenceIds: [] });
const short = (code: string) => code.replace('.', '');

export const MARKET_INDICES = ['000001.SH', '399001.SZ', '399006.SZ', '000300.SH'];

export function initialPlan(p: ParsedGoal, _now: number, threadEntities: { thscode: string; name: string }[] = []): PlanTask[] {
  switch (p.intent) {
    case 'market':
      return marketTasks();
    case 'portfolio':
      return [mk({ id: 't_holdings', title: '读取模拟持仓（敏感，需授权）', capability: '用户状态', tool: 'read_portfolio', args: {}, dependsOn: [], required: true, expand: true })];
    case 'sector':
      return [mk({ id: 't_sector', title: `检索板块「${p.sectorQuery ?? ''}」`, capability: '板块/指数', tool: 'ticker_search', args: { q: p.sectorQuery ?? '', asset_type: 'a-share-index', limit: 5 }, dependsOn: [], required: true, expand: true })];
    default:
      return [
        mk({
          id: 't_resolve',
          title: p.mentions.length ? `解析标的：${p.mentions.join('、')}` : '解析研究标的',
          capability: '标的检索',
          tool: 'resolve_entities',
          args: { mentions: p.mentions, hints: p.resolvedHints, intent: p.intent, carry: threadEntities },
          dependsOn: [],
          required: true,
          expand: true,
        }),
      ];
  }
}

function marketTasks(): PlanTask[] {
  return [
    mk({ id: 't_index', title: '主要指数行情快照', capability: '行情', tool: 'index_snapshot', args: { thscodes: MARKET_INDICES.join(',') }, dependsOn: [], required: true }),
    mk({ id: 't_limit', title: '涨停/连板市场统计', capability: '市场情绪', tool: 'limit_up_stats', args: {}, dependsOn: [], required: false }),
    mk({ id: 't_hot', title: '同花顺热股榜', capability: '市场情绪', tool: 'hot_stock_list', args: { limit: 10 }, dependsOn: [], required: false }),
    mk({ id: 't_news', title: '市场资讯检索', capability: '资讯', tool: 'news_search', args: { query: 'A股 市场 今日' }, dependsOn: [], required: false }),
    mk({ id: 't_calc', title: '计算市场宽度与情绪指标', capability: '本地计算', tool: 'compute_metrics', args: { mode: 'market' }, dependsOn: ['t_index', 't_limit', 't_hot'], required: true, runAlways: true }),
    mk({ id: 't_report', title: '撰写市场观察（含证据与不确定项）', capability: '产物', tool: 'compose_report', args: { mode: 'market' }, dependsOn: ['t_calc', 't_news'], required: true, runAlways: true }),
  ];
}

/** 两阶段规划：实体/持仓/板块解析完成后展开数据任务 */
export function expandPlan(intent: Intent, task: PlanTask, output: any, now: number): PlanTask[] {
  const { report } = latestAnnualReport(now);
  if (task.tool === 'resolve_entities') {
    const ents: { thscode: string; name: string }[] = output?.entities ?? [];
    if (!ents.length) {
      return [mk({ id: 't_report', title: '输出澄清说明（未识别到标的）', capability: '产物', tool: 'compose_report', args: { mode: 'unresolved' }, dependsOn: [], required: true, runAlways: true })];
    }
    if (intent === 'compare' && ents.length >= 2) return compareTasks(ents.slice(0, 4), report);
    return stockTasks(ents[0], report);
  }
  if (task.tool === 'read_portfolio') {
    const hs: { thscode: string; name: string }[] = (output?.holdings ?? []).filter((h: any) => h.thscode !== 'CASH');
    if (!hs.length) return [mk({ id: 't_report', title: '输出说明（无持仓）', capability: '产物', tool: 'compose_report', args: { mode: 'portfolio' }, dependsOn: [], required: true, runAlways: true })];
    const codes = hs.map((h) => h.thscode).join(',');
    return [
      mk({ id: 't_quote', title: `持仓行情快照（${hs.length} 只，批量）`, capability: '行情', tool: 'price_snapshot', args: { thscodes: codes }, dependsOn: [], required: true }),
      mk({ id: 't_val', title: '持仓估值快照（批量）', capability: '估值', tool: 'valuation_snapshot', args: { thscodes: codes }, dependsOn: [], required: false }),
      mk({ id: 't_sec', title: '持仓行业/概念归属', capability: '板块/指数', tool: 'stock_sectors', args: { thscodes: codes }, dependsOn: [], required: false }),
      mk({ id: 't_calc', title: '计算集中度、行业暴露与估值分布', capability: '本地计算', tool: 'compute_metrics', args: { mode: 'portfolio' }, dependsOn: ['t_quote', 't_val', 't_sec'], required: true, runAlways: true }),
      mk({ id: 't_report', title: '撰写持仓体检报告', capability: '产物', tool: 'compose_report', args: { mode: 'portfolio' }, dependsOn: ['t_calc'], required: true, runAlways: true }),
    ];
  }
  if (task.tool === 'ticker_search' && task.id === 't_sector') {
    const hit = (output?.items ?? [])[0];
    if (!hit) return [mk({ id: 't_report', title: '输出澄清说明（未找到板块）', capability: '产物', tool: 'compose_report', args: { mode: 'unresolved' }, dependsOn: [], required: true, runAlways: true })];
    return [
      mk({ id: 't_cons', title: `获取「${hit.name}」成分股`, capability: '板块/指数', tool: 'index_constituents', args: { thscode: hit.thscode, name: hit.name }, dependsOn: [], required: true, expand: true }),
      mk({ id: 't_index', title: `「${hit.name}」指数快照`, capability: '行情', tool: 'index_snapshot', args: { thscodes: hit.thscode }, dependsOn: [], required: false }),
    ];
  }
  if (task.tool === 'index_constituents') {
    const cons: { thscode: string; name: string }[] = (output?.items ?? []).slice(0, 10);
    const tail = [
      mk({ id: 't_calc', title: '计算板块内涨跌分布与估值分位', capability: '本地计算', tool: 'compute_metrics', args: { mode: 'sector' }, dependsOn: cons.length ? ['t_quote', 't_val', 't_index'] : ['t_index'], required: true, runAlways: true }),
      mk({ id: 't_report', title: '撰写板块观察报告', capability: '产物', tool: 'compose_report', args: { mode: 'sector' }, dependsOn: ['t_calc'], required: true, runAlways: true }),
    ];
    if (!cons.length) return tail;
    const codes = cons.map((c) => c.thscode).join(',');
    return [
      mk({ id: 't_quote', title: `成分股行情（前 ${cons.length} 只，批量）`, capability: '行情', tool: 'price_snapshot', args: { thscodes: codes }, dependsOn: [], required: true }),
      mk({ id: 't_val', title: '成分股估值（批量）', capability: '估值', tool: 'valuation_snapshot', args: { thscodes: codes }, dependsOn: [], required: false }),
      ...tail,
    ];
  }
  return [];
}

function stockTasks(e: { thscode: string; name: string }, report: string): PlanTask[] {
  const c = e.thscode;
  return [
    mk({ id: 't_quote', title: `${e.name} 行情快照`, capability: '行情', tool: 'price_snapshot', args: { thscodes: c }, dependsOn: [], required: true }),
    mk({ id: 't_hist', title: `${e.name} 近一年日 K（前复权）`, capability: '行情', tool: 'price_history', args: { thscode: c, days: 365 }, dependsOn: [], required: false }),
    mk({ id: 't_val', title: `${e.name} 估值快照（PE/PB/PS/PCF）`, capability: '估值', tool: 'valuation_snapshot', args: { thscodes: c }, dependsOn: [], required: false }),
    mk({ id: 't_inc', title: `${e.name} 近 4 期年报利润表`, capability: '财务', tool: 'income_statements', args: { thscode: c, period: 'annual', limit: 4 }, dependsOn: [], required: true }),
    mk({ id: 't_ind', title: `${e.name} 财务指标（${report}）`, capability: '财务', tool: 'financial_indicators', args: { thscode: c, report }, dependsOn: [], required: false }),
    mk({ id: 't_sec', title: `${e.name} 行业/概念归属`, capability: '板块/指数', tool: 'stock_sectors', args: { thscodes: c }, dependsOn: [], required: false }),
    mk({ id: 't_news', title: `${e.name} 资讯/公告检索`, capability: '资讯', tool: 'news_search', args: { query: e.name, thscode: c }, dependsOn: [], required: false }),
    mk({ id: 't_calc', title: '计算衍生指标并做一致性校验', capability: '本地计算', tool: 'compute_metrics', args: { mode: 'stock' }, dependsOn: ['t_quote', 't_hist', 't_val', 't_inc', 't_ind'], required: true, runAlways: true }),
    mk({ id: 't_report', title: '撰写研究报告（事实/推断/不确定）', capability: '产物', tool: 'compose_report', args: { mode: 'stock' }, dependsOn: ['t_calc', 't_sec', 't_news'], required: true, runAlways: true }),
    mk({ id: 't_memory', title: '写入研究笔记到长期记忆（需确认）', capability: '用户状态', tool: 'save_memory', args: {}, dependsOn: ['t_report'], required: false }),
  ];
}

function compareTasks(ents: { thscode: string; name: string }[], report: string): PlanTask[] {
  const codes = ents.map((e) => e.thscode).join(',');
  const per = ents.flatMap((e) => [
    mk({ id: `t_inc_${short(e.thscode)}`, title: `${e.name} 年报利润表`, capability: '财务', tool: 'income_statements', args: { thscode: e.thscode, period: 'annual', limit: 4 }, dependsOn: [], required: true }),
    mk({ id: `t_ind_${short(e.thscode)}`, title: `${e.name} 财务指标（${report}）`, capability: '财务', tool: 'financial_indicators', args: { thscode: e.thscode, report }, dependsOn: [], required: false }),
    mk({ id: `t_hist_${short(e.thscode)}`, title: `${e.name} 近一年日 K`, capability: '行情', tool: 'price_history', args: { thscode: e.thscode, days: 365 }, dependsOn: [], required: false }),
  ]);
  const dataIds = ['t_quote', 't_val', ...per.map((t) => t.id)];
  return [
    mk({ id: 't_quote', title: `行情快照（${ents.length} 只，批量）`, capability: '行情', tool: 'price_snapshot', args: { thscodes: codes }, dependsOn: [], required: true }),
    mk({ id: 't_val', title: '估值快照（批量）', capability: '估值', tool: 'valuation_snapshot', args: { thscodes: codes }, dependsOn: [], required: false }),
    ...per,
    mk({ id: 't_calc', title: '横向对比计算与一致性校验', capability: '本地计算', tool: 'compute_metrics', args: { mode: 'compare' }, dependsOn: dataIds, required: true, runAlways: true }),
    mk({ id: 't_report', title: '撰写对比报告', capability: '产物', tool: 'compose_report', args: { mode: 'compare' }, dependsOn: ['t_calc'], required: true, runAlways: true }),
    mk({ id: 't_memory', title: '写入对比笔记到长期记忆（需确认）', capability: '用户状态', tool: 'save_memory', args: {}, dependsOn: ['t_report'], required: false }),
  ];
}
