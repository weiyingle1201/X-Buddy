import { FaultType, Settings, ToolError } from './types';
import { estimateTokens, sleep, withTimeout } from './util';

export interface LlmResponse {
  text: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
}

export interface LlmClient {
  enabled(): boolean;
  label(): string;
  complete(system: string, user: string, opts?: { signal?: AbortSignal; fault?: FaultType; maxTokens?: number }): Promise<LlmResponse>;
}

/** 可选 LLM：OpenAI 兼容（DeepSeek/通义/Kimi 等）或 Anthropic；Key 只保存在浏览器会话内 */
export class HttpLlmClient implements LlmClient {
  constructor(private s: Pick<Settings, 'llmProvider' | 'llmBase' | 'llmModel' | 'llmKey'>, private timeoutMs = 25_000) {}

  enabled() {
    return this.s.llmProvider !== 'none' && !!this.s.llmKey && !!this.s.llmModel;
  }

  label() {
    return this.enabled() ? `${this.s.llmProvider}:${this.s.llmModel}` : '未启用（规则引擎）';
  }

  async complete(system: string, user: string, opts: { signal?: AbortSignal; fault?: FaultType; maxTokens?: number } = {}): Promise<LlmResponse> {
    const t0 = Date.now();
    if (opts.fault === 'error') throw new ToolError('LLM 服务错误（故障注入）', 'upstream', false);
    if (opts.fault === 'timeout') await sleep(this.timeoutMs + 1000, opts.signal).catch(() => undefined);
    if (opts.fault === 'timeout') throw new ToolError('LLM 超时（故障注入）', 'timeout', false);
    if (!this.enabled()) throw new ToolError('LLM 未配置', 'unavailable', false);
    const maxTokens = opts.maxTokens ?? 800;
    const call = async (): Promise<LlmResponse> => {
      if (this.s.llmProvider === 'anthropic') {
        const base = this.s.llmBase || 'https://api.anthropic.com';
        const res = await fetch(`${base.replace(/\/$/, '')}/v1/messages`, {
          method: 'POST',
          signal: opts.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': this.s.llmKey,
            'anthropic-version': '2023-06-01',
            'anthropic-dangerous-direct-browser-access': 'true',
          },
          body: JSON.stringify({ model: this.s.llmModel, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
        });
        if (!res.ok) throw new ToolError(`LLM HTTP ${res.status}`, res.status === 429 ? 'rate_limit' : 'upstream', res.status >= 500 || res.status === 429, res.status);
        const j = await res.json();
        const text = (j.content ?? []).map((c: any) => c.text ?? '').join('');
        return { text, tokensIn: j.usage?.input_tokens ?? estimateTokens(system + user), tokensOut: j.usage?.output_tokens ?? estimateTokens(text), latencyMs: Date.now() - t0 };
      }
      const base = this.s.llmBase || 'https://api.openai.com/v1';
      const res = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        signal: opts.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${this.s.llmKey}` },
        body: JSON.stringify({ model: this.s.llmModel, max_tokens: maxTokens, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
      });
      if (!res.ok) throw new ToolError(`LLM HTTP ${res.status}`, res.status === 429 ? 'rate_limit' : 'upstream', res.status >= 500 || res.status === 429, res.status);
      const j = await res.json();
      const text = j.choices?.[0]?.message?.content ?? '';
      return { text, tokensIn: j.usage?.prompt_tokens ?? estimateTokens(system + user), tokensOut: j.usage?.completion_tokens ?? estimateTokens(text), latencyMs: Date.now() - t0 };
    };
    try {
      return await withTimeout(call(), this.timeoutMs, opts.signal);
    } catch (e: any) {
      if (e instanceof ToolError) throw e;
      if (e?.name === 'AbortError') throw new ToolError('已停止', 'aborted', false);
      throw new ToolError(`LLM 网络/CORS 错误：${e?.message ?? e}`, 'network', false);
    }
  }
}

/** 测试用的脚本化 LLM */
export class ScriptedLlm implements LlmClient {
  calls: { system: string; user: string }[] = [];
  constructor(private responder: (system: string, user: string) => string | Error) {}
  enabled() {
    return true;
  }
  label() {
    return 'scripted';
  }
  async complete(system: string, user: string): Promise<LlmResponse> {
    this.calls.push({ system, user });
    const r = this.responder(system, user);
    if (r instanceof Error) throw r;
    return { text: r, tokensIn: estimateTokens(system + user), tokensOut: estimateTokens(r), latencyMs: 5 };
  }
}

/** 从 LLM 输出中提取首个 JSON 对象 */
export function extractJson(text: string): any | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}
