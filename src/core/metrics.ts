// 本地计算：所有衍生指标都记录公式与来源证据 ID（derivedFrom），并做跨接口一致性校验
import { Evidence, EvidenceDraft, RunState, ToolContext, ToolResult } from './types';

const short = (code: string) => code.replace('.', '');

export function findEv(run: RunState, field: string, entity?: string): Evidence | undefined {
  // 取最新一条（重跑/恢复后以最后一次为准）
  for (let i = run.evidence.length - 1; i >= 0; i--) {
    const e = run.evidence[i];
    if (e.field === field && (entity === undefined || e.entity === entity)) return e;
  }
  return undefined;
}

function out(ctx: ToolContext, ...ids: string[]): any {
  for (const id of ids) if (ctx.outputs[id] !== undefined) return ctx.outputs[id];
  return undefined;
}

function num(e?: Evidence): number | null {
  return e && typeof e.value === 'number' && e.status !== 'missing' && e.status !== 'error' ? e.value : null;
}

export interface StockMetrics {
  thscode: string;
  name: string;
  ret1y?: number | null;
  vol?: number | null;
  mdd?: number | null;
  revYoy?: number | null;
  npYoy?: number | null;
  netMargin?: number | null;
  revCagr?: number | null;
  peStatic?: number | null;
  conflict?: string;
  series?: [number, number][];
  fyLabels?: string[];
}

function d(label: string, field: string, entity: { thscode: string; name: string } | undefined, value: number | null, unit: string, formula: string, from: (Evidence | undefined)[], caliber: string, note?: string): EvidenceDraft {
  const ids = from.filter(Boolean).map((e) => e!.id);
  const missing = value === null || !Number.isFinite(value);
  return {
    source: '本地计算',
    field,
    label: entity ? `${entity.name} ${label}` : label,
    entity: entity?.thscode,
    entityName: entity?.name,
    value: missing ? null : +value!.toFixed(2),
    unit,
    formula,
    derivedFrom: ids,
    caliber,
    asOf: from.reduce<number | null>((m, e) => (e?.asOf && (!m || e.asOf > m) ? e.asOf : m), null),
    status: missing ? 'missing' : 'derived',
    note: missing ? note ?? '计算所需输入缺失' : note,
  };
}

