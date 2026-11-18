// 报告生成：结论分级（事实/推断/不确定）+ 证据引用 + 数据质量 + 合规审查 + 可选 LLM 摘要（需通过数值校验）
import { DISCLAIMER, gradeClaims, guardOutput } from './compliance';
import { ContextManager } from './context';
import { LlmClient } from './llm';
import { findEv, StockMetrics } from './metrics';
import { Artifact, Claim, Evidence, RunState, ToolContext, ToolResult, UIBlock } from './types';
import { fmtDate, fmtNum, uid } from './util';

const yi = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${(v / 1e8).toFixed(2)} 亿元`);
const pct = (v: number | null | undefined, sign = true) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${sign && v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const val = (e?: Evidence) => (e && typeof e.value === 'number' && !['missing', 'error'].includes(e.status) ? e.value : null);
const ids = (...es: (Evidence | undefined)[]) => es.filter(Boolean).map((e) => e!.id);
const cite = (...es: (Evidence | undefined)[]) => {
  const x = ids(...es);
  return x.length ? ` [${x.join(', ')}]` : '';
};

function qualityBlock(run: RunState): UIBlock {
  const items: { evidenceId?: string; status: Evidence['status']; text: string }[] = [];
  for (const e of run.evidence) {
    if (['missing', 'stale', 'conflict', 'error'].includes(e.status)) {
      items.push({ evidenceId: e.id, status: e.status, text: `${e.label}：${e.status === 'missing' ? '缺失' : e.status === 'stale' ? `数据过期（时点 ${fmtDate(e.asOf)}）` : e.status === 'conflict' ? '数据冲突' : '调用失败'}${e.note ? ` — ${e.note}` : ''}` });
    }
  }
  for (const t of run.plan) {
    if (t.status === 'failed') items.push({ status: 'error', text: `任务「${t.title}」失败：${t.error ?? '未知错误'}` });
    if (t.status === 'degraded') items.push({ status: 'stale', text: `任务「${t.title}」降级：${t.degradedNote ?? ''}` });
    if (t.status === 'skipped') items.push({ status: 'missing', text: `任务「${t.title}」未执行：${t.error ?? '前置依赖失败或用户拒绝'}` });
  }
  if (!items.length) items.push({ status: 'ok', text: '本次运行未发现缺失、过期、冲突或失败的数据项。' });
  return { type: 'quality', title: '数据质量与降级记录', items };
}

function headerNotices(run: RunState): UIBlock[] {
  const out: UIBlock[] = [];
  if (run.dataMode === 'demo') out.push({ type: 'notice', level: 'warn', text: '演示模式：全部行情/财务/估值为人工构造的样例数据（结构对齐扶摇 API），仅用于演示 Agent 流程，不代表真实市场。' });
  for (const c of run.compliance) out.push({ type: 'notice', level: 'info', text: c });
  if (run.status === 'stopped' || run.stopReason) out.push({ type: 'notice', level: 'warn', text: `部分结果：运行因「${run.stopReason ?? '停止'}」提前结束，以下仅基于已获取的证据。` });
  return out;
}

// ---------------- 个股 ----------------
function stockReport(run: RunState, m: StockMetrics, conflicts: string[]): { blocks: UIBlock[]; claims: Claim[] } {
  const c = m.thscode;
  const ePx = findEv(run, 'last_price', c);
  const ePct = findEv(run, 'price_change_ratio_pct', c);
  const ePe = findEv(run, 'pe_ttm', c);
  const ePb = findEv(run, 'pb_mrq', c);
  const ePeStaticFb = findEv(run, 'pe_static', c);
  const eRet = findEv(run, 'ret_period', c);
  const eVol = findEv(run, 'vol_annual', c);
  const eMdd = findEv(run, 'max_drawdown', c);
  const eMargin = findEv(run, 'net_margin_calc', c);
  const eRoe = findEv(run, 'index_weighted_avg_roe', c);
  const eGross = findEv(run, 'sale_gross_margin', c);
  const eDebt = findEv(run, 'assets_debt_ratio', c);
  const eRevY = findEv(run, 'rev_yoy_calc', c);
  const eNpY = findEv(run, 'np_yoy_calc', c);
  const eNpYInd = findEv(run, 'net_profit_yoy_growth_ratio', c);
  const eCagr = findEv(run, 'rev_cagr_calc', c);
  const ePeS = findEv(run, 'pe_static_calc', c);
  const eSec = findEv(run, 'index_list', c);
  const revs = run.evidence.filter((e) => e.entity === c && e.field === 'operating_income');
  const nps = run.evidence.filter((e) => e.entity === c && e.field === 'parent_holder_net_profit');
  const epss = run.evidence.filter((e) => e.entity === c && e.field === 'basic_eps');
  const pctV = val(ePct);
  const blocks: UIBlock[] = [
    {
      type: 'kpis',
      title: `${m.name}（${c}）关键数据`,
      items: [
        { label: '最新价', value: val(ePx), unit: '元', evidenceId: ePx?.id, status: ePx?.status, sub: pct(pctV), tone: pctV === null ? 'flat' : pctV > 0 ? 'up' : pctV < 0 ? 'down' : 'flat' },
        ePe ? { label: 'PE(TTM)', value: val(ePe), unit: '倍', evidenceId: ePe.id, status: ePe.status } : { label: '静态PE(降级)', value: val(ePeStaticFb), unit: '倍', evidenceId: ePeStaticFb?.id, status: ePeStaticFb?.status ?? 'missing' },
        { label: 'PB(MRQ)', value: val(ePb), unit: '倍', evidenceId: ePb?.id, status: ePb?.status ?? 'missing' },
        { label: '区间涨跌', value: val(eRet), unit: '%', evidenceId: eRet?.id, status: eRet?.status ?? 'missing', sub: '近一年·前复权' },
        { label: '年化波动', value: val(eVol), unit: '%', evidenceId: eVol?.id, status: eVol?.status ?? 'missing' },
        { label: '最大回撤', value: val(eMdd), unit: '%', evidenceId: eMdd?.id, status: eMdd?.status ?? 'missing' },
        { label: '归母净利率', value: val(eMargin), unit: '%', evidenceId: eMargin?.id, status: eMargin?.status ?? 'missing' },
        { label: 'ROE(加权)', value: val(eRoe), unit: '%', evidenceId: eRoe?.id, status: eRoe?.status ?? 'missing' },
      ],
    },
  ];
  if (m.series?.length) blocks.push({ type: 'line', title: `${m.name} 近一年收盘价（前复权）`, unit: '元', series: [{ name: m.name, points: m.series }], evidenceIds: ids(findEv(run, 'close_price[first]', c), findEv(run, 'close_price[last]', c)), caption: '来源：日K接口 · 口径：前复权' });
  if (revs.length)
    blocks.push({
      type: 'table',
      title: '财务摘要（合并报表·年报）',
      columns: ['报告期', '营业收入', '归母净利润', '基本EPS(元)'],
      rows: revs.map((r, i) => ({ cells: [String(r.caliber ?? '').split('·').pop() ?? '', yi(val(r)), yi(val(nps[i])), fmtNum(val(epss[i]), '', 2)], evidenceIds: [undefined, r.id, nps[i]?.id, epss[i]?.id] })),
      caption: '单位：亿元（原始字段单位为元，已换算）',
    });

  const claims: Claim[] = [];
  if (val(ePx) !== null) claims.push({ kind: 'fact', text: `${m.name} 最新价 ${fmtNum(val(ePx), '元')}，涨跌幅 ${pct(pctV)}（快照时点 ${fmtDate(ePx!.asOf, true)}）${cite(ePx, ePct)}`, evidenceIds: ids(ePx, ePct) });
  else claims.push({ kind: 'uncertain', text: `${m.name} 最新行情未获取，无法给出当前价格相关结论${cite(ePx)}`, evidenceIds: ids(ePx) });
  if (val(ePe) !== null) claims.push({ kind: 'fact', text: `PE(TTM) ${fmtNum(val(ePe), '倍')}、PB(MRQ) ${fmtNum(val(ePb), '倍')}（估值时点 ${fmtDate(ePe!.asOf)}）${cite(ePe, ePb)}`, evidenceIds: ids(ePe, ePb) });
  else if (ePeStaticFb) claims.push({ kind: 'inference', text: `估值接口不可用，降级计算静态PE约 ${fmtNum(val(ePeStaticFb), '倍')}（口径：${ePeStaticFb.caliber}，与TTM不可直接比较）${cite(ePeStaticFb)}`, evidenceIds: ids(ePeStaticFb) });
  else claims.push({ kind: 'uncertain', text: `估值数据缺失，未对估值水平下结论${cite(ePe)}`, evidenceIds: ids(ePe) });
  if (revs.length) {
    const r = revs[revs.length - 1];
    const n = nps[nps.length - 1];
    claims.push({ kind: 'fact', text: `${String(r.caliber).split('·').pop()} 营业收入 ${yi(val(r))}，归母净利润 ${yi(val(n))}${cite(r, n)}`, evidenceIds: ids(r, n) });
  } else claims.push({ kind: 'uncertain', text: '利润表数据缺失，无法评估收入与利润变化', evidenceIds: [] });
  if (val(eGross) !== null || val(eRoe) !== null || val(eDebt) !== null)
    claims.push({ kind: 'fact', text: `报告期 ${(eRoe?.params as any)?.report ?? ''}：销售毛利率 ${fmtNum(val(eGross), '%')}、ROE(加权) ${fmtNum(val(eRoe), '%')}、资产负债率 ${fmtNum(val(eDebt), '%')}${cite(eGross, eRoe, eDebt)}`, evidenceIds: ids(eGross, eRoe, eDebt).filter((id) => run.evidence.find((e) => e.id === id)?.status !== 'missing') });
  if (eSec && eSec.value) claims.push({ kind: 'fact', text: `${eSec.value}${cite(eSec)}`, evidenceIds: ids(eSec) });

  if (val(eRevY) !== null) claims.push({ kind: 'inference', text: `据利润表推算：营收同比 ${pct(val(eRevY))}，归母净利润同比 ${pct(val(eNpY))}${val(eCagr) !== null ? `，营收 ${eCagr!.label.match(/\d+ 年/)?.[0] ?? ''}复合增速 ${pct(val(eCagr))}` : ''}${cite(eRevY, eNpY, eCagr)}`, evidenceIds: ids(eRevY, eNpY, eCagr) });
  const npy = val(eNpY);
  const ry = val(eRevY);
  if (npy !== null && ry !== null) {
    const t = npy >= 0 && ry >= 0 ? '收入与利润同向增长' : npy < 0 && ry >= 0 ? '收入增长但利润下滑，利润率承压，需结合费用、减值等明细确认原因' : npy >= 0 && ry < 0 ? '收入下滑但利润增长，可能来自成本或非经常性因素，需回查报表附注' : '收入与利润同步下滑';
    claims.push({ kind: 'inference', text: `${t}${cite(eRevY, eNpY)}`, evidenceIds: ids(eRevY, eNpY) });
  }
  const mg = val(eMargin);
  if (mg !== null) claims.push({ kind: 'inference', text: `归母净利率 ${mg.toFixed(2)}%，${mg > 30 ? '盈利能力处于较高水平' : mg > 10 ? '盈利能力中等' : mg > 0 ? '利润率偏低' : '处于亏损状态'}（阈值为通用经验，行业间差异大）${cite(eMargin)}`, evidenceIds: ids(eMargin) });
  if (val(eDebt) !== null && val(eDebt)! > 70) claims.push({ kind: 'inference', text: `资产负债率 ${val(eDebt)!.toFixed(1)}% 偏高，需结合行业属性（如金融、制造业预收/应付）判断偿债压力${cite(eDebt)}`, evidenceIds: ids(eDebt) });
  if (val(eRet) !== null) claims.push({ kind: 'inference', text: `近一年区间涨跌 ${pct(val(eRet))}，年化波动 ${fmtNum(val(eVol), '%')}，最大回撤 ${fmtNum(val(eMdd), '%')}——历史波动特征不代表未来表现${cite(eRet, eVol, eMdd)}`, evidenceIds: ids(eRet, eVol, eMdd) });
  if (val(ePeS) !== null && val(ePe) !== null) claims.push({ kind: 'inference', text: `静态PE ${fmtNum(val(ePeS), '倍')} 与 PE(TTM) ${fmtNum(val(ePe), '倍')} 的差异主要来自口径（年报EPS vs 近四季度），比较时需统一口径${cite(ePeS, ePe)}`, evidenceIds: ids(ePeS, ePe) });

  for (const cf of conflicts) claims.push({ kind: 'uncertain', text: `数据冲突：${cf}。结论暂不采信冲突项，建议回查原始报表${cite(eNpYInd, eNpY)}`, evidenceIds: ids(eNpYInd, eNpY) });
  const news = run.evidence.filter((e) => (e.tool === 'news_search' || e.tool === 'news_flash') && e.entity === c);
  if (!news.length || news.every((e) => e.status === 'missing')) claims.push({ kind: 'uncertain', text: '未获取到可验证的资讯/公告原文，本报告不解释业绩或股价变动的原因', evidenceIds: ids(news[0]) });
  else for (const nv of news.filter((e) => e.status === 'ok').slice(0, 2)) claims.push({ kind: 'fact', text: `资讯（${fmtDate(nv.asOf)}）：${nv.label}${cite(nv)}`, evidenceIds: ids(nv) });
  const miss = run.evidence.filter((e) => e.entity === c && e.status === 'missing' && e.source !== '本地计算' && e.tool !== 'news_search' && e.tool !== 'news_flash');
  if (miss.length) claims.push({ kind: 'uncertain', text: `以下字段缺失，相关维度未下结论：${[...new Set(miss.map((e) => e.label.replace(m.name, '').trim()))].slice(0, 6).join('、')}${cite(...miss.slice(0, 4))}`, evidenceIds: ids(...miss.slice(0, 4)) });
  return { blocks, claims };
}

// ---------------- 对比 ----------------
function compareReport(run: RunState, ms: StockMetrics[], conflicts: string[]): { blocks: UIBlock[]; claims: Claim[] } {
  const rowsDef: [string, string, (e?: Evidence) => string][] = [
    ['最新价(元)', 'last_price', (e) => fmtNum(val(e), '', 2)],
    ['涨跌幅', 'price_change_ratio_pct', (e) => pct(val(e))],
    ['PE(TTM)', 'pe_ttm', (e) => fmtNum(val(e), '倍', 1)],
    ['PB(MRQ)', 'pb_mrq', (e) => fmtNum(val(e), '倍', 2)],
    ['营收同比(推算)', 'rev_yoy_calc', (e) => pct(val(e))],
    ['归母净利同比(推算)', 'np_yoy_calc', (e) => pct(val(e))],
    ['归母净利率', 'net_margin_calc', (e) => fmtNum(val(e), '%')],
    ['销售毛利率', 'sale_gross_margin', (e) => fmtNum(val(e), '%')],
    ['ROE(加权)', 'index_weighted_avg_roe', (e) => fmtNum(val(e), '%')],
    ['资产负债率', 'assets_debt_ratio', (e) => fmtNum(val(e), '%')],
    ['近一年涨跌', 'ret_period', (e) => pct(val(e))],
    ['年化波动', 'vol_annual', (e) => fmtNum(val(e), '%')],
  ];
  const table: UIBlock = {
    type: 'table',
    title: '横向对比',
    columns: ['指标', ...ms.map((m) => m.name)],
    rows: rowsDef.map(([label, f, fmt]) => {
      const es = ms.map((m) => findEv(run, f, m.thscode));
      return { cells: [label, ...es.map((e) => (e && e.status === 'conflict' ? `${fmt(e)} ⚠` : fmt(e)))], evidenceIds: [undefined, ...es.map((e) => e?.id)] };
    }),
    caption: '“推算”= 由利润表原始字段本地计算；⚠ = 存在数据冲突',
  };
  const blocks: UIBlock[] = [table];
  const withSeries = ms.filter((m) => m.series?.length);
  if (withSeries.length)
    blocks.push({ type: 'line', title: '近一年走势（首日=100 归一化）', series: withSeries.map((m) => ({ name: m.name, points: m.series!.map(([t, c]) => [t, +((c / m.series![0][1]) * 100).toFixed(2)] as [number, number]) })), caption: '口径：前复权收盘价归一化，仅反映历史表现' });
  blocks.push({ type: 'bars', title: '归母净利率对比', unit: '%', items: ms.map((m) => ({ label: m.name, value: val(findEv(run, 'net_margin_calc', m.thscode)), evidenceId: findEv(run, 'net_margin_calc', m.thscode)?.id })) });

  const claims: Claim[] = [];
  for (const m of ms) {
    const revs = run.evidence.filter((e) => e.entity === m.thscode && e.field === 'operating_income');
    const nps = run.evidence.filter((e) => e.entity === m.thscode && e.field === 'parent_holder_net_profit');
    const r = revs[revs.length - 1];
    const n = nps[nps.length - 1];
    if (r) claims.push({ kind: 'fact', text: `${m.name} ${String(r.caliber).split('·').pop()} 营业收入 ${yi(val(r))}、归母净利润 ${yi(val(n))}${cite(r, n)}`, evidenceIds: ids(r, n) });
    const pe = findEv(run, 'pe_ttm', m.thscode);
    if (val(pe) !== null) claims.push({ kind: 'fact', text: `${m.name} PE(TTM) ${fmtNum(val(pe), '倍')}（${fmtDate(pe!.asOf)}）${cite(pe)}`, evidenceIds: ids(pe) });
  }
  const rank = (f: string, label: string) => {
    const arr = ms.map((m) => ({ m, e: findEv(run, f, m.thscode) })).filter((x) => val(x.e) !== null && x.e!.status !== 'conflict');
    if (arr.length < 2) return;
    arr.sort((a, b) => val(b.e)! - val(a.e)!);
    claims.push({ kind: 'inference', text: `按${label}排序：${arr.map((x) => `${x.m.name} ${fmtNum(val(x.e), '%')}`).join(' > ')}${cite(...arr.map((x) => x.e))}`, evidenceIds: ids(...arr.map((x) => x.e)) });
  };
  rank('net_margin_calc', '归母净利率');
  rank('index_weighted_avg_roe', 'ROE(加权)');
  rank('np_yoy_calc', '归母净利润同比');
  claims.push({ kind: 'inference', text: '不同公司所处行业、商业模式与会计政策不同，单一比率排序不代表优劣，仅作为研究线索', evidenceIds: [] });
  for (const cf of conflicts) claims.push({ kind: 'uncertain', text: `数据冲突：${cf}`, evidenceIds: run.evidence.filter((e) => e.status === 'conflict').map((e) => e.id) });
  const miss = run.evidence.filter((e) => e.status === 'missing' && e.source !== '本地计算' && e.tool !== 'news_search');
  if (miss.length) claims.push({ kind: 'uncertain', text: `缺失字段（未参与比较）：${miss.slice(0, 6).map((e) => e.label).join('、')}`, evidenceIds: ids(...miss.slice(0, 4)) });
  return { blocks, claims };
}

// ---------------- 市场 ----------------
function marketReport(run: RunState): { blocks: UIBlock[]; claims: Claim[] } {
  const idx = run.evidence.filter((e) => e.tool === 'index_snapshot' && e.field === 'last_price');
  const kpis = idx.map((e) => {
    const p = findEv(run, 'price_change_ratio_pct', e.entity);
    const pv = val(p);
    return { label: e.label.replace(' 最新价', ''), value: val(e), unit: '点', evidenceId: e.id, status: e.status, sub: pct(pv), tone: (pv === null ? 'flat' : pv > 0 ? 'up' : pv < 0 ? 'down' : 'flat') as 'up' | 'down' | 'flat' };
  });
  const eUp = findEv(run, 'limit_up_stock_count');
  const eOpen = findEv(run, 'open_stock_count');
  const eSeal = findEv(run, 'seal_rate');
  const eBreak = findEv(run, 'break_rate_calc');
  const eAvg = findEv(run, 'index_avg_pct');
  const eHot = findEv(run, 'item[].name');
  const blocks: UIBlock[] = [
    { type: 'kpis', title: '主要指数', items: kpis.length ? kpis : [{ label: '指数行情', value: null, status: 'missing' }] },
    { type: 'kpis', title: '涨停情绪', items: [{ label: '封板家数', value: val(eUp), unit: '家', evidenceId: eUp?.id, status: eUp?.status ?? 'missing' }, { label: '炸板家数', value: val(eOpen), unit: '家', evidenceId: eOpen?.id, status: eOpen?.status ?? 'missing' }, { label: '封板率', value: val(eSeal), unit: '%', evidenceId: eSeal?.id, status: eSeal?.status ?? 'missing' }, { label: '炸板率(推算)', value: val(eBreak), unit: '%', evidenceId: eBreak?.id, status: eBreak?.status ?? 'missing' }] },
  ];
  const hot = ((run.evidence.find((e) => e.field === 'item[].name')?.raw as any[]) ?? []).slice(0, 10);
  if (hot.length) blocks.push({ type: 'table', title: '同花顺热股榜（关注度排名，非涨跌排名）', columns: ['排名', '名称', '代码'], rows: hot.map((h: any) => ({ cells: [h.rank, h.name, h.thscode], evidenceIds: [eHot?.id, undefined, undefined] })) });
  const claims: Claim[] = [];
  if (kpis.length) claims.push({ kind: 'fact', text: `主要指数：${kpis.map((k) => `${k.label} ${k.sub}`).join('，')}（快照时点 ${fmtDate(idx[0].asOf, true)}）${cite(...idx)}`, evidenceIds: ids(...idx) });
  if (val(eUp) !== null) claims.push({ kind: 'fact', text: `${eUp!.caliber}：涨停封板 ${val(eUp)} 家，炸板 ${val(eOpen) ?? '—'} 家，封板率 ${fmtNum(val(eSeal), '%', 1)}${cite(eUp, eOpen, eSeal)}`, evidenceIds: ids(eUp, eOpen, eSeal) });
  else claims.push({ kind: 'uncertain', text: '涨停统计数据缺失，未评估短线情绪', evidenceIds: ids(eUp) });
  if (eHot?.value) claims.push({ kind: 'fact', text: `热股榜前五：${eHot.value}（热度反映关注度，不代表涨跌或质量）${cite(eHot)}`, evidenceIds: ids(eHot) });
  if (val(eAvg) !== null) claims.push({ kind: 'inference', text: `主要指数等权平均涨跌 ${pct(val(eAvg))}，${val(eAvg)! > 0.5 ? '整体偏强' : val(eAvg)! < -0.5 ? '整体偏弱' : '整体分化/窄幅'}（仅描述当日状态）${cite(eAvg)}`, evidenceIds: ids(eAvg) });
  if (val(eBreak) !== null) claims.push({ kind: 'inference', text: `炸板率约 ${fmtNum(val(eBreak), '%', 1)}，${val(eBreak)! > 35 ? '封板稳定性偏弱' : '封板稳定性尚可'}（经验阈值，仅供参考）${cite(eBreak)}`, evidenceIds: ids(eBreak) });
  const macro = run.evidence.find((e) => e.tool === 'macro_indicator');
  const news = run.evidence.filter((e) => e.tool === 'news_search' || e.tool === 'news_flash');
  if (!news.some((e) => e.status === 'ok')) claims.push({ kind: 'uncertain', text: '未获取到可验证资讯，不对市场涨跌原因做归因', evidenceIds: ids(news[0]) });
  if (macro && macro.status !== 'ok') claims.push({ kind: 'uncertain', text: '宏观指标（iFinD EDB）未获取，未纳入宏观背景', evidenceIds: ids(macro) });
  claims.push({ kind: 'uncertain', text: '市场宽度（全市场涨跌家数）与资金流向本次未取数，情绪判断仅基于指数与涨停数据', evidenceIds: [] });
  return { blocks, claims };
}

// ---------------- 持仓 ----------------
function portfolioReport(run: RunState, data: any): { blocks: UIBlock[]; claims: Claim[] } {
  const hold: any[] = data?.holdings ?? [];
  const e1 = findEv(run, 'top1_weight');
  const e3 = findEv(run, 'top3_weight');
  const eH = findEv(run, 'hhi');
  const ePe = findEv(run, 'pf_pe_harmonic');
  const eDay = findEv(run, 'pf_day_pct');
  const blocks: UIBlock[] = [
    {
      type: 'kpis',
      title: '组合体检（构造匿名持仓）',
      items: [
        { label: '第一大持仓', value: val(e1), unit: '%', evidenceId: e1?.id, status: e1?.status, sub: e1?.note },
        { label: '前三大合计', value: val(e3), unit: '%', evidenceId: e3?.id, status: e3?.status },
        { label: '集中度 HHI', value: val(eH), unit: '', evidenceId: eH?.id, status: eH?.status },
        { label: '调和加权PE', value: val(ePe), unit: '倍', evidenceId: ePe?.id, status: ePe?.status },
        { label: '当日加权涨跌', value: val(eDay), unit: '%', evidenceId: eDay?.id, status: eDay?.status, tone: (val(eDay) ?? 0) > 0 ? 'up' : (val(eDay) ?? 0) < 0 ? 'down' : 'flat' },
      ],
    },
    { type: 'bars', title: '行业暴露（按第一行业归属）', unit: '%', items: (data?.sectors ?? []).map((s: any) => ({ label: s.name, value: s.weight })) , caption: '现金未计入' },
    {
      type: 'table',
      title: '持仓明细',
      columns: ['名称', '权重', '最新价', '涨跌幅', 'PE(TTM)', '行业/概念'],
      rows: hold.map((h) => {
        const px = findEv(run, 'last_price', h.thscode);
        const pc = findEv(run, 'price_change_ratio_pct', h.thscode);
        const pe = findEv(run, 'pe_ttm', h.thscode);
        const sec = findEv(run, 'index_list', h.thscode);
        return { cells: [h.name, `${h.weight}%`, h.thscode === 'CASH' ? '—' : fmtNum(val(px), '', 2), h.thscode === 'CASH' ? '—' : pct(val(pc)), h.thscode === 'CASH' ? '—' : fmtNum(val(pe), '倍', 1), String(sec?.value ?? '—').replace(/；概念.*/, '')], evidenceIds: [undefined, undefined, px?.id, pc?.id, pe?.id, sec?.id] };
      }),
    },
  ];
  const claims: Claim[] = [];
  if (val(e1) !== null) claims.push({ kind: 'fact', text: `第一大持仓 ${e1!.note ?? ''} 占 ${val(e1)}%，前三大合计 ${val(e3)}%（用户自报的构造权重）${cite(e1, e3)}`, evidenceIds: ids(e1, e3) });
  if (val(ePe) !== null) claims.push({ kind: 'inference', text: `持仓调和加权 PE(TTM) 约 ${fmtNum(val(ePe), '倍')}${ePe!.note ? `（${ePe!.note}）` : ''}${cite(ePe)}`, evidenceIds: ids(ePe) });
  if (val(eH) !== null) claims.push({ kind: 'inference', text: `HHI ${val(eH)!.toFixed(0)}，${val(eH)! > 2500 ? '组合集中度较高' : val(eH)! > 1500 ? '组合集中度中等' : '组合较分散'}；单一持仓超过 25% 时，个股特有风险对组合影响显著${cite(eH, e1)}`, evidenceIds: ids(eH, e1) });
  const top = (data?.sectors ?? []).slice().sort((a: any, b: any) => b.weight - a.weight)[0];
  if (top) claims.push({ kind: 'inference', text: `行业暴露最高为「${top.name}」${top.weight}%（按第一行业归属近似，未穿透）`, evidenceIds: ids(...run.evidence.filter((e) => e.field === 'index_list')) });
  if (data?.missingPx?.length) claims.push({ kind: 'uncertain', text: `行情缺失：${data.missingPx.join('、')}，当日涨跌贡献未完整计算`, evidenceIds: [] });
  if (data?.peMissing?.length) claims.push({ kind: 'uncertain', text: `PE 缺失或为负未纳入加权：${data.peMissing.join('、')}`, evidenceIds: [] });
  claims.push({ kind: 'uncertain', text: '本体检只描述组合结构与风险暴露，不构成调仓、买入或卖出建议', evidenceIds: [] });
  return { blocks, claims };
}

// ---------------- 板块 ----------------
function sectorReport(run: RunState): { blocks: UIBlock[]; claims: Claim[] } {
  const cons = run.entities;
  const eUp = findEv(run, 'sector_up');
  const eMed = findEv(run, 'sector_median_pct');
  const ePe = findEv(run, 'sector_pe_median');
  const eCnt = findEv(run, 'item.length');
  const blocks: UIBlock[] = [
    { type: 'kpis', title: '板块概览', items: [{ label: '成分股数量', value: val(eCnt), unit: '只', evidenceId: eCnt?.id, status: eCnt?.status }, { label: '上涨家数(样本)', value: val(eUp), unit: '家', evidenceId: eUp?.id, status: eUp?.status }, { label: '涨跌幅中位数', value: val(eMed), unit: '%', evidenceId: eMed?.id, status: eMed?.status }, { label: 'PE(TTM)中位数', value: val(ePe), unit: '倍', evidenceId: ePe?.id, status: ePe?.status }] },
    {
      type: 'table',
      title: '成分股（样本前 10）',
      columns: ['名称', '代码', '最新价', '涨跌幅', 'PE(TTM)', 'PB(MRQ)'],
      rows: cons.map((c) => {
        const px = findEv(run, 'last_price', c.thscode);
        const pc = findEv(run, 'price_change_ratio_pct', c.thscode);
        const pe = findEv(run, 'pe_ttm', c.thscode);
        const pb = findEv(run, 'pb_mrq', c.thscode);
        return { cells: [c.name, c.thscode, fmtNum(val(px), '', 2), pct(val(pc)), fmtNum(val(pe), '倍', 1), fmtNum(val(pb), '倍', 2)], evidenceIds: [undefined, undefined, px?.id, pc?.id, pe?.id, pb?.id] };
      }),
    },
  ];
  const claims: Claim[] = [];
  if (val(eCnt) !== null) claims.push({ kind: 'fact', text: `${eCnt!.label} ${val(eCnt)} 只${cite(eCnt)}`, evidenceIds: ids(eCnt) });
  if (val(eUp) !== null) claims.push({ kind: 'inference', text: `样本中 ${val(eUp)} 只上涨，涨跌幅中位数 ${pct(val(eMed))}${cite(eUp, eMed)}`, evidenceIds: ids(eUp, eMed) });
  if (val(ePe) !== null) claims.push({ kind: 'inference', text: `样本 PE(TTM) 中位数 ${fmtNum(val(ePe), '倍')}（剔除负值与缺失；样本仅前 10 只，非全成分）${cite(ePe)}`, evidenceIds: ids(ePe) });
  claims.push({ kind: 'uncertain', text: '样本为成分股列表前 10 只，未按市值加权，不能代表板块整体', evidenceIds: [] });
  return { blocks, claims };
}

// ---------------- LLM 摘要与数值校验 ----------------
/** 校验 LLM 文本：含数字的句子必须引用存在的证据，且数字需与被引证据（含常见单位换算）一致 */
export function verifyNarrative(text: string, evidence: Evidence[]): { ok: boolean; problems: string[] } {
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const problems: string[] = [];
  const sentences = text.split(/[。；;\n]/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences) {
    const cited = [...s.matchAll(/E-\d{3,}/g)].map((m) => m[0]);
    const body = s.replace(/\[?E-\d{3,}(,\s*E-\d{3,})*\]?/g, '').replace(/FY\d{4}|\d{4}-\d{1,2}(-\d{1,2})?|\d{4}年/g, '');
    const nums = [...body.matchAll(/-?\d+(\.\d+)?/g)].map((m) => Number(m[0]));
    if (!nums.length) continue;
    if (!cited.length) {
      problems.push(`句子含数字但未引用证据：「${s.slice(0, 40)}」`);
      continue;
    }
    const bad = cited.filter((id) => !byId.has(id));
    if (bad.length) {
      problems.push(`引用了不存在的证据：${bad.join(',')}`);
      continue;
    }
    const cands: number[] = [];
    for (const id of cited) {
      const v = byId.get(id)!.value;
      if (typeof v === 'number') cands.push(v, v / 1e8, v / 1e4, v * 100, Math.abs(v));
    }
    for (const n of nums) {
      if (Math.abs(n) < 10 && Number.isInteger(n)) continue; // 小整数（序号、个数）放行
      const okNum = cands.some((c) => Math.abs(c - n) <= Math.max(0.051, Math.abs(c) * 0.01));
      if (!okNum) problems.push(`数字 ${n} 与引用证据 ${cited.join(',')} 不符`);
    }
  }
  return { ok: problems.length === 0, problems };
}

function templateSummary(claims: Claim[]): string {
  const f = claims.filter((c) => c.kind === 'fact').slice(0, 2);
  const i = claims.filter((c) => c.kind === 'inference').slice(0, 2);
  const u = claims.filter((c) => c.kind === 'uncertain').slice(0, 1);
  return [...f.map((c) => `【事实】${c.text}`), ...i.map((c) => `【推断】${c.text}`), ...u.map((c) => `【不确定】${c.text}`)].join('\n');
}

export async function composeReport(mode: string, ctx: ToolContext, llm: LlmClient): Promise<ToolResult> {
  const run = ctx.run;
  const calc: any = ctx.outputs['t_calc'] ?? {};
  let part: { blocks: UIBlock[]; claims: Claim[] };
  let title = '研究报告';
  if (mode === 'stock' && calc.metrics?.[0]) {
    part = stockReport(run, calc.metrics[0], calc.conflicts ?? []);
    title = `${calc.metrics[0].name} 个股研究`;
  } else if (mode === 'compare' && calc.metrics?.length) {
    part = compareReport(run, calc.metrics, calc.conflicts ?? []);
    title = `${calc.metrics.map((m: StockMetrics) => m.name).join(' vs ')} 对比研究`;
  } else if (mode === 'market') {
    part = marketReport(run);
    title = '市场情绪观察';
  } else if (mode === 'portfolio' && !ctx.outputs['t_holdings']) {
    part = { blocks: [{ type: 'notice', level: 'warn', text: '未获授权读取持仓（或读取失败），本次未进行任何持仓分析。如需体检，请重新发起并批准“读取模拟持仓”。' }], claims: [{ kind: 'uncertain', text: '缺少持仓数据，不输出体检结论', evidenceIds: [] }] };
    title = '持仓体检（未授权）';
  } else if (mode === 'portfolio') {
    part = portfolioReport(run, calc);
    title = '持仓体检';
  } else if (mode === 'sector') {
    part = sectorReport(run);
    title = `板块观察：${(ctx.outputs['t_cons'] as any)?.name ?? ''}`;
  } else if (mode !== 'unresolved') {
    part = { blocks: [{ type: 'notice', level: 'warn', text: '已获取的数据不足以形成结论（关键任务失败或运行被提前停止）。请查看数据质量记录，修复后可“继续执行”。' }], claims: [{ kind: 'uncertain', text: '关键数据缺失，本次不输出研究结论', evidenceIds: [] }] };
    title = '部分结果（数据不足）';
  } else {
    const unresolved = (ctx.outputs['t_resolve'] as any)?.unresolved ?? [];
    part = {
      blocks: [{ type: 'notice', level: 'warn', text: `未能识别研究标的${unresolved.length ? `（${unresolved.join('、')}）` : ''}。请补充完整名称或 6 位代码，例如「研究 600519 的估值」「比较宁德时代和比亚迪的盈利能力」。${run.dataMode === 'demo' ? '演示模式仅覆盖：贵州茅台、五粮液、宁德时代、比亚迪、美的集团、中国平安、招商银行、中芯国际。' : ''}` }],
      claims: [{ kind: 'uncertain', text: '未识别到标的，未进行数据查询，也不输出任何结论', evidenceIds: [] }],
    };
    title = '需要补充信息';
  }
  // 结论分级与合规审查
  const graded = gradeClaims(part.claims, run.evidence).map((c) => {
    const g = guardOutput(c.text);
    if (g.violations.length) run.compliance.push(`输出审查移除：${g.violations.join('；')}`);
    return { ...c, text: g.text };
  });

  // 摘要：优先 LLM（需通过证据数值校验 + 合规审查），否则模板
  let summary = templateSummary(graded);
  let narrativeSource: Artifact['narrativeSource'] = 'template';
  if (llm.enabled() && mode !== 'unresolved') {
    const cm = new ContextManager(run.context);
    const evBrief = run.evidence
      .filter((e) => typeof e.value === 'number' && e.status !== 'missing')
      .slice(-40)
      .map((e) => `${e.id} ${e.label}=${e.value}${e.unit ?? ''}（${e.caliber ?? ''}，${e.status}）`)
      .join('\n');
    const system =
      '你是严谨的投资研究助理。根据给定结论与证据写 3-4 句中文摘要（≤200字）。规则：每个含数字的句子末尾用 [E-xxx] 引用证据；数字必须与证据一致（金额可换算为亿元）；' +
      '区分事实与推断；不得出现涨跌预测、目标价、买卖或仓位建议、收益承诺；数据缺失或冲突要明确说明。';
    const user = `上下文：\n${cm.render().slice(-3000)}\n\n分级结论：\n${graded.map((c) => `[${c.kind}] ${c.text}`).join('\n')}\n\n证据：\n${evBrief}`;
    try {
      const r = await llm.complete(system, user, { signal: ctx.signal, fault: ctx.llmFault, maxTokens: 500 });
      const g = guardOutput(r.text);
      const v = verifyNarrative(g.text, run.evidence);
      ctx.recordLlm?.({ tokensIn: r.tokensIn, tokensOut: r.tokensOut, latencyMs: r.latencyMs, ok: v.ok && !g.violations.length, note: v.ok ? undefined : v.problems.slice(0, 3).join('；') });
      if (g.violations.length) run.degradations.push(`LLM 摘要含不合规表述（${g.violations.join('；')}），已弃用并回退模板`);
      else if (!v.ok) run.degradations.push(`LLM 摘要未通过证据校验（${v.problems.slice(0, 2).join('；')}），已回退模板摘要`);
      else {
        summary = g.text.trim();
        narrativeSource = 'llm';
      }
    } catch (e: any) {
      ctx.recordLlm?.({ tokensIn: 0, tokensOut: 0, latencyMs: 0, ok: false, note: e?.message });
      run.degradations.push(`LLM 摘要失败（${e?.message ?? e}），已回退模板摘要`);
    }
  }

  const blocks: UIBlock[] = [
    ...headerNotices(run),
    { type: 'claims', title: '结论（按事实 / 推断 / 不确定分级）', items: graded },
    ...part.blocks,
    qualityBlock(run),
    { type: 'notice', level: 'info', text: DISCLAIMER },
  ];
  const version = run.artifacts.filter((a) => a.kind === 'report').length + 1;
  const artifact: Artifact = { id: uid('art'), runId: run.id, kind: 'report', title, version, createdAt: ctx.now(), blocks, markdown: '', narrativeSource, partial: !!run.stopReason };
  artifact.markdown = toMarkdown(artifact, summary, run);
  (artifact as any).summary = summary;
  return { data: { artifact, summary }, summary: `生成报告「${title}」v${version}（${graded.length} 条结论，摘要来源：${narrativeSource === 'llm' ? 'LLM（已校验）' : '模板'}）`, evidence: [] };
}

export function toMarkdown(a: Artifact, summary: string, run: RunState): string {
  const L: string[] = [`# ${a.title}（v${a.version}）`, '', `> 生成时间：${fmtDate(a.createdAt, true)} ｜ 数据模式：${run.dataMode === 'demo' ? '演示（构造数据）' : '实时（扶摇/iFinD）'} ｜ 运行 ID：${run.id}`, '', '## 摘要', '', summary, ''];
  for (const b of a.blocks) {
    if (b.type === 'notice') L.push(`> **${b.level === 'warn' ? '注意' : b.level === 'error' ? '错误' : '说明'}**：${b.text}`, '');
    if (b.type === 'claims') {
      L.push(`## ${b.title ?? '结论'}`, '');
      const name = { fact: '事实', inference: '推断', uncertain: '不确定' } as const;
      for (const c of b.items) L.push(`- **[${name[c.kind]}]** ${c.text}`);
      L.push('');
    }
    if (b.type === 'kpis') {
      L.push(`## ${b.title ?? '关键数据'}`, '', '| 指标 | 数值 | 证据 |', '|---|---|---|');
      for (const k of b.items) L.push(`| ${k.label} | ${fmtNum(k.value, k.unit)}${k.sub ? ` (${k.sub})` : ''} | ${k.evidenceId ?? '—'} |`);
      L.push('');
    }
    if (b.type === 'table') {
      L.push(`## ${b.title}`, '', `| ${b.columns.join(' | ')} |`, `|${b.columns.map(() => '---').join('|')}|`);
      for (const r of b.rows) L.push(`| ${r.cells.map((c) => (c === null ? '—' : String(c))).join(' | ')} |`);
      if (b.caption) L.push('', `_${b.caption}_`);
      L.push('');
    }
    if (b.type === 'quality') {
      L.push(`## ${b.title ?? '数据质量'}`, '');
      for (const q of b.items) L.push(`- [${q.status}] ${q.text}${q.evidenceId ? `（${q.evidenceId}）` : ''}`);
      L.push('');
    }
  }
  L.push('## 附录：证据账本', '', '| ID | 指标 | 值 | 单位 | 口径 | 数据时点 | 来源 / 字段 | 状态 |', '|---|---|---|---|---|---|---|---|');
  for (const e of run.evidence) L.push(`| ${e.id} | ${e.label} | ${e.value ?? '—'} | ${e.unit ?? ''} | ${e.caliber ?? ''} | ${fmtDate(e.asOf, true)} | ${e.source} \`${e.field}\`${e.formula ? ` 公式:${e.formula}` : ''}${e.derivedFrom?.length ? ` ←${e.derivedFrom.join(',')}` : ''} | ${e.status} |`);
  return L.join('\n');
}
