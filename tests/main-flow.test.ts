// 主链路：规划 → 工具执行 → 证据 → 报告 → 审批写记忆
import { describe, expect, it } from 'vitest';
import { claimsOf, ev, runToEnd, setup } from './helpers';

describe('主链路', () => {
  it('个股研究：两阶段规划、证据可追溯、报告分级、写记忆需审批', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '研究贵州茅台的基本面和估值');
    expect(r.status).toBe('completed');
    expect(r.intent).toBe('stock');
    expect(r.entities[0].thscode).toBe('600519.SH');
    // 初始 1 个解析任务，展开后包含行情/估值/财务/资讯/计算/报告/记忆
    expect(r.plan.map((t) => t.tool)).toEqual(expect.arrayContaining(['resolve_entities', 'price_snapshot', 'price_history', 'valuation_snapshot', 'income_statements', 'financial_indicators', 'stock_sectors', 'news_search', 'compute_metrics', 'compose_report', 'save_memory']));
    expect(r.events.some((e) => e.type === 'replan')).toBe(true);
    // 每条外部数据证据都有来源、字段、口径或时点
    const px = ev(r, 'last_price', '600519.SH')!;
    expect(px.source).toContain('/api/a-share/prices/snapshot');
    expect(px.unit).toBe('元');
    expect(px.asOf).toBeTypeOf('number');
    expect(px.status).toBe('demo');
    // 计算证据记录公式与来源证据
    const yoy = ev(r, 'np_yoy_calc', '600519.SH')!;
    expect(yoy.formula).toBeTruthy();
    expect(yoy.derivedFrom!.length).toBe(2);
    // 报告：事实必须引用证据；资讯缺失被列为不确定
    const claims = claimsOf(r);
    expect(claims.filter((c) => c.kind === 'fact').every((c) => c.evidenceIds.length > 0)).toBe(true);
    expect(claims.some((c) => c.kind === 'uncertain' && c.text.includes('资讯'))).toBe(true);
    // 写记忆经过审批
    expect(r.approvals.some((a) => a.kind === 'memory_write' && a.status === 'approved')).toBe(true);
    expect(sv.memory.all().some((m) => m.kind === 'research_note' && m.entity === '600519.SH')).toBe(true);
    // Markdown 导出包含证据附录
    expect(r.artifacts[0].markdown).toContain('附录：证据账本');
  });

  it('拒绝写记忆：任务跳过，报告仍保留', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '研究五粮液', () => false);
    expect(r.plan.find((t) => t.tool === 'save_memory')!.status).toBe('skipped');
    expect(r.artifacts.length).toBe(1);
    expect(sv.memory.all().some((m) => m.kind === 'research_note')).toBe(false);
  });

  it('同业对比：批量取数 + 冲突检测（比亚迪指标与报表推算不一致）', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '比较宁德时代和比亚迪的盈利能力');
    expect(r.intent).toBe('compare');
    const ind = ev(r, 'net_profit_yoy_growth_ratio', '002594.SZ')!;
    expect(ind.status).toBe('conflict');
    expect(claimsOf(r).some((c) => c.kind === 'uncertain' && c.text.includes('冲突'))).toBe(true);
    // 冲突值不参与排序结论
    expect(claimsOf(r).some((c) => c.text.startsWith('按归母净利润同比排序'))).toBe(false);
    // 行情与估值是批量一次请求
    expect(r.plan.filter((t) => t.tool === 'price_snapshot').length).toBe(1);
  });

  it('市场情绪：指数/涨停/热榜，iFinD 资讯与宏观在演示模式下按缺失处理', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '今天市场情绪如何？');
    expect(r.intent).toBe('market');
    expect(r.status).toBe('completed');
    expect(ev(r, 'seal_rate')!.value).toBe(72);
    const claims = claimsOf(r);
    expect(claims.some((c) => c.kind === 'uncertain' && c.text.includes('资讯'))).toBe(true);
  });

  it('持仓体检：敏感读取需授权；批准后计算集中度与加权 PE', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '帮我体检一下我的持仓');
    expect(r.approvals[0].kind).toBe('tool');
    expect(ev(r, 'top1_weight')!.value).toBe(30);
    expect(ev(r, 'pf_pe_harmonic')!.value).toBeGreaterThan(0);
    expect(r.artifacts[0].title).toBe('持仓体检');
  });

  it('持仓体检：拒绝授权 → 不读取持仓，输出说明而非结论', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '帮我体检一下我的持仓', () => false);
    expect(r.evidence.some((e) => e.tool === 'read_portfolio')).toBe(false);
    expect(r.artifacts.at(-1)!.title).toContain('未授权');
    expect(r.status).toBe('completed');
  });

  it('板块观察：检索板块 → 成分股（再次展开）→ 批量行情估值', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '看看白酒板块');
    expect(r.intent).toBe('sector');
    expect(r.plan.map((t) => t.tool)).toEqual(expect.arrayContaining(['ticker_search', 'index_constituents', 'price_snapshot', 'valuation_snapshot']));
    expect(r.events.filter((e) => e.type === 'replan').length).toBe(2);
    expect(ev(r, 'sector_pe_median')!.value).toBeGreaterThan(0);
  });

  it('线程追问：省略标的时沿用线程实体，并命中缓存', async () => {
    const sv = setup();
    const r1 = await runToEnd(sv, '研究贵州茅台');
    const r2 = await sv.runtime.createRun('th', '再和五粮液比较一下', { threadEntities: r1.entities });
    expect(r2.intent).toBe('compare');
    await sv.runtime.start(r2.id);
    const ap = sv.runtime.get(r2.id)!.approvals.find((a) => a.status === 'pending');
    if (ap) await sv.runtime.approve(r2.id, ap.id, false);
    const done = sv.runtime.get(r2.id)!;
    expect(done.entities.map((e) => e.thscode)).toEqual(['600519.SH', '000858.SZ']);
    expect(done.usage.cacheHits).toBeGreaterThan(0);
  });

  it('多标的超预算：需先批准预算；拒绝则不执行任何工具', async () => {
    const sv = setup();
    const run = await sv.runtime.createRun('th', '对比茅台、五粮液和美的集团');
    expect(run.status).toBe('awaiting_approval');
    expect(run.approvals[0].kind).toBe('budget');
    await sv.runtime.approve(run.id, run.approvals[0].id, false);
    const r = sv.runtime.get(run.id)!;
    expect(r.status).toBe('stopped');
    expect(r.usage.toolCalls).toBe(0);
  });

  it('未识别标的：不调用数据接口，输出澄清说明', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '研究一下火星矿业');
    expect(r.artifacts.at(-1)!.title).toBe('需要补充信息');
    expect(r.evidence.filter((e) => e.tool !== 'resolve_entities').length).toBe(0);
  });
});
