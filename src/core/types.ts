// ============================================================
// X-Buddy 核心类型：线程 / 运行 / 任务 / 证据 / 产物 / 审批 / 观测
// ============================================================

export type DataMode = 'demo' | 'live';

/** 证据状态：ok 正常；demo 演示构造数据；missing 缺失；stale 过期；conflict 冲突；error 调用失败；derived 本地计算 */
export type EvidenceStatus = 'ok' | 'demo' | 'missing' | 'stale' | 'conflict' | 'error' | 'derived';

/** 工具权限级别：read 只读公开数据；sensitive_read 读取用户隐私（持仓/画像）；write 写入长期状态/导出 */
export type Permission = 'read' | 'sensitive_read' | 'write';

/** 结论类型：事实（可回到原始字段）/ 推断（基于事实的计算或判断）/ 不确定（数据缺失、冲突或无法验证） */
export type ClaimKind = 'fact' | 'inference' | 'uncertain';

export type Intent = 'stock' | 'compare' | 'market' | 'portfolio' | 'sector' | 'unknown';

export interface Evidence {
  id: string; // E-001
  runId: string;
  taskId: string;
  tool: string;
  source: string; // 例：扶摇 REST /api/a-share/prices/snapshot
  endpoint?: string;
  params?: Record<string, unknown>;
  entity?: string; // thscode
  entityName?: string;
  field: string; // 原始字段名，例 last_price
  label: string; // 中文名
  value: number | string | null;
  unit?: string;
  caliber?: string; // 统计口径
  asOf?: number | null; // 数据时点（毫秒）
  fetchedAt: number;
  status: EvidenceStatus;
  note?: string;
  derivedFrom?: string[];
  formula?: string;
  raw?: unknown;
}

export type EvidenceDraft = Omit<Evidence, 'id' | 'runId' | 'taskId' | 'tool' | 'fetchedAt'> & { fetchedAt?: number };

export interface Claim {
  kind: ClaimKind;
  text: string;
  evidenceIds: string[];
}

// ---------------- 动态 UI 块 ----------------
export interface KpiItem { label: string; value: number | string | null; unit?: string; evidenceId?: string; status?: EvidenceStatus; sub?: string; tone?: 'up' | 'down' | 'flat' }
export type UIBlock =
  | { type: 'kpis'; title?: string; items: KpiItem[] }
  | { type: 'line'; title: string; unit?: string; series: { name: string; points: [number, number][] }[]; evidenceIds?: string[]; caption?: string }
  | { type: 'bars'; title: string; unit?: string; items: { label: string; value: number | null; evidenceId?: string }[]; caption?: string }
  | { type: 'table'; title: string; columns: string[]; rows: { cells: (string | number | null)[]; evidenceIds?: (string | undefined)[] }[]; caption?: string }
  | { type: 'claims'; title?: string; items: Claim[] }
  | { type: 'quality'; title?: string; items: { evidenceId?: string; status: EvidenceStatus; text: string }[] }
  | { type: 'notice'; level: 'info' | 'warn' | 'error'; text: string };

export interface Artifact {
  id: string;
  runId: string;
  kind: 'report' | 'memo' | 'table';
  title: string;
  version: number;
  createdAt: number;
  blocks: UIBlock[];
  markdown: string;
  narrativeSource: 'template' | 'llm';
  partial: boolean;
}

// ---------------- 计划与任务 ----------------
export type TaskStatus = 'pending' | 'running' | 'waiting_approval' | 'done' | 'degraded' | 'failed' | 'skipped';

export interface PlanTask {
  id: string;
  title: string;
  capability: string;
  tool: string;
  args: Record<string, unknown>;
  dependsOn: string[];
  required: boolean;
  /** 依赖失败时仍运行（如撰写报告） */
  runAlways?: boolean;
  /** 完成后触发计划展开（两阶段规划） */
  expand?: boolean;
  status: TaskStatus;
  attempts: number;
  error?: string;
  degradedNote?: string;
  evidenceIds: string[];
  startedAt?: number;
  endedAt?: number;
  cacheHit?: boolean;
  summary?: string;
}

export type RunStatus = 'planning' | 'running' | 'awaiting_approval' | 'paused' | 'stopped' | 'completed' | 'failed' | 'interrupted';

export interface Approval {
  id: string;
  kind: 'tool' | 'budget' | 'memory_write' | 'clarify';
  title: string;
  detail: string;
  taskId?: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: number;
  resolvedAt?: number;
}

export interface Budget {
  maxToolCalls: number;
  maxSteps: number;
  maxWallMs: number;
  maxCostYuan: number;
  maxConsecutiveFailures: number;
  maxLlmTokens: number;
  /** 计划预估调用数超过该值需审批 */
  approveAboveCalls: number;
}

