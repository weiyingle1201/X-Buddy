// 工具注册：把扶摇 REST / iFinD MCP / 本地记忆 / 本地计算 包装成带权限、超时、重试、缓存、降级声明的 ToolSpec
import { FuyaoApi } from '../adapters/fuyao';
import { McpApi } from '../adapters/ifind';
import { DEMO_ASOF } from '../data/fixtures';
import { LlmClient } from './llm';
import { MemoryStore } from './memory';
import { ALIASES } from './planner';
import { ToolRegistry } from './registry';
import { computeMetrics } from './metrics';
import { composeReport } from './report';
import { EvidenceDraft, EvidenceStatus, ToolContext, ToolError, ToolSpec } from './types';
import { fmtDate, latestAnnualReport, toNum } from './util';

export interface ToolDeps {
  fuyao: FuyaoApi;
  ifind: McpApi;
  memory: MemoryStore;
  llm: LlmClient;
}

const DAY = 86400e3;

/** 数据新鲜度：快照类 4 个自然日内视为新鲜（覆盖周末）；演示模式以演示时点为基准 */
export function freshness(asOf: number | null | undefined, mode: 'live' | 'demo', now: number, maxAgeMs = 4 * DAY): EvidenceStatus {
  if (!asOf) return mode === 'demo' ? 'demo' : 'ok';
  const ref = mode === 'demo' ? DEMO_ASOF : now;
  if (ref - asOf > maxAgeMs) return 'stale';
  return mode === 'demo' ? 'demo' : 'ok';
}

function statusOf(value: unknown, base: EvidenceStatus): EvidenceStatus {
  if (value === null || value === undefined || value === '') return 'missing';
  return base;
}

const reqStr = (k: string) => (a: Record<string, unknown>) => (typeof a[k] === 'string' && (a[k] as string).length > 0 ? null : `缺少参数 ${k}`);
const codeRe = /^\d{6}\.(SH|SZ|BJ)$/;
const reqCodes = (k: string, max = 100) => (a: Record<string, unknown>) => {
  const v = String(a[k] ?? '');
  const arr = v.split(',').filter(Boolean);
  if (!arr.length) return `缺少参数 ${k}`;
  if (arr.length > max) return `${k} 超过上限 ${max}`;
  const bad = arr.find((c) => !codeRe.test(c) && !/^[A-Z0-9]{6}\.TI$/.test(c));
  return bad ? `代码格式错误：${bad}（需完整 thscode，如 600519.SH）` : null;
};

const nameOf = (ctx: ToolContext, code: string) => ctx.run.entities.find((e) => e.thscode === code)?.name ?? Object.keys(ALIASES).find((k) => ALIASES[k] === code && k.length > 2) ?? code;

