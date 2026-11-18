// LLM 规划/摘要的校验与降级；扶摇信封映射与 Live 客户端；规则规划解析
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FuyaoLiveClient, mapEnvelopeError } from '../src/adapters/fuyao';
import { IfindMcpClient } from '../src/adapters/ifind';
import { ScriptedLlm } from '../src/core/llm';
import { classify, extractMentions, ruleParse } from '../src/core/planner';
import { verifyNarrative } from '../src/core/report';
import { Evidence } from '../src/core/types';
import { runToEnd, setup } from './helpers';

const planJson = (intent: string, mentions: string[]) => JSON.stringify({ intent, mentions });

describe('LLM 降级与校验', () => {
  it('LLM 规划合法 → 采用（plannerSource=llm），并计入 token/成本', async () => {
    const llm = new ScriptedLlm((sys) => (sys.includes('规划器') ? planJson('stock', ['贵州茅台']) : '无数字摘要。'));
    const sv = setup({}, { llm });
    const r = await runToEnd(sv, '帮我看看那家卖白酒的龙头');
    expect(r.plannerSource).toBe('llm');
    expect(r.entities[0].thscode).toBe('600519.SH');
    expect(r.usage.llmCalls).toBeGreaterThanOrEqual(2);
    expect(r.usage.costYuan).toBeGreaterThan(0);
  });

  it('LLM 规划输出非法 JSON / 越界意图 → 回退规则规划，并记录降级', async () => {
    const llm = new ScriptedLlm((sys) => (sys.includes('规划器') ? '{"intent":"buy_now","mentions":["茅台"]}' : 'ok'));
    const sv = setup({}, { llm });
    const r = await runToEnd(sv, '研究贵州茅台');
    expect(r.plannerSource).toBe('rule');
    expect(r.degradations.some((d) => d.includes('LLM 规划失败'))).toBe(true);
    expect(r.status).toBe('completed');
  });

  it('LLM 摘要编造数字 → 未通过证据校验，回退模板摘要', async () => {
    const llm = new ScriptedLlm((sys) => (sys.includes('规划器') ? planJson('stock', ['贵州茅台']) : '茅台最新价 1888.88 元 [E-002]。'));
    const sv = setup({}, { llm });
    const r = await runToEnd(sv, '研究贵州茅台');
    expect(r.artifacts.at(-1)!.narrativeSource).toBe('template');
    expect(r.degradations.some((d) => d.includes('未通过证据校验'))).toBe(true);
  });

  it('LLM 摘要含买卖建议 → 被合规审查拦截并回退', async () => {
    const llm = new ScriptedLlm((sys) => (sys.includes('规划器') ? planJson('stock', ['贵州茅台']) : '基本面稳健，建议买入。'));
    const sv = setup({}, { llm });
    const r = await runToEnd(sv, '研究贵州茅台');
    expect(r.artifacts.at(-1)!.narrativeSource).toBe('template');
    expect(r.degradations.some((d) => d.includes('不合规'))).toBe(true);
  });

  it('LLM 摘要数字与证据一致且有引用 → 采用 LLM 摘要', async () => {
    const llm = new ScriptedLlm((sys, user) => {
      if (sys.includes('规划器')) return planJson('stock', ['贵州茅台']);
      const id = user.match(/(E-\d{3}) 贵州茅台 最新价=1450.2/)![1];
      return `贵州茅台最新价 1450.2 元 [${id}]。数据为演示构造，资讯缺失，未做归因。`;
    });
    const sv = setup({}, { llm });
    const r = await runToEnd(sv, '研究贵州茅台');
    expect(r.artifacts.at(-1)!.narrativeSource).toBe('llm');
  });

  it('LLM 服务故障（故障注入）→ 规划与摘要均回退，运行仍完成', async () => {
    const llm = new ScriptedLlm(() => new Error('503'));
    const sv = setup({ faults: { llm: 'error' } }, { llm });
    const r = await runToEnd(sv, '研究贵州茅台');
    expect(r.status).toBe('completed');
    expect(r.plannerSource).toBe('rule');
    expect(r.artifacts.at(-1)!.narrativeSource).toBe('template');
  });

  it('verifyNarrative：亿元换算/百分比通过；无引用或引用不存在失败', () => {
    const evs: Evidence[] = [
      { id: 'E-001', runId: '', taskId: '', tool: '', source: '', field: 'operating_income', label: '', value: 185200000000, unit: '元', status: 'demo', fetchedAt: 0 },
      { id: 'E-002', runId: '', taskId: '', tool: '', source: '', field: 'x', label: '', value: 6.35, unit: '%', status: 'derived', fetchedAt: 0 },
    ];
    expect(verifyNarrative('FY2025 营收 1852.00 亿元 [E-001]，同比 6.35% [E-002]。', evs).ok).toBe(true);
    expect(verifyNarrative('营收 1852 亿元。', evs).ok).toBe(false);
    expect(verifyNarrative('营收 1852 亿元 [E-099]。', evs).ok).toBe(false);
    expect(verifyNarrative('同比 9.9% [E-002]。', evs).ok).toBe(false);
  });
});

