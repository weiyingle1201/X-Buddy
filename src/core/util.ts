import { ToolError } from './types';

let seq = 0;
export function uid(prefix = 'id'): string {
  seq = (seq + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${seq.toString(36)}`;
}

/** 粗略 token 估算：中文约 1 字 ≈ 1 token，ASCII 约 4 字符 ≈ 1 token */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[　-鿿＀-￯]/.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ToolError('已停止', 'aborted', false));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new ToolError('已停止', 'aborted', false));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function withTimeout<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ToolError(`超时（>${ms}ms）`, 'timeout', true)), ms);
    if (signal) {
      onAbort = () => reject(new ToolError('已停止', 'aborted', false));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/** 最近一期“应已披露”的年报报告期：5 月后取上一年年报，否则取前年 */
export function latestAnnualReport(now: number): { report: string; year: number } {
  const d = new Date(now + 8 * 3600e3);
  const y = d.getUTCFullYear();
  const year = d.getUTCMonth() >= 4 ? y - 1 : y - 2;
  return { report: `${year}-4`, year };
}

export function fmtNum(v: number | string | null | undefined, unit?: string, digits = 2): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string') return unit ? `${v}${unit}` : v;
  if (!Number.isFinite(v)) return '—';
  if (unit === '元' && Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(digits)}亿元`;
  if (unit === '元' && Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(digits)}万元`;
  if (unit === '股' && Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(digits)}万股`;
  return `${v.toFixed(digits)}${unit ?? ''}`;
}

export function fmtDate(ms: number | null | undefined, withTime = false): string {
  if (!ms) return '—';
  // 统一按北京时间（Asia/Shanghai，UTC+8）展示，与数据源时区一致
  const d = new Date(ms + 8 * 3600e3);
  const p = (n: number) => String(n).padStart(2, '0');
  const s = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
  return withTime ? `${s} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}` : s;
}

export function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function stableKey(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableKey).join(',')}]`;
  const o = obj as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${k}:${stableKey(o[k])}`)
    .join(',')}}`;
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}
