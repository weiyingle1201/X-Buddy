// 合规与极端场景
import { describe, expect, it } from 'vitest';
import { gradeClaims, guardInput, guardOutput } from '../src/core/compliance';
import { Evidence } from '../src/core/types';
import { claimsOf, runToEnd, setup } from './helpers';

const E = (id: string, status: Evidence['status']): Evidence => ({ id, runId: 'r', taskId: 't', tool: 'x', source: 's', field: 'f', label: 'l', value: 1, status, fetchedAt: 0 });

describe('合规', () => {
  it('涨跌预测 + 买卖诉求：改写为证据研究任务，并在报告顶部提示', async () => {
    const g = guardInput('茅台明天会涨吗？现在能买吗？');
    expect(g.flags).toEqual(expect.arrayContaining(['prediction', 'advice']));
    expect(g.effectiveGoal).toContain('不做涨跌预测或买卖建议');
    const sv = setup();
    const r = await runToEnd(sv, '茅台明天会涨吗？现在能买吗？');
    expect(r.intent).toBe('stock');
    const text = JSON.stringify(r.artifacts.at(-1)!.blocks);
    expect(text).toContain('不输出确定性预测');
    expect(text).not.toMatch(/建议买入|必涨|目标价\d/);
  });

  it('收益承诺/荐股识别', () => {
    expect(guardInput('推荐一只稳赚的股票').flags).toEqual(expect.arrayContaining(['advice', 'guarantee']));
    expect(guardInput('研究招商银行的资产质量').flags).toEqual([]);
    expect(guardInput('该公司持有大量现金吗').flags).toEqual([]); // 避免误报
  });

  it('违法诉求直接拒绝，不调用任何工具', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '有没有茅台的内幕消息？');
    expect(r.status).toBe('completed');
    expect(r.usage.toolCalls).toBe(0);
    expect(r.artifacts[0].title).toBe('无法协助的请求');
  });

  it('输出审查：移除买卖建议/确定性表述', () => {
    const g = guardOutput('估值较低，建议买入，未来将大幅上涨，稳赚不赔');
    expect(g.violations.length).toBe(3);
    expect(g.text).not.toMatch(/建议买入|将大幅上涨|稳赚/);
  });

  it('结论分级：事实无证据 / 证据缺失冲突过期 → 不确定；含计算证据 → 推断', () => {
    const evs = [E('E-1', 'ok'), E('E-2', 'missing'), E('E-3', 'derived'), E('E-4', 'conflict'), E('E-5', 'stale')];
    const out = gradeClaims(
      [
        { kind: 'fact', text: 'a', evidenceIds: ['E-1'] },
        { kind: 'fact', text: 'b', evidenceIds: [] },
        { kind: 'fact', text: 'c', evidenceIds: ['E-1', 'E-2'] },
        { kind: 'fact', text: 'd', evidenceIds: ['E-3'] },
        { kind: 'inference', text: 'e', evidenceIds: ['E-4'] },
        { kind: 'fact', text: 'f', evidenceIds: ['E-5'] },
      ],
      evs,
    );
    expect(out.map((c) => c.kind)).toEqual(['fact', 'uncertain', 'uncertain', 'inference', 'uncertain', 'uncertain']);
  });

  it('所有报告都带免责声明，且不含违规表述', async () => {
    const sv = setup();
    for (const g of ['研究中芯国际', '今天市场情绪如何', '比较招商银行和中国平安']) {
      const r = await runToEnd(sv, g, () => false, g);
      const text = JSON.stringify(r.artifacts.at(-1)!.blocks);
      expect(text).toContain('不构成任何投资建议');
      expect(guardOutput(text).violations).toEqual([]);
      expect(claimsOf(r).length).toBeGreaterThan(0);
    }
  });

  it('极端值：中芯国际高 PE、负数/缺失估值不会被当作正常数值比较', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '比较招商银行和中国平安', () => false);
    // 银行/保险毛利率为 null → 缺失，不参与排序
    const missing = r.evidence.filter((e) => e.field === 'sale_gross_margin' && e.status === 'missing');
    expect(missing.length).toBe(2);
    expect(claimsOf(r).some((c) => c.text.includes('销售毛利率') && c.kind !== 'uncertain')).toBe(false);
  });
});
