// ============================================================
// 演示快照（构造数据）
// ------------------------------------------------------------
// ⚠️ 以下全部数值均为【人工构造的演示样例】，仅用于在无 API Key 时演示
// Agent 工作流、证据链与降级机制，不代表任何真实行情、财务或估值数据。
// 字段结构严格对齐扶摇（同花顺金融数据 API）文档的响应契约，
// 因此 Live 模式与 Demo 模式共用同一套解析与校验代码。
// 演示中刻意埋入：比亚迪指标冲突、中国平安毛利率缺失、中芯国际市现率缺失。
// ============================================================

export const DEMO_ASOF = Date.UTC(2026, 10, 17, 7, 0, 0); // 2026-11-17 15:00 Asia/Shanghai

export interface DemoStock {
  thscode: string;
  name: string;
  price: number;
  prev: number;
  vol: number; // 年化波动率（用于生成构造 K 线）
  val: { pe_ttm: number | null; pe_mrq: number | null; pb_mrq: number | null; ps_ttm: number | null; pcf_ttm: number | null };
  // FY2022..FY2025：营业收入、归母净利润、基本EPS（元）
  rev: number[];
  np: number[];
  eps: number[];
  gross: number | null; // 销售毛利率 %
  roe: number | null;
  debt: number | null; // 资产负债率 %
  current: number | null;
  /** 指标接口中的净利润同比（%）；null 表示与报表一致（自动计算） */
  npYoyOverride?: number;
  sectors: { thscode: string; name: string; type: 'industry' | 'cn_concept' | 'region' | 'tszs' }[];
}

const S = (code: string, name: string, type: DemoStock['sectors'][number]['type'] = 'industry') => ({ thscode: code, name, type });

export const DEMO_SECTORS = {
  baijiu: S('D10001.TI', '白酒（演示）'),
  battery: S('D10002.TI', '电池（演示）'),
  auto: S('D10003.TI', '汽车整车（演示）'),
  appliance: S('D10004.TI', '白色家电（演示）'),
  insurance: S('D10005.TI', '保险（演示）'),
  bank: S('D10006.TI', '银行（演示）'),
  semi: S('D10007.TI', '半导体（演示）'),
  nev: S('D20001.TI', '新能源汽车（演示概念）', 'cn_concept'),
  consumer: S('D20002.TI', '消费龙头（演示概念）', 'cn_concept'),
};

export const DEMO_STOCKS: DemoStock[] = [
  {
    thscode: '600519.SH', name: '贵州茅台', price: 1450.2, prev: 1442.0, vol: 0.22,
    val: { pe_ttm: 20.6, pe_mrq: 19.8, pb_mrq: 7.1, ps_ttm: 10.0, pcf_ttm: 22.4 },
    rev: [1275.5e8, 1505.6e8, 1741.4e8, 1852.0e8], np: [627.2e8, 747.3e8, 862.3e8, 905.0e8], eps: [49.93, 59.49, 68.64, 72.05],
    gross: 91.8, roe: 34.5, debt: 14.0, current: 5.1,
    sectors: [DEMO_SECTORS.baijiu, DEMO_SECTORS.consumer],
  },
  {
    thscode: '000858.SZ', name: '五粮液', price: 118.5, prev: 119.3, vol: 0.27,
    val: { pe_ttm: 14.8, pe_mrq: 14.2, pb_mrq: 3.4, ps_ttm: 5.3, pcf_ttm: 15.1 },
    rev: [739.7e8, 832.7e8, 891.8e8, 862.0e8], np: [266.9e8, 302.1e8, 318.5e8, 300.2e8], eps: [6.88, 7.78, 8.21, 7.73],
    gross: 76.9, roe: 23.1, debt: 21.5, current: 3.9,
    sectors: [DEMO_SECTORS.baijiu, DEMO_SECTORS.consumer],
  },
  {
    thscode: '300750.SZ', name: '宁德时代', price: 372.4, prev: 365.1, vol: 0.38,
    val: { pe_ttm: 24.3, pe_mrq: 22.9, pb_mrq: 5.2, ps_ttm: 3.9, pcf_ttm: 12.6 },
    rev: [3285.9e8, 4009.2e8, 3620.1e8, 4105.0e8], np: [307.3e8, 441.2e8, 507.4e8, 640.5e8], eps: [13.0, 10.0, 11.6, 14.6],
    gross: 24.4, roe: 22.8, debt: 69.9, current: 1.7,
    sectors: [DEMO_SECTORS.battery, DEMO_SECTORS.nev],
  },
  {
    thscode: '002594.SZ', name: '比亚迪', price: 102.3, prev: 103.9, vol: 0.36,
    val: { pe_ttm: 21.5, pe_mrq: 23.0, pb_mrq: 4.4, ps_ttm: 1.1, pcf_ttm: 6.8 },
    rev: [4240.6e8, 6023.2e8, 7771.0e8, 8120.0e8], np: [166.2e8, 300.4e8, 402.5e8, 352.0e8], eps: [5.71, 10.32, 13.84, 12.10],
    gross: 18.9, roe: 18.7, debt: 74.6, current: 0.8,
    npYoyOverride: 8.3, // 刻意与利润表推算值（约 -12.5%）冲突，用于演示冲突检测
    sectors: [DEMO_SECTORS.auto, DEMO_SECTORS.nev],
  },
  {
    thscode: '000333.SZ', name: '美的集团', price: 78.9, prev: 78.2, vol: 0.25,
    val: { pe_ttm: 13.2, pe_mrq: 12.6, pb_mrq: 2.7, ps_ttm: 1.3, pcf_ttm: 9.4 },
    rev: [3457.1e8, 3737.1e8, 4090.8e8, 4420.0e8], np: [295.5e8, 337.2e8, 385.4e8, 431.0e8], eps: [4.34, 4.93, 5.44, 5.95],
    gross: 26.5, roe: 21.3, debt: 63.1, current: 1.1,
    sectors: [DEMO_SECTORS.appliance, DEMO_SECTORS.consumer],
  },
  {
    thscode: '601318.SH', name: '中国平安', price: 56.3, prev: 56.6, vol: 0.24,
    val: { pe_ttm: 7.9, pe_mrq: 7.4, pb_mrq: 0.95, ps_ttm: 0.97, pcf_ttm: 4.1 },
    rev: [11105.7e8, 9137.9e8, 10289.3e8, 10560.0e8], np: [837.7e8, 856.7e8, 1266.1e8, 1340.0e8], eps: [4.62, 4.70, 7.16, 7.55],
    gross: null, roe: 11.9, debt: 89.6, current: null, // 保险业不适用毛利率/流动比率 → 缺失演示
    sectors: [DEMO_SECTORS.insurance],
  },
  {
    thscode: '600036.SH', name: '招商银行', price: 44.1, prev: 43.8, vol: 0.2,
    val: { pe_ttm: 6.8, pe_mrq: 6.5, pb_mrq: 0.92, ps_ttm: 3.3, pcf_ttm: null },
    rev: [3447.8e8, 3391.2e8, 3374.9e8, 3360.0e8], np: [1380.1e8, 1466.0e8, 1483.9e8, 1502.0e8], eps: [5.26, 5.66, 5.66, 5.73],
    gross: null, roe: 13.4, debt: 90.7, current: null,
    sectors: [DEMO_SECTORS.bank],
  },
  {
    thscode: '688981.SH', name: '中芯国际', price: 112.6, prev: 108.9, vol: 0.55,
    val: { pe_ttm: 180.5, pe_mrq: 160.2, pb_mrq: 4.9, ps_ttm: 12.1, pcf_ttm: null },
    rev: [495.2e8, 452.5e8, 578.0e8, 690.0e8], np: [121.3e8, 48.2e8, 37.0e8, 50.5e8], eps: [1.53, 0.61, 0.46, 0.63],
    gross: 21.5, roe: 3.6, debt: 34.2, current: 2.5,
    sectors: [DEMO_SECTORS.semi],
  },
];

