// 演示数据客户端：按扶摇文档的路径与信封结构返回【构造数据】
import { ToolError } from '../core/types';
import { sleep } from '../core/util';
import { DEMO_ASOF, DEMO_INDICES, DEMO_NEWS, DEMO_SECTORS, DEMO_STOCKS, demoKline, demoTradingDays } from '../data/fixtures';
import { applyFault, CallOpts, Envelope, FuyaoApi, Params } from './fuyao';
import { McpApi } from './ifind';

const ok = (data: any): Envelope => ({ code: 0, message: 'success (DEMO 构造数据)', request_id: `demo-${Math.random().toString(16).slice(2, 10)}`, data });
const ticker = (c: string) => c.split('.')[0];
const stock = (c: string) => DEMO_STOCKS.find((s) => s.thscode === c);
const fyMs = (fy: number) => Date.UTC(fy, 11, 31, -8);

export class FuyaoDemoClient implements FuyaoApi {
  mode = 'demo' as const;
  constructor(private latencyMs = 120) {}

  async get(path: string, params: Params, opts: CallOpts = {}): Promise<Envelope> {
    return applyFault(async () => {
      await sleep(this.latencyMs + Math.random() * this.latencyMs, opts.signal);
      return this.route(path, params);
    }, opts);
  }

  private route(path: string, p: Params): Envelope {
    const codes = String(p.thscodes ?? p.thscode ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);
    switch (path) {
      case '/api/meta/tickers/search': {
        const q = String(p.q ?? '').trim();
        if (!q) throw new ToolError('缺少必填参数 q（code=1001）', 'param', false, 1001);
        const pool = [
          ...DEMO_STOCKS.map((s) => ({ thscode: s.thscode, name: s.name, asset_type: 'a-share' })),
          ...DEMO_INDICES.map((s) => ({ thscode: s.thscode, name: s.name, asset_type: 'a-share-index' })),
          ...Object.values(DEMO_SECTORS).map((s) => ({ thscode: s.thscode, name: s.name, asset_type: 'a-share-index' })),
        ];
        const at = p.asset_type ? String(p.asset_type).split(',') : null;
        const item = pool
          .filter((x) => (!at || at.includes(x.asset_type)) && (x.thscode.includes(q.toUpperCase()) || x.name.includes(q) || q.includes(x.name.replace(/（.*）/, ''))))
          .slice(0, Number(p.limit ?? 10))
          .map((x) => ({ ...x, ticker: ticker(x.thscode), exchange: x.thscode.split('.')[1], currency: 'CNY', list_date: null }));
        return ok({ timestamp: DEMO_ASOF, item });
      }
      case '/api/a-share/prices/snapshot': {
        const item = codes
          .map((c) => stock(c))
          .filter(Boolean)
          .map((s) => snap(s!.thscode, s!.price, s!.prev));
        return ok({ timestamp: DEMO_ASOF, total: DEMO_STOCKS.length, item });
      }
      case '/api/a-share-index/prices/snapshot': {
        const item = codes
          .map((c) => {
            const i = DEMO_INDICES.find((x) => x.thscode === c);
            if (i) return snap(i.thscode, i.price, i.prev);
            const sec = Object.values(DEMO_SECTORS).find((x) => x.thscode === c);
            if (sec) {
              const r = (hash(c) % 300) / 100 - 1.2;
              return snap(sec.thscode, 1000 * (1 + r / 100), 1000);
            }
            return null;
          })
          .filter(Boolean);
        return ok({ timestamp: DEMO_ASOF, item });
      }
      case '/api/a-share/prices/historical': {
        const s = stock(codes[0]);
        if (!s) return ok({ timestamp: null, item: [] });
        const k = demoKline(s.thscode, s.price, s.vol);
        const start = Number(p.start ?? 0);
        const end = Number(p.end ?? Infinity);
        return ok({ timestamp: DEMO_ASOF, item: k.filter((x) => x.date_ms >= start - 86400e3 && x.date_ms <= end) });
      }
      case '/api/a-share/valuations/snapshot': {
        const item = codes
          .map((c) => stock(c))
          .filter(Boolean)
          .map((s) => ({ thscode: s!.thscode, ticker: ticker(s!.thscode), name: s!.name, ...s!.val }));
        return ok({ timestamp: DEMO_ASOF - 86400e3, total: item.length, item });
      }
      case '/api/a-share/financials/income-statements': {
        const s = stock(codes[0]);
        if (!s) return ok({ timestamp: null, item: [] });
        const limit = Number(p.limit ?? 4);
        const item = [2022, 2023, 2024, 2025]
          .map((fy, i) => ({
            thscode: s.thscode,
            ticker: ticker(s.thscode),
            period: 'annual',
            fiscal_year: fy,
            fiscal_period: 'FY',
            report_date_ms: fyMs(fy),
            period_end_ms: fyMs(fy),
            currency: 'CNY',
            operating_income: s.rev[i],
            net_profit: Math.round(s.np[i] * 1.04),
            parent_holder_net_profit: s.np[i],
            basic_eps: s.eps[i],
          }))
          .reverse()
          .slice(0, limit);
        return ok({ timestamp: fyMs(2025), item });
      }
      case '/api/a-share/financials/indicators': {
        const s = stock(codes[0]);
        const report = String(p.report ?? '');
        if (!/^\d{4}-[1-4]$/.test(report)) throw new ToolError('report 格式非法（code=1002）', 'param', false, 1002);
        const idx = report === '2025-4' ? 3 : report === '2024-4' ? 2 : -1;
        if (!s || idx < 0) return { code: 3001, message: '无有效数据', data: null } as Envelope;
        const npYoy = (idx === 3 ? s.npYoyOverride : undefined) ?? +((s.np[idx] / s.np[idx - 1] - 1) * 100).toFixed(2);
        const revYoy = +((s.rev[idx] / s.rev[idx - 1] - 1) * 100).toFixed(2);
        const v = (x: number | null) => (x === null ? null : x.toFixed(8));
        return {
          code: 0,
          message: 'success (DEMO 构造数据)',
          request_id: 'demo',
          data: {
            thscode: s.thscode,
            report,
            abilities: [
              { ability: 'growth', indicators: [{ index_id: 'net_profit_yoy_growth_ratio', value: v(npYoy) }, { index_id: 'operating_income_yoy_growth_ratio', value: v(revYoy) }] },
              { ability: 'profitability', indicators: [{ index_id: 'sale_gross_margin', value: v(s.gross) }, { index_id: 'index_weighted_avg_roe', value: v(s.roe) }, { index_id: 'sale_net_interest_ratio', value: v(+((s.np[idx] / s.rev[idx]) * 100).toFixed(2)) }] },
              { ability: 'solvency', indicators: [{ index_id: 'assets_debt_ratio', value: v(s.debt) }, { index_id: 'current_ratio', value: v(s.current) }] },
              { ability: 'operation', indicators: [] },
              { ability: 'cash-flow', indicators: [] },
            ],
          },
        };
      }
      case '/api/a-share-index/constituents/ths-index-list-by-stock': {
        const item = codes.map((c) => ({ thscode: c, index_list: stock(c)?.sectors ?? [] }));
        return ok({ timestamp: DEMO_ASOF, item });
      }
      case '/api/a-share-index/constituents/ths-stock-list': {
        const item = DEMO_STOCKS.filter((s) => s.sectors.some((x) => x.thscode === codes[0])).map((s) => ({ thscode: s.thscode, ticker: ticker(s.thscode), name: s.name }));
        return ok({ timestamp: DEMO_ASOF, item });
      }
      case '/api/a-share/calendar/trading-days': {
        const days = demoTradingDays(DEMO_ASOF, 30);
        return ok({ timestamp: DEMO_ASOF, item: days.map((d) => ({ date_ms: d, date: new Date(d + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '') })) });
      }
      case '/api/a-share/special-data/limit-up-statistics':
        return ok({
          timestamp: DEMO_ASOF,
          trade_date: '2026-11-17',
          seal_rate: 0.72,
          open_stock_count: 21,
          limit_up_stock_count: 54,
          touched_limit_up_stock_count: 75,
          page_boards: [
            { board_level: 'one', stock_count: 38, promotion_rate: null },
            { board_level: 'two', stock_count: 9, promotion_rate: 0.21 },
            { board_level: 'three', stock_count: 4, promotion_rate: 0.36 },
            { board_level: 'four', stock_count: 2, promotion_rate: 0.4 },
            { board_level: 'five_plus', stock_count: 1, promotion_rate: 0.5 },
          ],
          exact_boards: [{ board_num: 2, stock_count: 9 }, { board_num: 3, stock_count: 4 }],
        });
      case '/api/a-share/special-data/hot-stock-list':
        return ok({ timestamp: DEMO_ASOF, item: DEMO_STOCKS.slice(0, 6).map((s, i) => ({ thscode: s.thscode, ticker: ticker(s.thscode), name: s.name, rank: i + 1 })) });
      case '/api/news/flash/list':
        return ok({ timestamp: DEMO_ASOF, items: DEMO_NEWS.map((n, i) => ({ id: String(i), seq: String(i), title: n.title, summary: n.summary, tags: [], type: 0, create_time_ms: n.time, update_time_ms: n.time, encoded_url: 'demo' })) });
      default:
        throw new ToolError(`演示数据未覆盖该接口：${path}`, 'unavailable', false);
    }
  }
}

