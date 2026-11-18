// 数据缺失 / 接口失败 / 降级 / 熔断 / 预算停止：任何异常都不能“静默生成正常结论”
import { describe, expect, it } from 'vitest';
import { claimsOf, ev, runToEnd, setup } from './helpers';

describe('失败与降级', () => {
  it('行情接口服务错误：任务失败、证据记为 error、结论降级为不确定，不出现“最新价”事实', async () => {
    const sv = setup({ faults: { price_snapshot: 'error' } });
    const r = await runToEnd(sv, '研究贵州茅台');
    const t = r.plan.find((x) => x.tool === 'price_snapshot')!;
    expect(t.status).toBe('failed');
    expect(r.evidence.some((e) => e.taskId === t.id && e.status === 'error')).toBe(true);
    const claims = claimsOf(r);
    expect(claims.some((c) => c.kind === 'fact' && c.text.includes('最新价'))).toBe(false);
    expect(claims.some((c) => c.kind === 'uncertain' && c.text.includes('行情未获取'))).toBe(true);
    // 报告仍然生成，并在数据质量区列出失败
    const q = r.artifacts.at(-1)!.blocks.find((b) => b.type === 'quality')!;
    expect(JSON.stringify(q)).toContain('失败');
  });

  it('限流（首次 429）：自动重试后成功，记录重试次数', async () => {
    const sv = setup({ faults: { valuation_snapshot: 'rate_limit' } });
    const r = await runToEnd(sv, '研究贵州茅台');
    const t = r.plan.find((x) => x.tool === 'valuation_snapshot')!;
    expect(t.status).toBe('done');
    expect(t.attempts).toBe(2);
    expect(r.usage.retries).toBeGreaterThanOrEqual(1);
  });

  it('估值接口超时：重试耗尽后走降级链（静态 PE），口径变化被显式标注', async () => {
    const sv = setup({ faults: { valuation_snapshot: 'timeout' } });
    sv.registry.get('valuation_snapshot')!.timeoutMs = 30;
    const r = await runToEnd(sv, '研究贵州茅台');
    const t = r.plan.find((x) => x.tool === 'valuation_snapshot')!;
    expect(t.status).toBe('degraded');
    expect(t.attempts).toBe(4); // 1 次 + 2 次重试 + 1 次降级
    const fb = ev(r, 'pe_static', '600519.SH')!;
    expect(fb.status).toBe('derived');
    expect(fb.note).toContain('不可直接比较');
    expect(claimsOf(r).some((c) => c.kind === 'inference' && c.text.includes('降级'))).toBe(true);
    expect(r.degradations.length).toBeGreaterThan(0);
  });

  it('利润表返回空：缺失被标记，财务结论为不确定', async () => {
    const sv = setup({ faults: { income_statements: 'empty' } });
    const r = await runToEnd(sv, '研究贵州茅台');
    expect(ev(r, 'item', '600519.SH')!.status).toBe('missing');
    expect(claimsOf(r).some((c) => c.kind === 'uncertain' && c.text.includes('利润表数据缺失'))).toBe(true);
  });

  it('行情数据过期：证据标记 stale，引用它的结论自动降级为不确定', async () => {
    const sv = setup({ faults: { price_snapshot: 'stale' } });
    const r = await runToEnd(sv, '研究贵州茅台');
    expect(ev(r, 'last_price', '600519.SH')!.status).toBe('stale');
    const c = claimsOf(r).find((x) => x.text.includes('最新价'))!;
    expect(c.kind).toBe('uncertain');
  });

  it('最新财报期无数据：财务指标降级到上一期年报，并标注口径', async () => {
    const sv = setup({ faults: { financial_indicators: 'error' } });
    const r = await runToEnd(sv, '研究贵州茅台');
    const t = r.plan.find((x) => x.tool === 'financial_indicators')!;
    expect(t.status).toBe('degraded');
    expect(ev(r, 'index_weighted_avg_roe', '600519.SH')!.caliber).toContain('降级');
  });

  it('iFinD 资讯失败：降级到扶摇快讯；两者都无真实内容时仍声明“不做归因”', async () => {
    const sv = setup({ faults: { news_search: 'error' } });
    const r = await runToEnd(sv, '研究贵州茅台');
    const t = r.plan.find((x) => x.tool === 'news_search')!;
    expect(t.status).toBe('degraded');
    expect(t.degradedNote).toContain('快讯');
    expect(claimsOf(r).some((c) => c.kind === 'uncertain' && c.text.includes('不解释'))).toBe(true);
  });

  it('鉴权失败（不可重试）→ 立即熔断 → 停止并生成“部分结果”报告', async () => {
    const faults = Object.fromEntries(['price_snapshot', 'price_history', 'valuation_snapshot', 'income_statements', 'financial_indicators', 'stock_sectors', 'news_search'].map((k) => [k, 'auth' as const]));
    const sv = setup({ faults, budget: { ...setup().settings.budget, maxConsecutiveFailures: 2 } });
    sv.registry.get('valuation_fallback')!.run = async () => {
      throw new Error('fallback down');
    };
    const r = await runToEnd(sv, '研究贵州茅台');
    expect(r.status).toBe('stopped');
    expect(r.stopReason).toContain('鉴权失败');
    const art = r.artifacts.at(-1)!;
    expect(art.partial).toBe(true);
    expect(claimsOf(r).filter((c) => c.kind === 'fact').length).toBe(0);
  });

  it('连续失败熔断：非鉴权错误连续发生达到阈值即停止', async () => {
    const faults = Object.fromEntries(['price_snapshot', 'price_history', 'income_statements', 'stock_sectors'].map((k) => [k, 'error' as const]));
    const sv = setup({ faults, budget: { ...setup().settings.budget, maxConsecutiveFailures: 2 } });
    sv.runtime['d'].concurrency = 1;
    const r = await runToEnd(sv, '研究贵州茅台');
    expect(r.stopReason).toContain('熔断');
    expect(r.artifacts.at(-1)!.partial).toBe(true);
  });

  it('工具调用预算耗尽 → 停止规则触发，基于已有证据出部分报告，可放宽预算继续', async () => {
    const sv = setup({ budget: { ...setup().settings.budget, maxToolCalls: 3 } });
    sv.runtime['d'].concurrency = 1;
    const r = await runToEnd(sv, '研究贵州茅台');
    expect(r.status).toBe('stopped');
    expect(r.stopReason).toContain('工具调用次数达到上限');
    expect(r.artifacts.at(-1)!.partial).toBe(true);
    await sv.runtime.resume(r.id, { extendBudget: true });
    // 仍可能再次触顶，但预算翻倍且有进展
    const r2 = sv.runtime.get(r.id)!;
    expect(r2.budget.maxToolCalls).toBe(6);
    expect(r2.usage.toolCalls).toBeGreaterThan(3);
  });

  it('参数校验失败：不调用接口，直接失败并入账', async () => {
    const sv = setup();
    const run = await sv.runtime.createRun('th', '研究贵州茅台');
    await sv.runtime.start(run.id);
    const r = sv.runtime.get(run.id)!;
    const bad = { ...r.plan.find((t) => t.tool === 'price_history')!, id: 't_bad', args: { thscode: '600519' }, status: 'pending' as const, attempts: 0, evidenceIds: [], dependsOn: [] };
    r.plan.push(bad);
    r.status = 'running';
    await sv.runtime.start(r.id);
    const t = sv.runtime.get(r.id)!.plan.find((x) => x.id === 't_bad')!;
    expect(t.status).toBe('failed');
    expect(t.error).toContain('参数校验失败');
    expect(t.attempts).toBe(0);
  });
});