export const DEMO_INDICES = [
  { thscode: '000001.SH', name: '上证指数', price: 3421.5, prev: 3407.2, vol: 0.16 },
  { thscode: '399001.SZ', name: '深证成指', price: 10982.3, prev: 10998.8, vol: 0.2 },
  { thscode: '399006.SZ', name: '创业板指', price: 2295.1, prev: 2275.1, vol: 0.27 },
  { thscode: '000300.SH', name: '沪深300', price: 4012.6, prev: 4000.2, vol: 0.17 },
];

export const DEMO_HOLDINGS = [
  // 构造的匿名持仓（权重%），不对应任何真实用户
  { thscode: '600519.SH', name: '贵州茅台', weight: 30 },
  { thscode: '300750.SZ', name: '宁德时代', weight: 25 },
  { thscode: '000333.SZ', name: '美的集团', weight: 20 },
  { thscode: '601318.SH', name: '中国平安', weight: 15 },
  { thscode: 'CASH', name: '现金', weight: 10 },
];

// ---------------- 确定性伪随机 ----------------
function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 演示交易日：工作日（不含节假日，仅演示） */
export function demoTradingDays(endMs: number, count: number): number[] {
  const days: number[] = [];
  // 以上海时区 00:00 对齐
  let d = new Date(endMs + 8 * 3600e3);
  d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600e3);
  let t = d.getTime();
  while (days.length < count) {
    const wd = new Date(t + 8 * 3600e3).getUTCDay();
    if (wd !== 0 && wd !== 6) days.push(t);
    t -= 86400e3;
  }
  return days.reverse();
}

/** 生成以最终价收尾的构造日 K（倒推随机游走） */
export function demoKline(code: string, lastClose: number, annualVol: number, count = 250) {
  const rnd = mulberry32(hashStr(code));
  const days = demoTradingDays(DEMO_ASOF, count);
  const dailyVol = annualVol / Math.sqrt(242);
  const closes: number[] = new Array(count);
  closes[count - 1] = lastClose;
  for (let i = count - 2; i >= 0; i--) {
    const z = (rnd() + rnd() + rnd() - 1.5) * 2; // 近似正态
    closes[i] = closes[i + 1] / Math.exp(z * dailyVol + 0.0002);
  }
  return days.map((date_ms, i) => {
    const c = +closes[i].toFixed(2);
    const o = +(i ? closes[i - 1] : c).toFixed(2);
    const hi = +(Math.max(o, c) * (1 + rnd() * dailyVol)).toFixed(2);
    const lo = +(Math.min(o, c) * (1 - rnd() * dailyVol)).toFixed(2);
    const volume = Math.round(1e6 * (2 + rnd() * 3));
    return { date_ms, open_price: o, high_price: hi, low_price: lo, close_price: c, volume, turnover: Math.round(volume * c) };
  });
}

export const DEMO_NEWS: { title: string; summary: string; time: number; entity?: string }[] = [
  { title: '[演示占位] 资讯检索结果', summary: '演示模式不提供真实新闻。接入 iFinD MCP（search_news）或扶摇快讯接口后，此处展示带时间与来源的原文片段。', time: DEMO_ASOF - 3600e3 },
  { title: '[演示占位] 公告检索结果', summary: '演示模式不提供真实公告。接入 iFinD MCP（search_notice）后，可回溯到公告原文段落。', time: DEMO_ASOF - 7200e3 },
];