function stockMetrics(ctx: ToolContext, ent: { thscode: string; name: string }, ev: EvidenceDraft[]): StockMetrics {
  const run = ctx.run;
  const c = ent.thscode;
  const m: StockMetrics = { thscode: c, name: ent.name };
  // ---- 行情：区间涨跌 / 年化波动 / 最大回撤 ----
  const hist = out(ctx, `t_hist_${short(c)}`, 't_hist');
  const bars: { t: number; c: number }[] = hist?.bars ?? [];
  const eFirst = findEv(run, 'close_price[first]', c);
  const eLast = findEv(run, 'close_price[last]', c);
  if (bars.length >= 20) {
    const closes = bars.map((b) => b.c);
    m.series = bars.map((b) => [b.t, b.c]);
    m.ret1y = (closes[closes.length - 1] / closes[0] - 1) * 100;
    const rets = closes.slice(1).map((x, i) => Math.log(x / closes[i]));
    const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
    const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
    m.vol = sd * Math.sqrt(242) * 100;
    let peak = closes[0];
    let mdd = 0;
    for (const x of closes) {
      peak = Math.max(peak, x);
      mdd = Math.min(mdd, x / peak - 1);
    }
    m.mdd = mdd * 100;
  }
  const histCal = `日K前复权，${bars.length} 根`;
  ev.push(d('区间涨跌幅', 'ret_period', ent, m.ret1y ?? null, '%', '末日收盘 / 首日收盘 − 1', [eFirst, eLast], histCal));
  ev.push(d('年化波动率', 'vol_annual', ent, m.vol ?? null, '%', 'std(日对数收益) × √242', [eFirst, eLast], histCal));
  ev.push(d('区间最大回撤', 'max_drawdown', ent, m.mdd ?? null, '%', 'min(收盘 / 历史峰值 − 1)', [eFirst, eLast], histCal));

  // ---- 财务：同比 / 净利率 / CAGR ----
  const inc = out(ctx, `t_inc_${short(c)}`, 't_inc');
  const items: any[] = (inc?.items ?? []).slice().sort((x: any, y: any) => x.fiscal_year - y.fiscal_year);
  m.fyLabels = items.map((i) => `FY${i.fiscal_year}`);
  const evRev = run.evidence.filter((e) => e.entity === c && e.field === 'operating_income');
  const evNp = run.evidence.filter((e) => e.entity === c && e.field === 'parent_holder_net_profit');
  if (items.length >= 2) {
    const a = items[items.length - 1];
    const b = items[items.length - 2];
    const fy = `FY${a.fiscal_year} vs FY${b.fiscal_year}`;
    m.revYoy = b.operating_income ? (a.operating_income / b.operating_income - 1) * 100 : null;
    m.npYoy = b.parent_holder_net_profit ? (a.parent_holder_net_profit / Math.abs(b.parent_holder_net_profit) - 1) * 100 : null;
    m.netMargin = a.operating_income ? (a.parent_holder_net_profit / a.operating_income) * 100 : null;
    ev.push(d('营业收入同比（报表推算）', 'rev_yoy_calc', ent, m.revYoy, '%', '本期营业收入 / 上期 − 1', evRev.slice(-2), `年报 ${fy}`));
    ev.push(d('归母净利润同比（报表推算）', 'np_yoy_calc', ent, m.npYoy, '%', '本期归母净利润 / |上期| − 1', evNp.slice(-2), `年报 ${fy}`));
    ev.push(d('归母净利率', 'net_margin_calc', ent, m.netMargin, '%', '归母净利润 / 营业收入', [evRev[evRev.length - 1], evNp[evNp.length - 1]], `年报 FY${a.fiscal_year}`));
    if (items.length >= 3) {
      const first = items[0];
      const n = items.length - 1;
      m.revCagr = first.operating_income > 0 ? ((a.operating_income / first.operating_income) ** (1 / n) - 1) * 100 : null;
      ev.push(d(`营收 ${n} 年复合增速`, 'rev_cagr_calc', ent, m.revCagr, '%', `(末期/首期)^(1/${n}) − 1`, [evRev[0], evRev[evRev.length - 1]], `年报 FY${first.fiscal_year}~FY${a.fiscal_year}`));
    }
    // ---- 一致性校验：报表推算 vs 指标接口 ----
    const eInd = findEv(run, 'net_profit_yoy_growth_ratio', c);
    const vInd = num(eInd);
    if (eInd && vInd !== null && m.npYoy !== null && m.npYoy !== undefined) {
      const indReport = String((eInd.params as any)?.report ?? '');
      const sameYear = indReport.startsWith(String(a.fiscal_year));
      const diff = Math.abs(vInd - m.npYoy);
      if (sameYear && diff > 2) {
        m.conflict = `净利润同比：指标接口 ${vInd.toFixed(2)}% vs 利润表推算 ${m.npYoy.toFixed(2)}%（差 ${diff.toFixed(1)} 个百分点）`;
        eInd.status = 'conflict';
        eInd.note = `与利润表推算值不一致（${m.npYoy.toFixed(2)}%）；可能口径不同（净利润 vs 归母净利润）或数据错误，需回查原始报表`;
        const calc = ev.find((x) => x.field === 'np_yoy_calc' && x.entity === c);
        if (calc) {
          calc.status = 'conflict';
          calc.note = '与指标接口值冲突，见一致性校验';
        }
      } else if (!sameYear) {
        eInd.note = `指标报告期 ${indReport} 与利润表最新期 FY${a.fiscal_year} 不一致，未做交叉校验`;
      }
    }
  } else {
    ev.push(d('营业收入同比（报表推算）', 'rev_yoy_calc', ent, null, '%', '本期 / 上期 − 1', [], '年报', '利润表期数不足 2 期'));
  }

  // ---- 估值口径对照：静态 PE ----
  const ePx = findEv(run, 'last_price', c);
  const eEps = run.evidence.filter((e) => e.entity === c && e.field === 'basic_eps').slice(-1)[0];
  const px = num(ePx);
  const eps = num(eEps);
  m.peStatic = px !== null && eps ? px / eps : null;
  ev.push(d('静态市盈率', 'pe_static_calc', ent, m.peStatic ?? null, '倍', '最新价 / 最近年报基本EPS', [ePx, eEps], `最新价 + ${eEps?.caliber ?? '年报'}`, eps !== null && eps <= 0 ? 'EPS ≤ 0，静态PE无意义' : undefined));
  return m;
}