export interface Usage {
  toolCalls: number;
  apiCalls: number;
  cacheHits: number;
  retries: number;
  failures: number;
  consecutiveFailures: number;
  steps: number;
  llmCalls: number;
  tokensIn: number;
  tokensOut: number;
  costYuan: number;
  startedAt: number;
  wallMs: number;
}

export interface Span {
  id: string;
  parentId?: string;
  name: string;
  kind: 'run' | 'plan' | 'tool' | 'llm' | 'approval' | 'compaction' | 'checkpoint' | 'compose' | 'guard' | 'memory';
  start: number;
  end?: number;
  status: 'ok' | 'error' | 'degraded' | 'running';
  attrs: Record<string, string | number | boolean | undefined>;
}

export interface RunEvent {
  t: number;
  level: 'info' | 'warn' | 'error';
  type: string;
  text: string;
}

export interface ContextMessage {
  id: string;
  role: 'system' | 'user' | 'memory' | 'observation' | 'summary' | 'thread';
  text: string;
  tokens: number;
  pinned?: boolean;
  evidenceIds?: string[];
}

export interface ContextState {
  limitTokens: number;
  messages: ContextMessage[];
  compactions: { t: number; before: number; after: number; merged: number }[];
}

export interface RunState {
  id: string;
  threadId: string;
  goal: string;
  effectiveGoal: string;
  intent: Intent;
  mentions: string[];
  entities: { thscode: string; name: string }[];
  status: RunStatus;
  stopReason?: string;
  plan: PlanTask[];
  outputs: Record<string, unknown>;
  evidence: Evidence[];
  approvals: Approval[];
  artifacts: Artifact[];
  spans: Span[];
  events: RunEvent[];
  usage: Usage;
  budget: Budget;
  context: ContextState;
  degradations: string[];
  compliance: string[];
  memoryUsed: string[];
  checkpointSeq: number;
  plannerSource: 'rule' | 'llm';
  dataMode: DataMode;
  createdAt: number;
  updatedAt: number;
}

export interface Thread {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  runIds: string[];
  entities: { thscode: string; name: string }[];
}

export interface MemoryItem {
  id: string;
  kind: 'profile' | 'preference' | 'watchlist' | 'holding' | 'research_note';
  title: string;
  content: string;
  entity?: string;
  sensitive: boolean;
  createdAt: number;
  updatedAt: number;
  sourceRunId?: string;
  data?: unknown;
}

// ---------------- 工具 ----------------
export interface ToolContext {
  runId: string;
  taskId: string;
  signal: AbortSignal;
  run: RunState;
  outputs: Record<string, unknown>;
  now: () => number;
  attempt: number;
  fault?: FaultType;
  llmFault?: FaultType;
  recordLlm?: (u: { tokensIn: number; tokensOut: number; latencyMs: number; ok: boolean; note?: string }) => void;
}

export interface ToolResult {
  data: unknown;
  evidence: EvidenceDraft[];
  summary: string;
  /** 本次是否触达外部 API（用于计费/限流统计） */
  apiCalls?: number;
  degradedNote?: string;
}

export interface ToolSpec {
  name: string;
  title: string;
  capability: string;
  source: 'fuyao' | 'ifind' | 'local' | 'memory';
  endpoint?: string;
  description: string;
  permission: Permission;
  /** 参数校验：返回错误信息或 null */
  validate?: (args: Record<string, unknown>) => string | null;
  timeoutMs: number;
  maxRetries: number;
  cacheTtlMs: number;
  estCalls: number;
  fallbackTool?: string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export type FaultType = 'none' | 'error' | 'timeout' | 'empty' | 'stale' | 'rate_limit' | 'auth';

export interface Settings {
  dataMode: DataMode;
  fuyaoKey: string;
  fuyaoBase: string;
  ifindUrl: string;
  ifindToken: string;
  llmProvider: 'none' | 'openai' | 'anthropic';
  llmBase: string;
  llmModel: string;
  llmKey: string;
  llmPriceInPer1k: number;
  llmPriceOutPer1k: number;
  contextLimitTokens: number;
  budget: Budget;
  faults: Record<string, FaultType>;
  autoApproveRead: boolean;
  /** 演示模式下每次接口的模拟时延（毫秒），便于观察执行过程 */
  demoLatencyMs: number;
}

export class ToolError extends Error {
  constructor(
    message: string,
    public kind: 'timeout' | 'rate_limit' | 'auth' | 'param' | 'no_data' | 'network' | 'upstream' | 'aborted' | 'unavailable',
    public retryable: boolean,
    public code?: number,
  ) {
    super(message);
  }
}
