// iFinD MCP 客户端（Streamable HTTP / JSON-RPC 2.0）
// 文档：https://mcp.51ifind.com/ ；MCP 地址与密钥来自 iFinD 终端“一键复制”配置中的 url / Authorization。
// 浏览器直连受目标服务 CORS 策略限制，必要时使用仓库内 server/proxy.mjs 本地代理。
import { ToolError } from '../core/types';
import { CallOpts } from './fuyao';

export interface McpResult {
  text: string;
  items: { title: string; summary: string; time?: number; source?: string }[];
  asOf: number | null;
  raw?: unknown;
}

export interface McpApi {
  mode: 'live' | 'demo';
  available(): boolean;
  callTool(name: string, args: Record<string, unknown>, opts?: CallOpts): Promise<McpResult>;
}

export class IfindMcpClient implements McpApi {
  mode = 'live' as const;
  private sessionId: string | null = null;
  private nextId = 1;
  constructor(private url: string, private token: string) {}

  available() {
    return !!this.url && !!this.token;
  }

  private async rpc(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: this.token,
    };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    let res: Response;
    try {
      res = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }), signal });
    } catch (e: any) {
      if (e?.name === 'AbortError') throw new ToolError('已停止', 'aborted', false);
      throw new ToolError(`iFinD MCP 网络/CORS 错误：${e?.message ?? e}（可使用本地代理 server/proxy.mjs）`, 'network', true);
    }
    if (res.status === 401 || res.status === 403) throw new ToolError(`iFinD MCP 鉴权失败（HTTP ${res.status}）`, 'auth', false, res.status);
    if (res.status === 429) throw new ToolError('iFinD MCP 限流', 'rate_limit', true, 429);
    if (!res.ok) throw new ToolError(`iFinD MCP HTTP ${res.status}`, 'upstream', res.status >= 500, res.status);
    const sid = res.headers.get('Mcp-Session-Id');
    if (sid) this.sessionId = sid;
    const ct = res.headers.get('Content-Type') ?? '';
    const body = await res.text();
    let msg: any;
    if (ct.includes('text/event-stream')) {
      const lines = body.split('\n').filter((l) => l.startsWith('data:'));
      const last = lines.map((l) => l.slice(5).trim()).filter(Boolean).pop();
      msg = last ? JSON.parse(last) : null;
    } else {
      msg = body ? JSON.parse(body) : null;
    }
    if (msg?.error) throw new ToolError(`iFinD MCP 错误：${msg.error.message ?? JSON.stringify(msg.error)}`, 'upstream', false, msg.error.code);
    return msg?.result;
  }

  private async ensureInit(signal?: AbortSignal) {
    if (this.sessionId !== null) return;
    await this.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'x-buddy', version: '0.1.0' } }, signal);
    this.sessionId = this.sessionId ?? '';
  }

  async callTool(name: string, args: Record<string, unknown>, opts: CallOpts = {}): Promise<McpResult> {
    if (!this.available()) throw new ToolError('未配置 iFinD MCP（url / 密钥）', 'unavailable', false);
    if (opts.fault === 'error') throw new ToolError('iFinD MCP 调用失败（故障注入）', 'upstream', false);
    await this.ensureInit(opts.signal);
    const result = await this.rpc('tools/call', { name, arguments: args }, opts.signal);
    const text = (result?.content ?? [])
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text)
      .join('\n');
    if (result?.isError) throw new ToolError(`iFinD 工具返回错误：${text.slice(0, 200)}`, 'upstream', false);
    // iFinD 返回为文本/结构化片段，按段落切分为可引用的原文片段
    const items = text
      .split(/\n{2,}/)
      .map((t: string) => t.trim())
      .filter(Boolean)
      .slice(0, 8)
      .map((t: string) => ({ title: t.split('\n')[0].slice(0, 60), summary: t.slice(0, 300), source: `iFinD MCP ${name}` }));
    return { text, items, asOf: Date.now(), raw: result };
  }
}
