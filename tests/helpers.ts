import { buildServices } from '../src/app/services';
import { DEFAULT_SETTINGS } from '../src/app/settings';
import { LlmClient } from '../src/core/llm';
import { MemoryKV } from '../src/core/store';
import { RunState, Settings } from '../src/core/types';

export function setup(over: Partial<Settings> = {}, opts: { llm?: LlmClient; kv?: MemoryKV } = {}) {
  const kv = opts.kv ?? new MemoryKV();
  const settings: Settings = { ...DEFAULT_SETTINGS, budget: { ...DEFAULT_SETTINGS.budget }, faults: {}, ...over };
  const sv = buildServices(kv, () => settings, undefined, { backoffMs: 0, demoLatencyMs: 1, llm: opts.llm });
  return { kv, settings, ...sv };
}

/** 运行到结束：自动批准所有审批（或按 decide 决定） */
export async function runToEnd(sv: ReturnType<typeof setup>, goal: string, decide: (title: string) => boolean = () => true, threadId = 'th'): Promise<RunState> {
  const run = await sv.runtime.createRun(threadId, goal);
  if (run.status === 'running') await sv.runtime.start(run.id);
  for (let i = 0; i < 10; i++) {
    const r = sv.runtime.get(run.id)!;
    const ap = r.approvals.find((a) => a.status === 'pending');
    if (!ap) break;
    await sv.runtime.approve(r.id, ap.id, decide(ap.title));
  }
  return sv.runtime.get(run.id)!;
}

export const claimsOf = (r: RunState) => r.artifacts.at(-1)!.blocks.flatMap((b) => (b.type === 'claims' ? b.items : []));
export const ev = (r: RunState, field: string, entity?: string) => r.evidence.filter((e) => e.field === field && (!entity || e.entity === entity)).at(-1);