export async function computeMetrics(mode: string, ctx: ToolContext): Promise<ToolResult> {
  const run = ctx.run;
  const ev: EvidenceDraft[] = [];
  if (mode === 'stock' || mode === 'compare') {
    const list = mode === 'stock' ? run.entities.slice(0, 1) : run.entities.slice(0, 4);
    const metrics = list.map((e) => stockMetrics(ctx, e, ev));
    const conflicts = metrics.filter((m) => m.conflict).map((m) => `${m.name}：${m.conflict}`);
    return { data: { mode, metrics, conflicts }, summary: `计算衍生指标 ${ev.length} 项${conflicts.length ? `；发现 ${conflicts.length} 处数据冲突` : '；未发现冲突'}`, evidence: ev };
  }
  if (mode === 'market') {
    const idx = run.evidence.filter((e) => e.tool === 'index_snapshot' && e.field === 'price_change_ratio_pct');
    const vals = idx.map((e) => num(e)).filter((v): v is number => v !== null);
    const up = vals.filter((v) => v > 0).length;
    const avg = vals.length ? vals.reduce((s, x) => s + x, 0) / vals.length : null;
    ev.push(d('主要指数平均涨跌幅', 'index_avg_pct', undefined, avg, '%', `mean(${idx.length} 个指数涨跌幅)`, idx, '指数快照等权平均'));
    ev.push(d('主要指数上涨个数', 'index_up_count', undefined, vals.length ? up : null, '个', `count(涨跌幅>0)/${vals.length}`, idx, '指数快照'));
    const eUp = findEv(run, 'limit_up_stock_count');
    const eOpen = findEv(run, 'open_stock_count');
    const u = num(eUp);
    const o = num(eOpen);
    ev.push(d('炸板率', 'break_rate_calc', undefined, u !== null && o !== null && u + o > 0 ? (o / (u + o)) * 100 : null, '%', '炸板家数 / (封板 + 炸板)', [eUp, eOpen], eUp?.caliber ?? '涨停统计'));
    return { data: { mode, up, total: vals.length, avg }, summary: `市场指标：${vals.length} 个指数中 ${up} 个上涨`, evidence: ev };
  }
  if (mode === 'portfolio') {
    const hold: { thscode: string; name: string; weight: number }[] = (out(ctx, 't_holdings')?.holdings ?? []) as any[];
    const eq = hold.filter((h) => h.thscode !== 'CASH');
    const ws = hold.map((h) => h.weight / 100);
    const sorted = [...eq].sort((a, b) => b.weight - a.weight);
    const wEv = run.evidence.filter((e) => e.tool === 'read_portfolio');
    const hhi = ws.reduce((s, w) => s + w * w, 0);
    ev.push(d('第一大持仓权重', 'top1_weight', undefined, sorted[0]?.weight ?? null, '%', 'max(权重)', wEv, '用户自报权重（构造）', sorted[0] ? sorted[0].name : undefined));
    ev.push(d('前三大持仓合计', 'top3_weight', undefined, sorted.slice(0, 3).reduce((s, h) => s + h.weight, 0), '%', 'sum(前三权重)', wEv, '用户自报权重（构造）'));
    ev.push(d('集中度 HHI', 'hhi', undefined, hhi * 10000, '', 'Σ(权重²)×10000，含现金', wEv, '0~10000，越高越集中'));
    // 当日组合涨跌贡献
    let contrib = 0;
    const used: Evidence[] = [];
    const missingPx: string[] = [];
    for (const h of eq) {
      const e = findEv(run, 'price_change_ratio_pct', h.thscode);
      const v = num(e);
      if (v === null) missingPx.push(h.name);
      else {
        contrib += (h.weight / 100) * v;
        used.push(e!);
      }
    }
    ev.push(d('当日组合加权涨跌（已知部分）', 'pf_day_pct', undefined, used.length ? contrib : null, '%', 'Σ 权重 × 个股涨跌幅（缺失项按 0 计且单列）', used, '行情快照', missingPx.length ? `缺失行情：${missingPx.join('、')}` : undefined));
    // 调和加权 PE
    let wsum = 0;
    let inv = 0;
    const peUsed: Evidence[] = [];
    const peMissing: string[] = [];
    for (const h of eq) {
      const e = findEv(run, 'pe_ttm', h.thscode);
      const v = num(e);
      if (v === null || v <= 0) peMissing.push(h.name);
      else {
        wsum += h.weight;
        inv += h.weight / v;
        peUsed.push(e!);
      }
    }
    ev.push(d('持仓调和加权 PE(TTM)', 'pf_pe_harmonic', undefined, inv > 0 ? wsum / inv : null, '倍', 'Σw / Σ(w/PE)，剔除 PE 缺失或为负', peUsed, 'TTM', peMissing.length ? `未纳入：${peMissing.join('、')}` : undefined));
    // 行业暴露
    const sectorW = new Map<string, number>();
    for (const h of eq) {
      const e = findEv(run, 'index_list', h.thscode);
      const ind = ((e?.raw as any[]) ?? []).find((x) => x.type === 'industry')?.name ?? '未知行业';
      sectorW.set(ind, (sectorW.get(ind) ?? 0) + h.weight);
    }
    return { data: { mode, holdings: hold, sectors: [...sectorW.entries()].map(([k, v]) => ({ name: k, weight: v })), missingPx, peMissing }, summary: `持仓指标：HHI ${(hhi * 10000).toFixed(0)}，行业 ${sectorW.size} 个`, evidence: ev };
  }
  if (mode === 'sector') {
    const pcts = run.evidence.filter((e) => e.tool === 'price_snapshot' && e.field === 'price_change_ratio_pct');
    const vals = pcts.map((e) => num(e)).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const med = vals.length ? vals[Math.floor(vals.length / 2)] : null;
    ev.push(d('成分股上涨家数', 'sector_up', undefined, vals.length ? vals.filter((v) => v > 0).length : null, '家', `count(涨跌幅>0)/${vals.length}`, pcts, '成分股行情快照（前 10 只）'));
    ev.push(d('成分股涨跌幅中位数', 'sector_median_pct', undefined, med, '%', 'median(涨跌幅)', pcts, '成分股行情快照（前 10 只）'));
    const pes = run.evidence.filter((e) => e.field === 'pe_ttm');
    const pv = pes.map((e) => num(e)).filter((v): v is number => v !== null && v > 0).sort((a, b) => a - b);
    ev.push(d('成分股 PE(TTM) 中位数', 'sector_pe_median', undefined, pv.length ? pv[Math.floor(pv.length / 2)] : null, '倍', 'median(PE_TTM>0)', pes, 'TTM，剔除负值/缺失'));
    return { data: { mode, n: vals.length }, summary: `板块指标：样本 ${vals.length} 只`, evidence: ev };
  }
  return { data: { mode }, summary: '无需计算', evidence: [] };
}