function snap(thscode: string, last: number, prev: number) {
  const chg = +(last - prev).toFixed(2);
  return {
    thscode,
    ticker: ticker(thscode),
    last_price: last,
    prev_price: prev,
    price_change: chg,
    price_change_ratio_pct: +((chg / prev) * 100).toFixed(4),
    open_price: prev,
    high_price: +(Math.max(last, prev) * 1.006).toFixed(2),
    low_price: +(Math.min(last, prev) * 0.994).toFixed(2),
    volume: 3_000_000,
    turnover: Math.round(3_000_000 * last),
  };
}

function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

/** iFinD MCP 演示：只返回明确标注的占位内容，不编造新闻或宏观数值 */
export class IfindDemoClient implements McpApi {
  mode = 'demo' as const;
  available() {
    return true;
  }
  async callTool(name: string, args: Record<string, unknown>, opts: CallOpts = {}) {
    await sleep(150, opts.signal);
    if (opts.fault === 'error') throw new ToolError('iFinD MCP 调用失败（故障注入）', 'upstream', false);
    if (opts.fault === 'timeout') await sleep(60_000, opts.signal);
    if (opts.fault === 'empty') return { text: '', items: [], asOf: DEMO_ASOF };
    if (name === 'search_news' || name === 'search_notice') {
      return { text: DEMO_NEWS.map((n) => `${n.title}：${n.summary}`).join('\n'), items: DEMO_NEWS.map((n) => ({ title: n.title, summary: n.summary, time: n.time, source: 'iFinD MCP（演示占位）' })), asOf: DEMO_ASOF };
    }
    if (name === 'get_edb_data' || name === 'fetch_edb') {
      return { text: '[演示占位] 宏观指标需接入 iFinD MCP 后获取真实数值', items: [], asOf: null };
    }
    throw new ToolError(`演示 iFinD 未覆盖工具 ${name}`, 'unavailable', false);
  }
}
