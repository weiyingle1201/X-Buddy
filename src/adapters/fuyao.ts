// 扶摇（同花顺金融数据 API）REST 客户端
// 文档：https://fuyao.aicubes.cn/docs/ ；鉴权头 X-api-key；统一 ApiResponse 信封
import { FaultType, ToolError } from '../core/types';
import { sleep } from '../core/util';

export interface Envelope {
  code: number;
  message: string;
  request_id?: string;
  data: any;
}

export interface CallOpts {
  signal?: AbortSignal;
  fault?: FaultType;
  attempt?: number;
}

export type Params = Record<string, string | number | undefined>;

export interface FuyaoApi {
  mode: 'live' | 'demo';
  get(path: string, params: Params, opts?: CallOpts): Promise<Envelope>;
}

/** 把扶摇业务码映射为 Harness 统一错误类型（决定是否重试/降级） */
export function mapEnvelopeError(env: Envelope, httpStatus = 200): ToolError | null {
  if (httpStatus === 429 || env.code === 4001) return new ToolError(`触发限流（code=${env.code || 429}）`, 'rate_limit', true, env.code || 429);
  if (env.code === 0) return null;
  // 注：文档写“缺失/无效 Key 返回 2001”，实测缺失与无效 Key 均返回 2003（message 区分），因此统一按鉴权错误处理并透出 message
  if (env.code === 2001 || env.code === 2003) return new ToolError(`鉴权失败：${env.message || 'API Key 无效或无权限'}（code=${env.code}）`, 'auth', false, env.code);
  if (env.code >= 1001 && env.code <= 1004) return new ToolError(`参数错误：${env.message}（code=${env.code}）`, 'param', false, env.code);
  if (env.code === 3001 || env.code === 3004) return new ToolError(`无有效数据：${env.message}（code=${env.code}）`, 'no_data', false, env.code);
  return new ToolError(`上游错误：${env.message}（code=${env.code}）`, 'upstream', env.code >= 5000, env.code);
}

/** 故障注入（用于故障演练与测试）：在真实/演示客户端外层统一生效 */
export async function applyFault(call: () => Promise<Envelope>, opts: CallOpts = {}): Promise<Envelope> {
  const f = opts.fault ?? 'none';
  if (f === 'error') throw new ToolError('上游服务错误（故障注入）', 'upstream', false, 5000);
  if (f === 'auth') throw new ToolError('API Key 缺失或无效（code=2001，故障注入）', 'auth', false, 2001);
  if (f === 'rate_limit' && (opts.attempt ?? 1) === 1) throw new ToolError('触发限流 HTTP 429（故障注入，首次）', 'rate_limit', true, 429);
  if (f === 'timeout') {
    await sleep(60_000, opts.signal);
  }
  const env = await call();
  if (f === 'empty' && env.data) {
    const d = { ...env.data };
    if (Array.isArray(d.item)) d.item = [];
    if (Array.isArray(d.items)) d.items = [];
    if (Array.isArray(d.abilities)) d.abilities = [];
    return { ...env, data: d };
  }
  if (f === 'stale' && env.data) {
    const shift = 10 * 86400e3;
    const d = { ...env.data };
    if (typeof d.timestamp === 'number') d.timestamp -= shift;
    if (Array.isArray(d.item)) d.item = d.item.map((it: any) => (typeof it?.date_ms === 'number' ? { ...it, date_ms: it.date_ms - shift } : it));
    return { ...env, data: d };
  }
  return env;
}

export class FuyaoLiveClient implements FuyaoApi {
  mode = 'live' as const;
  private chain: Promise<void> = Promise.resolve();
  constructor(private apiKey: string, private base = 'https://fuyao.aicubes.cn', private minIntervalMs = 250) {}

  /** 简单节流：串行化请求并保持最小间隔，避免触发 15 次/窗口 的限流 */
  private throttle(): Promise<void> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>((r) => (release = r));
    return prev.then(() => {
      setTimeout(release, this.minIntervalMs);
    });
  }

  async get(path: string, params: Params, opts: CallOpts = {}): Promise<Envelope> {
    return applyFault(async () => {
      if (!this.apiKey) throw new ToolError('未配置扶摇 API Key（请在设置中填写，或切换演示模式）', 'auth', false, 2001);
      await this.throttle();
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
      let res: Response;
      try {
        res = await fetch(`${this.base}${path}?${qs.toString()}`, { headers: { 'X-api-key': this.apiKey }, signal: opts.signal });
      } catch (e: any) {
        if (e?.name === 'AbortError') throw new ToolError('已停止', 'aborted', false);
        throw new ToolError(`网络错误：${e?.message ?? e}`, 'network', true);
      }
      let env: Envelope;
      try {
        env = (await res.json()) as Envelope;
      } catch {
        if (res.status === 429) throw new ToolError('触发限流 HTTP 429', 'rate_limit', true, 429);
        throw new ToolError(`响应不是合法 JSON（HTTP ${res.status}）`, 'upstream', res.status >= 500, res.status);
      }
      const err = mapEnvelopeError(env, res.status);
      if (err) throw err;
      return env;
    }, opts);
  }
}