export function buildRegistry(d: ToolDeps): ToolRegistry {
  const r = new ToolRegistry();
  const src = (path: string) => `${d.fuyao.mode === 'demo' ? '演示快照（构造）' : '扶摇 REST'} ${path}`;

  // ---------------- 标的检索 ----------------
  const tickerSearch: ToolSpec = {
    name: 'ticker_search',
    title: '标的检索',
    capability: '标的检索',
    source: 'fuyao',
    endpoint: '/api/meta/tickers/search',
    description: '按代码/名称检索 A 股、指数、板块，返回 thscode',
    permission: 'read',
    validate: reqStr('q'),
    timeoutMs: 8000,
    maxRetries: 2,
    cacheTtlMs: 24 * 3600e3,
    estCalls: 1,
    async run(a, ctx) {
      const env = await d.fuyao.get('/api/meta/tickers/search', { q: String(a.q), asset_type: a.asset_type as string | undefined, limit: (a.limit as number) ?? 10 }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const items = (env.data?.item ?? []) as any[];
      const base = d.fuyao.mode === 'demo' ? 'demo' : 'ok';
      return {
        data: { items },
        apiCalls: 1,
        summary: items.length ? `检索「${a.q}」命中 ${items.length} 条：${items.slice(0, 3).map((i) => `${i.name}(${i.thscode})`).join('、')}` : `检索「${a.q}」无结果`,
        evidence: [
          {
            source: src('/api/meta/tickers/search'),
            endpoint: '/api/meta/tickers/search',
            params: a,
            field: 'item[0].thscode',
            label: `检索「${a.q}」首条结果`,
            value: items[0] ? `${items[0].name} ${items[0].thscode}` : null,
            asOf: env.data?.timestamp ?? null,
            status: items[0] ? base : 'missing',
            entity: items[0]?.thscode,
            raw: items.slice(0, 3),
          },
        ],
      };
    },
  };
  r.register(tickerSearch);

  r.register({
    name: 'resolve_entities',
    title: '实体解析',
    capability: '标的检索',
    source: 'local',
    description: '把用户提及的名称/代码解析为标准 thscode（别名表 + ticker_search）',
    permission: 'read',
    timeoutMs: 20000,
    maxRetries: 0,
    cacheTtlMs: 0,
    estCalls: 1,
    async run(a, ctx) {
      const mentions = (a.mentions as string[]) ?? [];
      const hints = (a.hints as Record<string, string>) ?? {};
      const carry = (a.carry as { thscode: string; name: string }[]) ?? [];
      const entities: { thscode: string; name: string }[] = [];
      const unresolved: string[] = [];
      const evidence: EvidenceDraft[] = [];
      let apiCalls = 0;
      for (const m of mentions) {
        let code = hints[m];
        let name = /^\d{6}\./.test(m) ? carry.find((c) => c.thscode === m)?.name : m;
        let via = '本地别名表';
        let raw: unknown;
        if (!code || d.fuyao.mode === 'live') {
          try {
            const env = await d.fuyao.get('/api/meta/tickers/search', { q: code ?? m, asset_type: 'a-share', limit: 3 }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
            apiCalls++;
            const hit = (env.data?.item ?? [])[0];
            if (hit) {
              code = hit.thscode;
              name = hit.name;
              via = src('/api/meta/tickers/search');
              raw = hit;
            }
          } catch (e) {
            if (e instanceof ToolError && e.kind === 'aborted') throw e;
            via = code ? '本地别名表（检索接口失败，降级）' : via;
          }
        }
        if (code && !name) name = nameOf(ctx, code);
        if (code) {
          if (!entities.some((e) => e.thscode === code)) entities.push({ thscode: code, name: name ?? code });
          evidence.push({ source: via, field: 'thscode', label: `「${m}」→ 标准代码`, value: `${name} ${code}`, entity: code, entityName: name, status: d.fuyao.mode === 'demo' ? 'demo' : 'ok', asOf: null, raw });
        } else {
          unresolved.push(m);
          evidence.push({ source: via, field: 'thscode', label: `「${m}」解析失败`, value: null, status: 'missing', note: '未在 A 股代码表中找到；可能为港美股、简称歧义或拼写错误', asOf: null });
        }
      }
      if (a.intent === 'compare' && entities.length < 2) {
        for (const c of carry) if (!entities.some((e) => e.thscode === c.thscode)) entities.unshift(c);
      }
      ctx.run.entities = entities;
      return {
        data: { entities, unresolved },
        apiCalls,
        summary: `解析出 ${entities.length} 个标的：${entities.map((e) => `${e.name}(${e.thscode})`).join('、') || '无'}${unresolved.length ? `；未解析：${unresolved.join('、')}` : ''}`,
        evidence,
      };
    },
  });

  // ---------------- 行情 ----------------
  const snapshotTool = (name: string, title: string, path: string, unit: string): ToolSpec => ({
    name,
    title,
    capability: '行情',
    source: 'fuyao',
    endpoint: path,
    description: `${title}：最新价、涨跌幅、成交额（批量 thscodes）`,
    permission: 'read',
    validate: reqCodes('thscodes'),
    timeoutMs: 8000,
    maxRetries: 2,
    cacheTtlMs: 60e3,
    estCalls: 1,
    async run(a, ctx) {
      const env = await d.fuyao.get(path, { thscodes: String(a.thscodes) }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const items = (env.data?.item ?? []) as any[];
      const asOf = env.data?.timestamp ?? null;
      const base = freshness(asOf, d.fuyao.mode, ctx.now(), 4 * DAY);
      const ev: EvidenceDraft[] = [];
      const want = String(a.thscodes).split(',');
      for (const code of want) {
        const it = items.find((x) => x.thscode === code);
        const nm = nameOf(ctx, code);
        const common = { source: src(path), endpoint: path, params: { thscodes: code }, entity: code, entityName: nm, asOf, caliber: '最新行情快照（不复权）' };
        if (!it) {
          ev.push({ ...common, field: 'last_price', label: `${nm} 最新价`, value: null, unit, status: 'missing', note: '接口未返回该标的' });
          continue;
        }
        ev.push({ ...common, field: 'last_price', label: `${nm} 最新价`, value: toNum(it.last_price), unit, status: statusOf(it.last_price, base), raw: it });
        ev.push({ ...common, field: 'price_change_ratio_pct', label: `${nm} 涨跌幅`, value: toNum(it.price_change_ratio_pct), unit: '%', status: statusOf(it.price_change_ratio_pct, base) });
        ev.push({ ...common, field: 'turnover', label: `${nm} 成交额`, value: toNum(it.turnover), unit: '元', status: statusOf(it.turnover, base) });
      }
      return {
        data: { items, asOf },
        apiCalls: 1,
        summary: `${title} ${items.length}/${want.length} 条，时点 ${asOf ? fmtDate(asOf, true) : '未知'}${base === 'stale' ? '（已过期）' : ''}`,
        evidence: ev,
      };
    },
  });
  r.register(snapshotTool('price_snapshot', 'A股行情快照', '/api/a-share/prices/snapshot', '元'));
  r.register(snapshotTool('index_snapshot', '指数行情快照', '/api/a-share-index/prices/snapshot', '点'));

  r.register({
    name: 'price_history',
    title: '历史日K',
    capability: '行情',
    source: 'fuyao',
    endpoint: '/api/a-share/prices/historical',
    description: '单只 A 股日 K（前复权），用于区间涨跌、波动率、回撤',
    permission: 'read',
    validate: (a) => (codeRe.test(String(a.thscode)) ? null : '需要单个完整 thscode'),
    timeoutMs: 10000,
    maxRetries: 2,
    cacheTtlMs: 3600e3,
    estCalls: 1,
    async run(a, ctx) {
      const end = d.fuyao.mode === 'demo' ? DEMO_ASOF : ctx.now();
      const start = end - Number(a.days ?? 365) * DAY;
      const path = '/api/a-share/prices/historical';
      const env = await d.fuyao.get(path, { thscode: String(a.thscode), interval: '1d', start, end, adjust: 'forward' }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const bars = ((env.data?.item ?? []) as any[]).filter((b) => toNum(b.close_price) !== null);
      const code = String(a.thscode);
      const nm = nameOf(ctx, code);
      const common = { source: src(path), endpoint: path, params: { thscode: code, interval: '1d', adjust: 'forward', start, end }, entity: code, entityName: nm, caliber: '日K·前复权' };
      if (!bars.length) {
        return { data: { bars: [] }, apiCalls: 1, summary: `${nm} 日K 为空`, evidence: [{ ...common, field: 'close_price', label: `${nm} 日K序列`, value: null, status: 'missing', asOf: null }] };
      }
      const first = bars[0];
      const last = bars[bars.length - 1];
      const base = freshness(last.date_ms, d.fuyao.mode, ctx.now(), 5 * DAY);
      return {
        data: { bars: bars.map((b) => ({ t: b.date_ms, c: b.close_price })) },
        apiCalls: 1,
        summary: `${nm} 日K ${bars.length} 根（${fmtDate(first.date_ms)} ~ ${fmtDate(last.date_ms)}）`,
        evidence: [
          { ...common, field: 'close_price[first]', label: `${nm} 区间首日收盘`, value: first.close_price, unit: '元', asOf: first.date_ms, status: base === 'stale' ? 'stale' : d.fuyao.mode === 'demo' ? 'demo' : 'ok', raw: first },
          { ...common, field: 'close_price[last]', label: `${nm} 区间末日收盘`, value: last.close_price, unit: '元', asOf: last.date_ms, status: base, raw: last },
          { ...common, field: 'item.length', label: `${nm} K线根数`, value: bars.length, unit: '根', asOf: last.date_ms, status: base },
        ],
      };
    },
  });

  // ---------------- 估值 ----------------
  r.register({
    name: 'valuation_snapshot',
    title: '估值快照',
    capability: '估值',
    source: 'fuyao',
    endpoint: '/api/a-share/valuations/snapshot',
    description: 'PE(TTM/MRQ)、PB(MRQ)、PS(TTM)、PCF(TTM)，批量',
    permission: 'read',
    validate: reqCodes('thscodes'),
    timeoutMs: 8000,
    maxRetries: 2,
    cacheTtlMs: 3600e3,
    estCalls: 1,
    fallbackTool: 'valuation_fallback',
    async run(a, ctx) {
      const path = '/api/a-share/valuations/snapshot';
      const env = await d.fuyao.get(path, { thscodes: String(a.thscodes) }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const items = (env.data?.item ?? []) as any[];
      const asOf = env.data?.timestamp ?? null;
      const base = freshness(asOf, d.fuyao.mode, ctx.now(), 5 * DAY);
      const ev: EvidenceDraft[] = [];
      const fields: [string, string, string][] = [
        ['pe_ttm', '市盈率', 'TTM'],
        ['pb_mrq', '市净率', 'MRQ'],
        ['ps_ttm', '市销率', 'TTM'],
        ['pcf_ttm', '市现率', 'TTM'],
      ];
      for (const code of String(a.thscodes).split(',')) {
        const it = items.find((x) => x.thscode === code);
        const nm = it?.name ?? nameOf(ctx, code);
        for (const [f, label, cal] of fields) {
          const v = it ? toNum(it[f]) : null;
          ev.push({ source: src(path), endpoint: path, params: { thscodes: code }, entity: code, entityName: nm, field: f, label: `${nm} ${label}(${cal})`, value: v, unit: '倍', caliber: cal, asOf, status: statusOf(v, base), note: v === null ? '上游返回 null（可能不适用或缺失）' : v < 0 ? '为负值（亏损期），不宜直接比较' : undefined, raw: f === 'pe_ttm' ? it : undefined });
        }
      }
      return { data: { items, asOf }, apiCalls: 1, summary: `估值快照 ${items.length} 条${base === 'stale' ? '（已过期）' : ''}`, evidence: ev };
    },
  });

  r.register({
    name: 'valuation_fallback',
    title: '估值降级：静态市盈率',
    capability: '估值',
    source: 'local',
    description: '估值接口失败时，用 最新价 / 最近年报基本EPS 计算静态 PE（口径不同，标记为推断）',
    permission: 'read',
    timeoutMs: 15000,
    maxRetries: 0,
    cacheTtlMs: 0,
    estCalls: 2,
    async run(a, ctx) {
      const ev: EvidenceDraft[] = [];
      let apiCalls = 0;
      for (const code of String(a.thscodes).split(',')) {
        const nm = nameOf(ctx, code);
        const s = await d.fuyao.get('/api/a-share/prices/snapshot', { thscodes: code }, { signal: ctx.signal, attempt: 1 });
        const inc = await d.fuyao.get('/api/a-share/financials/income-statements', { thscode: code, period: 'annual', limit: 1 }, { signal: ctx.signal, attempt: 1 });
        apiCalls += 2;
        const px = toNum(s.data?.item?.[0]?.last_price);
        const eps = toNum(inc.data?.item?.[0]?.basic_eps);
        const fy = inc.data?.item?.[0]?.fiscal_year;
        const v = px !== null && eps ? +(px / eps).toFixed(2) : null;
        ev.push({ source: '本地计算（降级）', entity: code, entityName: nm, field: 'pe_static', label: `${nm} 静态市盈率（降级口径）`, value: v, unit: '倍', caliber: `最新价 / FY${fy ?? '?'} 基本EPS`, formula: `${px} / ${eps}`, asOf: s.data?.timestamp ?? null, status: v === null ? 'missing' : 'derived', note: '估值接口不可用时的降级口径，与 PE(TTM) 不可直接比较' });
      }
      return { data: { items: [] }, apiCalls, summary: '估值接口不可用，已用静态 PE 降级', evidence: ev, degradedNote: '估值快照失败 → 改用静态PE（口径变化已标注）' };
    },
  });

  // ---------------- 财务 ----------------
  r.register({
    name: 'income_statements',
    title: '利润表',
    capability: '财务',
    source: 'fuyao',
    endpoint: '/api/a-share/financials/income-statements',
    description: '合并利润表多期：营业收入、归母净利润、基本EPS',
    permission: 'read',
    validate: (a) => (codeRe.test(String(a.thscode)) ? null : '需要单个完整 thscode'),
    timeoutMs: 8000,
    maxRetries: 2,
    cacheTtlMs: 24 * 3600e3,
    estCalls: 1,
    async run(a, ctx) {
      const path = '/api/a-share/financials/income-statements';
      const code = String(a.thscode);
      const env = await d.fuyao.get(path, { thscode: code, period: String(a.period ?? 'annual'), limit: Number(a.limit ?? 4) }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const items = ((env.data?.item ?? []) as any[]).sort((x, y) => (x.fiscal_year ?? 0) - (y.fiscal_year ?? 0));
      const nm = nameOf(ctx, code);
      const base = d.fuyao.mode === 'demo' ? 'demo' : 'ok';
      const ev: EvidenceDraft[] = [];
      for (const it of items) {
        const cal = `合并报表·${it.period === 'annual' ? '年报' : '季报'}·FY${it.fiscal_year}`;
        const common = { source: src(path), endpoint: path, params: { thscode: code, period: a.period ?? 'annual' }, entity: code, entityName: nm, caliber: cal, asOf: it.period_end_ms ?? it.report_date_ms ?? null };
        ev.push({ ...common, field: 'operating_income', label: `${nm} FY${it.fiscal_year} 营业收入`, value: toNum(it.operating_income), unit: '元', status: statusOf(it.operating_income, base), raw: it });
        ev.push({ ...common, field: 'parent_holder_net_profit', label: `${nm} FY${it.fiscal_year} 归母净利润`, value: toNum(it.parent_holder_net_profit), unit: '元', status: statusOf(it.parent_holder_net_profit, base) });
        ev.push({ ...common, field: 'basic_eps', label: `${nm} FY${it.fiscal_year} 基本EPS`, value: toNum(it.basic_eps), unit: '元/股', status: statusOf(it.basic_eps, base) });
      }
      if (!items.length) ev.push({ source: src(path), endpoint: path, entity: code, entityName: nm, field: 'item', label: `${nm} 利润表`, value: null, status: 'missing', asOf: null });
      return { data: { items }, apiCalls: 1, summary: `${nm} 利润表 ${items.length} 期（${items.map((i) => 'FY' + i.fiscal_year).join('/')}）`, evidence: ev };
    },
  });

  const indicatorRun = (prev: boolean) => async (a: Record<string, unknown>, ctx: ToolContext) => {
    const path = '/api/a-share/financials/indicators';
    const code = String(a.thscode);
    let report = String(a.report ?? latestAnnualReport(ctx.now()).report);
    if (prev) report = `${Number(report.slice(0, 4)) - 1}-4`;
    const env = await d.fuyao.get(path, { thscode: code, report }, { signal: ctx.signal, fault: prev ? undefined : ctx.fault, attempt: ctx.attempt });
    const nm = nameOf(ctx, code);
    const base = d.fuyao.mode === 'demo' ? 'demo' : 'ok';
    const want: [string, string, string][] = [
      ['operating_income_yoy_growth_ratio', '营业收入同比增长率', '%'],
      ['net_profit_yoy_growth_ratio', '净利润同比增长率', '%'],
      ['sale_gross_margin', '销售毛利率', '%'],
      ['sale_net_interest_ratio', '销售净利率', '%'],
      ['index_weighted_avg_roe', '净资产收益率(加权)', '%'],
      ['assets_debt_ratio', '资产负债率', '%'],
      ['current_ratio', '流动比率', '倍'],
    ];
    const all = new Map<string, string | null>();
    for (const ab of env.data?.abilities ?? []) for (const ind of ab.indicators ?? []) all.set(ind.index_id, ind.value);
    if (!all.size) throw new ToolError(`财务指标为空（${report}）`, 'no_data', false, 3001);
    const ev: EvidenceDraft[] = want.map(([f, label, unit]) => {
      const v = toNum(all.get(f));
      return { source: src(path), endpoint: path, params: { thscode: code, report }, entity: code, entityName: nm, field: f, label: `${nm} ${label}`, value: v === null ? null : +v.toFixed(2), unit, caliber: `报告期 ${report}${prev ? '（降级：上一期年报）' : ''}`, asOf: null, status: statusOf(v, base), note: v === null ? '上游为 null：该行业可能不适用此指标，或数据缺失' : undefined };
    });
    return { data: { report, values: Object.fromEntries(all) }, apiCalls: 1, summary: `${nm} 财务指标（${report}）${ev.filter((e) => e.status === 'missing').length} 项缺失`, evidence: ev, degradedNote: prev ? `最新报告期无数据 → 降级使用 ${report}` : undefined };
  };
  r.register({
    name: 'financial_indicators',
    title: '财务指标',
    capability: '财务',
    source: 'fuyao',
    endpoint: '/api/a-share/financials/indicators',
    description: '成长/盈利/偿债/营运/现金流五类指标（单报告期）',
    permission: 'read',
    validate: (a) => (codeRe.test(String(a.thscode)) && /^\d{4}-[1-4]$/.test(String(a.report)) ? null : 'thscode 或 report(yyyy-1..4) 格式错误'),
    timeoutMs: 8000,
    maxRetries: 2,
    cacheTtlMs: 24 * 3600e3,
    estCalls: 1,
    fallbackTool: 'financial_indicators_prev',
    run: indicatorRun(false),
  });
  r.register({
    name: 'financial_indicators_prev',
    title: '财务指标（上一期降级）',
    capability: '财务',
    source: 'fuyao',
    endpoint: '/api/a-share/financials/indicators',
    description: '最新报告期无数据时，回退到上一期年报',
    permission: 'read',
    timeoutMs: 8000,
    maxRetries: 1,
    cacheTtlMs: 24 * 3600e3,
    estCalls: 1,
    run: indicatorRun(true),
  });

  // ---------------- 板块/指数 ----------------
  r.register({
    name: 'stock_sectors',
    title: '行业/概念归属',
    capability: '板块/指数',
    source: 'fuyao',
    endpoint: '/api/a-share-index/constituents/ths-index-list-by-stock',
    description: '个股所属同花顺行业/概念/地域/特色指数（批量）',
    permission: 'read',
    validate: reqCodes('thscodes'),
    timeoutMs: 8000,
    maxRetries: 2,
    cacheTtlMs: 24 * 3600e3,
    estCalls: 1,
    async run(a, ctx) {
      const path = '/api/a-share-index/constituents/ths-index-list-by-stock';
      const env = await d.fuyao.get(path, { thscode: String(a.thscodes) }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const items = (env.data?.item ?? []) as any[];
      const base = d.fuyao.mode === 'demo' ? 'demo' : 'ok';
      const ev: EvidenceDraft[] = String(a.thscodes)
        .split(',')
        .map((code) => {
          const it = items.find((x) => x.thscode === code);
          const list = (it?.index_list ?? []) as any[];
          const nm = nameOf(ctx, code);
          const ind = list.filter((x) => x.type === 'industry').map((x) => x.name);
          const con = list.filter((x) => x.type === 'cn_concept').map((x) => x.name);
          return { source: src(path), endpoint: path, entity: code, entityName: nm, field: 'index_list', label: `${nm} 所属行业/概念`, value: list.length ? `行业：${ind.join('、') || '—'}；概念：${con.slice(0, 5).join('、') || '—'}` : null, asOf: env.data?.timestamp ?? null, status: list.length ? base : 'missing', raw: list.slice(0, 10) } as EvidenceDraft;
        });
      return { data: { items }, apiCalls: 1, summary: `行业/概念归属 ${items.length} 只`, evidence: ev };
    },
  });

  r.register({
    name: 'index_constituents',
    title: '指数/板块成分股',
    capability: '板块/指数',
    source: 'fuyao',
    endpoint: '/api/a-share-index/constituents/ths-stock-list',
    description: '同花顺指数/板块成分股列表',
    permission: 'read',
    validate: reqStr('thscode'),
    timeoutMs: 8000,
    maxRetries: 2,
    cacheTtlMs: 24 * 3600e3,
    estCalls: 1,
    async run(a, ctx) {
      const path = '/api/a-share-index/constituents/ths-stock-list';
      const env = await d.fuyao.get(path, { thscode: String(a.thscode) }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const items = (env.data?.item ?? []) as any[];
      ctx.run.entities = items.slice(0, 10).map((i) => ({ thscode: i.thscode, name: i.name }));
      return {
        data: { items, name: a.name },
        apiCalls: 1,
        summary: `「${a.name}」成分股 ${items.length} 只`,
        evidence: [{ source: src(path), endpoint: path, params: a, entity: String(a.thscode), entityName: String(a.name), field: 'item.length', label: `「${a.name}」成分股数量`, value: items.length || null, unit: '只', asOf: env.data?.timestamp ?? null, status: items.length ? (d.fuyao.mode === 'demo' ? 'demo' : 'ok') : 'missing', raw: items.slice(0, 10) }],
      };
    },
  });

  // ---------------- 市场情绪 ----------------
  r.register({
    name: 'limit_up_stats',
    title: '涨停市场统计',
    capability: '市场情绪',
    source: 'fuyao',
    endpoint: '/api/a-share/special-data/limit-up-statistics',
    description: '封板率、涨停家数、炸板家数、连板档位',
    permission: 'read',
    timeoutMs: 8000,
    maxRetries: 2,
    cacheTtlMs: 300e3,
    estCalls: 1,
    async run(a, ctx) {
      const path = '/api/a-share/special-data/limit-up-statistics';
      const env = await d.fuyao.get(path, { date: a.date as string | undefined }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const x = env.data ?? {};
      const asOf = x.timestamp ?? null;
      const base = freshness(asOf, d.fuyao.mode, ctx.now(), 4 * DAY);
      const cal = `交易日 ${x.trade_date ?? '未知'}`;
      const common = { source: src(path), endpoint: path, asOf, caliber: cal };
      const seal = toNum(x.seal_rate);
      return {
        data: x,
        apiCalls: 1,
        summary: `涨停统计（${x.trade_date ?? '?'}）：封板 ${x.limit_up_stock_count ?? '—'} 家，炸板 ${x.open_stock_count ?? '—'} 家`,
        evidence: [
          { ...common, field: 'limit_up_stock_count', label: '涨停封板家数', value: toNum(x.limit_up_stock_count), unit: '家', status: statusOf(x.limit_up_stock_count, base), raw: x },
          { ...common, field: 'open_stock_count', label: '涨停打开（炸板）家数', value: toNum(x.open_stock_count), unit: '家', status: statusOf(x.open_stock_count, base) },
          { ...common, field: 'seal_rate', label: '封板率', value: seal === null ? null : +(seal * 100).toFixed(1), unit: '%', status: statusOf(seal, base), note: '原始字段为小数比例，已×100 展示' },
        ],
      };
    },
  });

  r.register({
    name: 'hot_stock_list',
    title: '同花顺热股榜',
    capability: '市场情绪',
    source: 'fuyao',
    endpoint: '/api/a-share/special-data/hot-stock-list',
    description: 'A 股热股排行（24h）',
    permission: 'read',
    timeoutMs: 8000,
    maxRetries: 2,
    cacheTtlMs: 300e3,
    estCalls: 1,
    async run(a, ctx) {
      const path = '/api/a-share/special-data/hot-stock-list';
      const env = await d.fuyao.get(path, { period: 'day', limit: Number(a.limit ?? 10) }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const items = (env.data?.item ?? []) as any[];
      const asOf = env.data?.timestamp ?? null;
      const base = freshness(asOf, d.fuyao.mode, ctx.now(), 2 * DAY);
      return {
        data: { items },
        apiCalls: 1,
        summary: `热股榜前 ${items.length}：${items.slice(0, 5).map((i) => i.name).join('、')}`,
        evidence: [{ source: src(path), endpoint: path, field: 'item[].name', label: '热股榜前五', value: items.length ? items.slice(0, 5).map((i) => `${i.rank ?? ''}.${i.name}`).join(' ') : null, asOf, status: items.length ? base : 'missing', caliber: '24小时热度排名（关注度，不代表涨跌）', raw: items.slice(0, 10) }],
      };
    },
  });

  // ---------------- 资讯（iFinD 优先，扶摇快讯降级） ----------------
  r.register({
    name: 'news_search',
    title: '资讯检索（iFinD）',
    capability: '资讯',
    source: 'ifind',
    endpoint: 'MCP search_news',
    description: '按主题检索财经资讯片段（iFinD MCP），失败降级为扶摇快讯',
    permission: 'read',
    validate: reqStr('query'),
    timeoutMs: 12000,
    maxRetries: 1,
    cacheTtlMs: 600e3,
    estCalls: 1,
    fallbackTool: 'news_flash',
    async run(a, ctx) {
      if (d.ifind.mode === 'live' && !d.ifind.available()) throw new ToolError('未配置 iFinD MCP', 'unavailable', false);
      const res = await d.ifind.callTool('search_news', { query: String(a.query) }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const demo = d.ifind.mode === 'demo';
      const ev: EvidenceDraft[] = res.items.slice(0, 5).map((it, i) => ({
        source: demo ? 'iFinD MCP search_news（演示占位）' : 'iFinD MCP search_news',
        endpoint: 'search_news',
        params: { query: a.query },
        entity: a.thscode as string | undefined,
        field: `result[${i}]`,
        label: it.title,
        value: demo ? null : it.summary,
        asOf: it.time ?? res.asOf,
        status: demo ? 'missing' : 'ok',
        note: demo ? '演示模式不提供真实资讯，接入 iFinD 后可回溯原文' : undefined,
      }));
      if (!ev.length) ev.push({ source: 'iFinD MCP search_news', field: 'result', label: `「${a.query}」资讯`, value: null, status: 'missing', asOf: null });
      return { data: { items: res.items }, apiCalls: 1, summary: demo ? '资讯：演示模式仅返回占位（视为缺失）' : `资讯 ${res.items.length} 条`, evidence: ev };
    },
  });

  r.register({
    name: 'news_flash',
    title: '快讯（扶摇降级）',
    capability: '资讯',
    source: 'fuyao',
    endpoint: '/api/news/flash/list',
    description: '扶摇快讯列表（资讯检索失败时的降级源）',
    permission: 'read',
    timeoutMs: 8000,
    maxRetries: 1,
    cacheTtlMs: 300e3,
    estCalls: 1,
    async run(a, ctx) {
      const path = '/api/news/flash/list';
      const env = await d.fuyao.get(path, { tag_id: 21103, seq: '0' }, { signal: ctx.signal, attempt: ctx.attempt });
      const items = (env.data?.items ?? []) as any[];
      const demo = d.fuyao.mode === 'demo';
      const q = String(a.query ?? '');
      const rel = items.filter((i) => !q || `${i.title}${i.summary}`.includes(q.split(' ')[0]));
      const use = (rel.length ? rel : items).slice(0, 5);
      const ev: EvidenceDraft[] = use.map((it, i) => ({ source: src(path), endpoint: path, field: `items[${i}]`, label: it.title, value: demo ? null : it.summary ?? it.title, asOf: it.create_time_ms ?? null, status: demo ? 'missing' : 'ok', note: demo ? '演示占位' : rel.length ? undefined : '未找到与主题直接相关的快讯，展示最新快讯' }));
      return { data: { items: use }, apiCalls: 1, summary: `快讯 ${use.length} 条（降级源）`, evidence: ev.length ? ev : [{ source: src(path), field: 'items', label: '快讯', value: null, status: 'missing', asOf: null }], degradedNote: 'iFinD 资讯不可用 → 降级为扶摇快讯' };
    },
  });

  r.register({
    name: 'macro_indicator',
    title: '宏观指标（iFinD）',
    capability: '宏观',
    source: 'ifind',
    endpoint: 'MCP get_edb_data',
    description: '宏观/行业经济指标取数（iFinD EDB）',
    permission: 'read',
    validate: reqStr('query'),
    timeoutMs: 12000,
    maxRetries: 1,
    cacheTtlMs: 3600e3,
    estCalls: 1,
    async run(a, ctx) {
      if (d.ifind.mode === 'live' && !d.ifind.available()) throw new ToolError('未配置 iFinD MCP', 'unavailable', false);
      const res = await d.ifind.callTool('get_edb_data', { query: String(a.query) }, { signal: ctx.signal, fault: ctx.fault, attempt: ctx.attempt });
      const demo = d.ifind.mode === 'demo';
      return { data: res, apiCalls: 1, summary: demo ? '宏观：演示模式无真实数值（视为缺失）' : `宏观指标已返回`, evidence: [{ source: 'iFinD MCP get_edb_data', field: 'text', label: `宏观指标「${a.query}」`, value: demo ? null : res.text.slice(0, 200), asOf: res.asOf, status: demo || !res.text ? 'missing' : 'ok', note: demo ? '演示模式不编造宏观数值' : undefined }] };
    },
  });

  // ---------------- 用户状态（记忆） ----------------
  r.register({
    name: 'read_portfolio',
    title: '读取模拟持仓',
    capability: '用户状态',
    source: 'memory',
    description: '读取长期记忆中的（构造、匿名）持仓，属于敏感信息，需要用户授权',
    permission: 'sensitive_read',
    timeoutMs: 2000,
    maxRetries: 0,
    cacheTtlMs: 0,
    estCalls: 0,
    async run() {
      const holdings = d.memory.holdings();
      return {
        data: { holdings },
        summary: `读取持仓 ${holdings.length} 项（构造匿名数据）`,
        evidence: holdings.map((h) => ({ source: '本地长期记忆（构造匿名持仓）', field: 'weight', label: `${h.name} 持仓权重`, value: h.weight, unit: '%', entity: h.thscode === 'CASH' ? undefined : h.thscode, entityName: h.name, asOf: null, status: 'ok' as EvidenceStatus, caliber: '用户自报权重（构造）' })),
      };
    },
  });

  r.register({
    name: 'save_memory',
    title: '写入研究笔记',
    capability: '用户状态',
    source: 'memory',
    description: '把本次研究的关键事实（含证据时点）写入长期记忆，供后续研究复用；写操作需要确认',
    permission: 'write',
    timeoutMs: 2000,
    maxRetries: 0,
    cacheTtlMs: 0,
    estCalls: 0,
    async run(_a, ctx) {
      const rep = ctx.run.artifacts[ctx.run.artifacts.length - 1];
      if (!rep) throw new ToolError('没有可写入的报告', 'no_data', false);
      const facts = rep.blocks.flatMap((b) => (b.type === 'claims' ? b.items : [])).filter((c) => c.kind === 'fact').slice(0, 4);
      const saved = ctx.run.entities.slice(0, 4).map((e) =>
        d.memory.upsert({
          kind: 'research_note',
          title: `${e.name} 研究笔记`,
          entity: e.thscode,
          sensitive: false,
          sourceRunId: ctx.run.id,
          content: `${fmtDate(ctx.now())}（${ctx.run.dataMode === 'demo' ? '演示数据' : '实时数据'}）：${facts.map((f) => f.text.replace(/\s*\[E-\d+\]/g, '')).join('；').slice(0, 300)}`,
        }),
      );
      return { data: { saved: saved.map((s) => s.id) }, summary: `已写入 ${saved.length} 条研究笔记`, evidence: [] };
    },
  });

  // ---------------- 本地计算与产物 ----------------
  r.register({
    name: 'compute_metrics',
    title: '衍生指标与一致性校验',
    capability: '本地计算',
    source: 'local',
    description: '区间涨跌/波动率/回撤、同比与利润率、集中度；交叉校验报表与指标是否冲突',
    permission: 'read',
    timeoutMs: 5000,
    maxRetries: 0,
    cacheTtlMs: 0,
    estCalls: 0,
    async run(a, ctx) {
      return computeMetrics(String(a.mode), ctx);
    },
  });

  r.register({
    name: 'compose_report',
    title: '撰写研究报告',
    capability: '产物',
    source: 'local',
    description: '生成带证据引用的报告：事实/推断/不确定分级、数据质量、口径说明、合规审查',
    permission: 'read',
    timeoutMs: 40000,
    maxRetries: 0,
    cacheTtlMs: 0,
    estCalls: 0,
    async run(a, ctx) {
      return composeReport(String(a.mode), ctx, d.llm);
    },
  });

  return r;
}