describe('扶摇适配器', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('信封错误码映射', () => {
    expect(mapEnvelopeError({ code: 0, message: '', data: {} })).toBeNull();
    expect(mapEnvelopeError({ code: 2001, message: '', data: null })!.kind).toBe('auth');
    expect(mapEnvelopeError({ code: 4001, message: '', data: null })!.retryable).toBe(true);
    expect(mapEnvelopeError({ code: 0, message: '', data: null }, 429)!.kind).toBe('rate_limit');
    expect(mapEnvelopeError({ code: 1002, message: 'bad', data: null })!.kind).toBe('param');
    expect(mapEnvelopeError({ code: 3001, message: '', data: null })!.kind).toBe('no_data');
  });

  it('Live 客户端：携带 X-api-key、拼接参数、解析信封；无 Key 时直接报鉴权错误', async () => {
    const fetchMock = vi.fn(async (url: string, init: any) => ({ status: 200, json: async () => ({ code: 0, message: 'success', data: { item: [{ url, key: init.headers['X-api-key'] }] } }) }));
    vi.stubGlobal('fetch', fetchMock);
    const c = new FuyaoLiveClient('test-key', 'https://example.test', 0);
    const env = await c.get('/api/a-share/prices/snapshot', { thscodes: '600519.SH', limit: undefined });
    expect(env.data.item[0].url).toBe('https://example.test/api/a-share/prices/snapshot?thscodes=600519.SH');
    expect(env.data.item[0].key).toBe('test-key');
    await expect(new FuyaoLiveClient('', 'https://example.test', 0).get('/x', {})).rejects.toMatchObject({ kind: 'auth' });
  });

  it('Live 客户端：HTTP 429 → rate_limit（可重试）；网络错误 → network（可重试）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 429, json: async () => ({ code: 4001, message: 'limited', data: null }) })));
    await expect(new FuyaoLiveClient('k', 'https://e.test', 0).get('/x', {})).rejects.toMatchObject({ kind: 'rate_limit', retryable: true });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await expect(new FuyaoLiveClient('k', 'https://e.test', 0).get('/x', {})).rejects.toMatchObject({ kind: 'network', retryable: true });
  });

  it('iFinD MCP 客户端：initialize + tools/call，解析 SSE 与会话 ID', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      const body = JSON.parse(init.body);
      calls.push({ method: body.method, auth: init.headers.Authorization, sid: init.headers['Mcp-Session-Id'] });
      const result = body.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { content: [{ type: 'text', text: '标题A\n正文A\n\n标题B\n正文B' }] };
      return { ok: true, status: 200, headers: new Map([['Content-Type', 'text/event-stream'], ['Mcp-Session-Id', 'sess-1']]) as any, text: async () => `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n` };
    }));
    const c = new IfindMcpClient('https://mcp.example.test', 'tok');
    const r = await c.callTool('search_news', { query: 'x' });
    expect(calls.map((x) => x.method)).toEqual(['initialize', 'tools/call']);
    expect(calls[1].sid).toBe('sess-1');
    expect(calls[0].auth).toBe('tok');
    expect(r.items.length).toBe(2);
  });
});

describe('规则规划', () => {
  it('意图分类与实体抽取', () => {
    expect(ruleParse('研究贵州茅台的基本面和估值').intent).toBe('stock');
    expect(ruleParse('比较宁德时代和比亚迪').mentions.length).toBe(2);
    expect(ruleParse('今天市场情绪如何').intent).toBe('market');
    expect(ruleParse('体检我的持仓').intent).toBe('portfolio');
    expect(ruleParse('看看半导体板块').sectorQuery).toBe('半导体');
    expect(extractMentions('分析 600036 和 300750').hints).toMatchObject({ '600036.SH': '600036.SH', '300750.SZ': '300750.SZ' });
    expect(extractMentions('中国平安怎么样').mentions).toEqual(['中国平安']); // 长名优先
    expect(classify('随便聊聊', 0)).toBe('unknown');
  });
  it('追问沿用线程实体', () => {
    const p = ruleParse('再和五粮液比较一下', [{ thscode: '600519.SH', name: '贵州茅台' }]);
    expect(p.intent).toBe('compare');
    expect(p.mentions[0]).toBe('600519.SH');
    const q = ruleParse('它的现金流怎么样', [{ thscode: '600519.SH', name: '贵州茅台' }]);
    expect(q.intent).toBe('stock');
  });
});
