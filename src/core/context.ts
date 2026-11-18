import { ContextMessage, ContextState } from './types';
import { estimateTokens, uid } from './util';

/**
 * 上下文管理：
 * - pinned 消息（系统约束、用户目标、记忆）永不压缩；
 * - 工具观测按时间追加；超过 limitTokens 时，把最早的观测合并为一条“摘要”，
 *   摘要保留证据 ID 与关键值，原始数据仍在证据账本中可追溯（压缩不丢证据，只丢冗余文本）。
 */
export class ContextManager {
  constructor(public state: ContextState) {}

  static create(limitTokens: number): ContextManager {
    return new ContextManager({ limitTokens, messages: [], compactions: [] });
  }

  total(): number {
    return this.state.messages.reduce((s, m) => s + m.tokens, 0);
  }

  add(role: ContextMessage['role'], text: string, opts: { pinned?: boolean; evidenceIds?: string[] } = {}): ContextMessage {
    const m: ContextMessage = { id: uid('c'), role, text, tokens: estimateTokens(text), pinned: opts.pinned, evidenceIds: opts.evidenceIds };
    this.state.messages.push(m);
    this.maybeCompact();
    return m;
  }

  maybeCompact(): boolean {
    if (this.total() <= this.state.limitTokens) return false;
    const before = this.total();
    const msgs = this.state.messages;
    const candidates = msgs.filter((m) => !m.pinned && (m.role === 'observation' || m.role === 'summary' || m.role === 'thread'));
    if (candidates.length < 2) return false;
    // 合并最早的一半观测（至少 2 条），直到低于阈值的 70%
    const merged: ContextMessage[] = [];
    for (const c of candidates) {
      merged.push(c);
      const remaining = before - merged.reduce((s, m) => s + m.tokens, 0);
      if (merged.length >= 2 && remaining < this.state.limitTokens * 0.7) break;
    }
    const ids = new Set(merged.map((m) => m.id));
    const evIds = [...new Set(merged.flatMap((m) => m.evidenceIds ?? []))];
    const lines = merged.map((m) => `· ${firstLine(m.text)}`);
    const text = `【压缩摘要】合并 ${merged.length} 条早期观测；完整数据见证据账本 ${compactIds(evIds)}。\n${lines.join('\n')}`;
    const summary: ContextMessage = { id: uid('c'), role: 'summary', text, tokens: estimateTokens(text), evidenceIds: evIds };
    const firstIdx = msgs.findIndex((m) => ids.has(m.id));
    const rest = msgs.filter((m) => !ids.has(m.id));
    rest.splice(Math.min(firstIdx, rest.length), 0, summary);
    this.state.messages = rest;
    this.state.compactions.push({ t: Date.now(), before, after: this.total(), merged: merged.length });
    return true;
  }

  /** 拼成发给 LLM 的上下文文本 */
  render(): string {
    return this.state.messages.map((m) => `[${m.role}] ${m.text}`).join('\n');
  }
}

function firstLine(s: string): string {
  const l = s.split('\n')[0];
  return l.length > 80 ? l.slice(0, 80) + '…' : l;
}

function compactIds(ids: string[]): string {
  if (ids.length <= 6) return ids.join(', ');
  return `${ids.slice(0, 3).join(', ')} … ${ids.slice(-2).join(', ')}（共 ${ids.length} 条）`;
}
