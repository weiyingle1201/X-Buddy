import { ToolSpec } from './types';

/** 能力/工具注册表：Agent 只能调用已注册且通过参数校验的工具 */
export class ToolRegistry {
  private tools = new Map<string, ToolSpec>();

  register(spec: ToolSpec): this {
    if (this.tools.has(spec.name)) throw new Error(`工具重复注册：${spec.name}`);
    if (spec.fallbackTool && spec.fallbackTool === spec.name) throw new Error(`工具不能以自身为降级：${spec.name}`);
    this.tools.set(spec.name, spec);
    return this;
  }

  get(name: string): ToolSpec | undefined {
    return this.tools.get(name);
  }

  has(name: string) {
    return this.tools.has(name);
  }

  list(): ToolSpec[] {
    return [...this.tools.values()];
  }

  capabilities(): Record<string, ToolSpec[]> {
    const out: Record<string, ToolSpec[]> = {};
    for (const t of this.tools.values()) (out[t.capability] ??= []).push(t);
    return out;
  }

  /** 给 LLM 的精简工具目录 */
  catalog(): string {
    return this.list()
      .map((t) => `- ${t.name}（${t.title}；能力:${t.capability}；权限:${t.permission}；来源:${t.source}${t.endpoint ? ' ' + t.endpoint : ''}）：${t.description}`)
      .join('\n');
  }

  validate(name: string, args: Record<string, unknown>): string | null {
    const t = this.tools.get(name);
    if (!t) return `未注册的工具：${name}`;
    return t.validate ? t.validate(args) : null;
  }
}
