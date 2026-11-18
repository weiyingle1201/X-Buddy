import { FuyaoDemoClient, IfindDemoClient } from '../adapters/demo';
import { FuyaoLiveClient } from '../adapters/fuyao';
import { IfindMcpClient } from '../adapters/ifind';
import { HttpLlmClient, LlmClient } from '../core/llm';
import { MemoryStore } from '../core/memory';
import { AgentRuntime } from '../core/runtime';
import { KV } from '../core/store';
import { buildRegistry } from '../core/tools';
import { RunState, Settings } from '../core/types';

export interface Services {
  runtime: AgentRuntime;
  memory: MemoryStore;
  llm: LlmClient;
  registry: ReturnType<typeof buildRegistry>;
}

/** 根据设置装配数据源（演示/实时）、LLM 与运行时 */
export function buildServices(kv: KV, getSettings: () => Settings, onUpdate?: (r: RunState) => void, overrides: { llm?: LlmClient; backoffMs?: number; demoLatencyMs?: number } = {}): Services {
  const s = getSettings();
  const fuyao = s.dataMode === 'live' ? new FuyaoLiveClient(s.fuyaoKey, s.fuyaoBase) : new FuyaoDemoClient(overrides.demoLatencyMs ?? s.demoLatencyMs ?? 120);
  const ifind = s.dataMode === 'live' ? new IfindMcpClient(s.ifindUrl, s.ifindToken) : new IfindDemoClient();
  const llm = overrides.llm ?? new HttpLlmClient(s);
  const memory = new MemoryStore(kv);
  memory.seedIfEmpty();
  const registry = buildRegistry({ fuyao, ifind, memory, llm });
  const runtime = new AgentRuntime({ registry, kv, memory, llm, settings: getSettings, onUpdate, backoffMs: overrides.backoffMs });
  return { runtime, memory, llm, registry };
}
