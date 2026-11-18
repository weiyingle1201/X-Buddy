// ============================================================
// Agent Runtime（Harness 主循环）
// 规划 → 预算审批 → 按依赖并发执行（权限/审批/缓存/超时/重试/降级）→ 证据入账
// → 上下文压缩 → 检查点 → 停止规则 → 报告；支持停止、恢复、回滚到任意检查点
// ============================================================
import { guardInput } from './compliance';
import { ContextManager } from './context';
import { LlmClient } from './llm';
import { MemoryStore } from './memory';
import { expandPlan, initialPlan, llmParse, ParsedGoal, ruleParse } from './planner';
import { ToolRegistry } from './registry';
import { KV } from './store';
import { Approval, Artifact, Budget, Evidence, Intent, PlanTask, RunState, Settings, Span, ToolError, ToolResult, ToolSpec } from './types';
import { deepClone, sleep, stableKey, uid, withTimeout } from './util';

export interface RuntimeDeps {
  registry: ToolRegistry;
  kv: KV;
  memory: MemoryStore;
  llm: LlmClient;
  settings: () => Settings;
  now?: () => number;
  onUpdate?: (run: RunState) => void;
  /** 重试退避基数（测试可设为 0） */
  backoffMs?: number;
  concurrency?: number;
}

export interface CheckpointMeta {
  seq: number;
  label: string;
  t: number;
  done: number;
  total: number;
  status: RunState['status'];
}

const TERMINAL = new Set(['done', 'degraded', 'failed', 'skipped']);
const OK = new Set(['done', 'degraded']);
const MAX_CKPT = 15;

export const DEFAULT_BUDGET: Budget = {
  maxToolCalls: 40,
  maxSteps: 40,
  maxWallMs: 180_000,
  maxCostYuan: 0.5,
  maxConsecutiveFailures: 4,
  maxLlmTokens: 30_000,
  approveAboveCalls: 12,
};

export function estimateCalls(intent: Intent, mentions: number): number {
  switch (intent) {
    case 'stock':
      return 8;
    case 'compare':
      return 2 + 3 * Math.max(2, mentions) + mentions;
    case 'market':
      return 5;
    case 'portfolio':
      return 3;
    case 'sector':
      return 5;
    default:
      return 1;
  }
}

export class AgentRuntime {
  private aborts = new Map<string, AbortController>();
  private cache = new Map<string, { t: number; result: ToolResult }>();
  private stopFlags = new Set<string>();
  private active = new Map<string, Promise<void>>();
  private runs = new Map<string, RunState>();
  /** 鉴权失败的运行：同一数据源的后续调用必然失败，直接熔断 */
  private authTripped = new Set<string>();
  private now: () => number;

  constructor(private d: RuntimeDeps) {
    this.now = d.now ?? Date.now;
  }

  // ---------------- 持久化 ----------------
  get(runId: string): RunState | undefined {
    if (this.runs.has(runId)) return this.runs.get(runId);
    const r = this.d.kv.get<RunState>(`run:${runId}`);
    if (r) this.runs.set(runId, r);
    return r ?? undefined;
  }

  private save(run: RunState) {
    run.updatedAt = this.now();
    this.runs.set(run.id, run);
    this.d.kv.set(`run:${run.id}`, run);
    this.d.onUpdate?.(run);
  }

  checkpoint(run: RunState, label: string) {
    run.checkpointSeq += 1;
    const seq = run.checkpointSeq;
    const sp = this.span(run, `checkpoint #${seq}`, 'checkpoint', { label });
    this.d.kv.set(`ckpt:${run.id}:${String(seq).padStart(4, '0')}`, deepClone(run));
    const metas = this.listCheckpoints(run.id);
    metas.push({ seq, label, t: this.now(), done: run.plan.filter((t) => TERMINAL.has(t.status)).length, total: run.plan.length, status: run.status });
    while (metas.length > MAX_CKPT) {
      const old = metas.shift()!;
      this.d.kv.del(`ckpt:${run.id}:${String(old.seq).padStart(4, '0')}`);
    }
    this.d.kv.set(`ckptmeta:${run.id}`, metas);
    this.end(sp, 'ok');
    this.save(run);
  }

  listCheckpoints(runId: string): CheckpointMeta[] {
    return this.d.kv.get<CheckpointMeta[]>(`ckptmeta:${runId}`) ?? [];
  }

  /** 页面刷新/崩溃后：把仍处于运行态的 run 标记为“中断”，等待用户从检查点恢复 */
  recoverInterrupted(runIds: string[]): string[] {
    const out: string[] = [];
    for (const id of runIds) {
      const r = this.get(id);
      if (r && (r.status === 'running' || r.status === 'planning') && !this.active.has(id)) {
        r.status = 'interrupted';
        this.event(r, 'warn', 'interrupted', '检测到运行被中断（页面刷新/关闭/崩溃），可从最近检查点继续');
        this.save(r);
        out.push(id);
      }
    }
    return out;
  }

  // ---------------- 观测 ----------------
  private span(run: RunState, name: string, kind: Span['kind'], attrs: Span['attrs'] = {}, parentId?: string): Span {
    const s: Span = { id: uid('sp'), parentId, name, kind, start: this.now(), status: 'running', attrs };
    run.spans.push(s);
    if (run.spans.length > 400) run.spans.splice(0, run.spans.length - 400);
    return s;
  }
  private end(s: Span, status: Span['status'], attrs: Span['attrs'] = {}) {
    s.end = this.now();
    s.status = status;
    Object.assign(s.attrs, attrs);
  }
  private event(run: RunState, level: 'info' | 'warn' | 'error', type: string, text: string) {
    run.events.push({ t: this.now(), level, type, text });
    if (run.events.length > 300) run.events.splice(0, run.events.length - 300);
  }

  private recordLlm(run: RunState, u: { tokensIn: number; tokensOut: number; latencyMs: number; ok: boolean; note?: string }, name: string) {
    const s = this.settingsSafe();
    run.usage.llmCalls += 1;
    run.usage.tokensIn += u.tokensIn;
    run.usage.tokensOut += u.tokensOut;
    run.usage.costYuan += (u.tokensIn / 1000) * s.llmPriceInPer1k + (u.tokensOut / 1000) * s.llmPriceOutPer1k;
    const sp = this.span(run, name, 'llm', { tokensIn: u.tokensIn, tokensOut: u.tokensOut, latencyMs: u.latencyMs, note: u.note });
    sp.start -= u.latencyMs;
    this.end(sp, u.ok ? 'ok' : 'degraded');
  }

  private settingsSafe(): Settings {
    return this.d.settings();
  }

  // ---------------- 创建运行（输入合规 → 记忆检索 → 规划） ----------------
  async createRun(threadId: string, goal: string, opts: { threadEntities?: { thscode: string; name: string }[]; threadNotes?: string[] } = {}): Promise<RunState> {
    const s = this.settingsSafe();
    const t = this.now();
    const run: RunState = {
      id: uid('run'),
      threadId,
      goal,
      effectiveGoal: goal,
      intent: 'unknown',
      mentions: [],
      entities: [],
      status: 'planning',
      plan: [],
      outputs: {},
      evidence: [],
      approvals: [],
      artifacts: [],
      spans: [],
      events: [],
      usage: { toolCalls: 0, apiCalls: 0, cacheHits: 0, retries: 0, failures: 0, consecutiveFailures: 0, steps: 0, llmCalls: 0, tokensIn: 0, tokensOut: 0, costYuan: 0, startedAt: t, wallMs: 0 },
      budget: { ...s.budget },
      context: { limitTokens: s.contextLimitTokens, messages: [], compactions: [] },
      degradations: [],
      compliance: [],
      memoryUsed: [],
      checkpointSeq: 0,
      plannerSource: 'rule',
      dataMode: s.dataMode,
      createdAt: t,
      updatedAt: t,
    };
    const root = this.span(run, '创建运行', 'run', { goal });
    const ctx = new ContextManager(run.context);
    ctx.add('system', '约束：不输出确定性涨跌预测、收益承诺或买卖建议；事实需可追溯到原始字段并注明来源/时点/单位/口径；缺失、冲突、过期须显式说明。', { pinned: true });

    // 1) 输入侧合规
    const g = this.span(run, '输入合规审查', 'guard', {}, root.id);
    const guard = guardInput(goal);
    this.end(g, guard.flags.length ? 'degraded' : 'ok', { flags: guard.flags.join(',') });
    if (guard.blocked) {
      run.compliance.push(guard.message!);
      run.status = 'completed';
      run.artifacts.push(this.refusalArtifact(run, guard.message!));
      this.event(run, 'warn', 'compliance', guard.message!);
      this.end(root, 'degraded');
      this.save(run);
      return run;
    }
    if (guard.flags.length) {
      run.compliance.push(guard.message!);
      run.effectiveGoal = guard.effectiveGoal;
      this.event(run, 'warn', 'compliance', `${guard.message} 改写后目标：${guard.effectiveGoal}`);
    }
    ctx.add('user', `研究目标：${run.effectiveGoal}`, { pinned: true });
    for (const n of opts.threadNotes ?? []) ctx.add('thread', n);

    // 2) 规划：LLM 理解（可选，带 schema 校验）→ 失败降级规则规划
    const p = this.span(run, '规划', 'plan', {}, root.id);
    let parsed: ParsedGoal | null = null;
    if (this.d.llm.enabled()) {
      const r = await llmParse(guard.parseGoal, this.d.llm, this.d.registry.catalog());
      this.recordLlm(run, { tokensIn: r.tokensIn, tokensOut: r.tokensOut, latencyMs: 0, ok: !!r.parsed, note: r.error }, 'LLM 意图/实体解析');
      if (r.parsed) {
        parsed = r.parsed;
        run.plannerSource = 'llm';
      } else {
        run.degradations.push(`LLM 规划失败（${r.error}），已降级为规则规划`);
        this.event(run, 'warn', 'degrade', `LLM 规划失败（${r.error}），降级为规则规划`);
      }
    }
    if (!parsed) parsed = ruleParse(guard.parseGoal, opts.threadEntities ?? []);
    run.intent = parsed.intent;
    run.mentions = parsed.mentions;
    run.plan = initialPlan(parsed, t, opts.threadEntities ?? []);
    this.end(p, 'ok', { intent: parsed.intent, source: parsed.source, tasks: run.plan.length });
    this.event(run, 'info', 'plan', `意图：${intentLabel(parsed.intent)}；提及：${parsed.mentions.join('、') || '无'}；初始计划 ${run.plan.length} 个任务（规划器：${parsed.source}）`);

    // 3) 记忆检索（非敏感项自动注入；持仓需工具授权）
    const mem = this.span(run, '记忆检索', 'memory', {}, root.id);
    const hints = Object.values(parsed.resolvedHints);
    const mems = this.d.memory.retrieve(run.effectiveGoal, [...hints, ...(opts.threadEntities ?? []).map((e) => e.thscode)]);
    for (const { item, stale } of mems) {
      ctx.add('memory', `${item.title}：${item.content}${stale ? '（超过30天，可能过期）' : ''}`, { pinned: item.kind !== 'research_note' });
      run.memoryUsed.push(item.id);
    }
    this.end(mem, 'ok', { items: mems.length });

    // 4) 预算审批
    const est = estimateCalls(parsed.intent, parsed.mentions.length);
    if (est > run.budget.approveAboveCalls || !s.autoApproveRead) {
      run.approvals.push(this.mkApproval('budget', `预计调用约 ${est} 次数据接口`, `意图：${intentLabel(parsed.intent)}。预算上限：工具调用 ${run.budget.maxToolCalls} 次、${Math.round(run.budget.maxWallMs / 1000)} 秒、LLM ¥${run.budget.maxCostYuan}。数据模式：${s.dataMode === 'demo' ? '演示' : '实时（会消耗 API 配额）'}。是否开始执行？`));
    }
    run.status = run.approvals.some((a) => a.status === 'pending') ? 'awaiting_approval' : 'running';
    this.end(root, 'ok');
    this.checkpoint(run, '规划完成');
    return run;
  }

  private refusalArtifact(run: RunState, msg: string): Artifact {
    return {
      id: uid('art'),
      runId: run.id,
      kind: 'memo',
      title: '无法协助的请求',
      version: 1,
      createdAt: this.now(),
      blocks: [
        { type: 'notice', level: 'error', text: msg },
        { type: 'notice', level: 'info', text: '可以改为：研究公司公开披露的财务与估值数据、对比同业指标、梳理公开风险因素。' },
      ],
      markdown: `# 无法协助的请求\n\n${msg}`,
      narrativeSource: 'template',
      partial: false,
    };
  }

  private mkApproval(kind: Approval['kind'], title: string, detail: string, taskId?: string): Approval {
    return { id: uid('ap'), kind, title, detail, taskId, status: 'pending', createdAt: this.now() };
  }

  // ---------------- 控制 ----------------
  start(runId: string): Promise<void> {
    const run = this.get(runId);
    if (!run) return Promise.resolve();
    if (this.active.has(runId)) return this.active.get(runId)!;
    const p = this.drive(run).finally(() => this.active.delete(runId));
    this.active.set(runId, p);
    return p;
  }

  isActive(runId: string) {
    return this.active.has(runId);
  }

  async approve(runId: string, approvalId: string, yes: boolean): Promise<void> {
    const run = this.get(runId);
    if (!run) return;
    const ap = run.approvals.find((a) => a.id === approvalId);
    if (!ap || ap.status !== 'pending') return;
    ap.status = yes ? 'approved' : 'rejected';
    ap.resolvedAt = this.now();
    const sp = this.span(run, `审批：${ap.title}`, 'approval', { decision: ap.status, kind: ap.kind });
    sp.start = ap.createdAt;
    this.end(sp, yes ? 'ok' : 'degraded');
    this.event(run, yes ? 'info' : 'warn', 'approval', `${yes ? '已批准' : '已拒绝'}：${ap.title}`);
    if (ap.taskId) {
      const t = run.plan.find((x) => x.id === ap.taskId);
      if (t && t.status === 'waiting_approval') {
        if (yes) t.status = 'pending';
        else {
          t.status = 'skipped';
          t.error = '用户拒绝授权';
        }
      }
    }
    if (ap.kind === 'budget' && !yes) {
      run.status = 'stopped';
      run.stopReason = '用户拒绝执行预算';
      for (const t of run.plan) if (!TERMINAL.has(t.status)) {
        t.status = 'skipped';
        t.error = '用户拒绝执行';
      }
      this.checkpoint(run, '用户拒绝预算');
      return;
    }
    run.status = 'running';
    this.checkpoint(run, `审批：${ap.title}`);
    await this.start(runId);
  }

  stop(runId: string) {
    this.stopFlags.add(runId);
    this.aborts.get(runId)?.abort();
    const run = this.get(runId);
    if (run && !this.active.has(runId) && !['completed', 'failed', 'stopped'].includes(run.status)) {
      run.status = 'stopped';
      run.stopReason = '用户手动停止';
      this.event(run, 'warn', 'stop', '用户手动停止');
      this.checkpoint(run, '用户停止');
    }
  }

  /** 从当前状态继续（中断/暂停/停止后），可选放宽预算 */
  async resume(runId: string, opts: { extendBudget?: boolean } = {}): Promise<void> {
    const run = this.get(runId);
    if (!run || this.active.has(runId)) return;
    this.stopFlags.delete(runId);
    this.authTripped.delete(runId);
    for (const t of run.plan) {
      if (t.status === 'running') t.status = 'pending';
      if (t.status === 'skipped' && (t.error === '运行已停止' || t.error === '用户拒绝执行')) {
        t.status = 'pending';
        t.error = undefined;
      }
    }
    if (opts.extendBudget) {
      run.budget.maxToolCalls *= 2;
      run.budget.maxSteps *= 2;
      run.budget.maxWallMs *= 2;
      run.budget.maxCostYuan *= 2;
      run.budget.maxLlmTokens *= 2;
      run.usage.consecutiveFailures = 0;
      this.event(run, 'info', 'budget', '预算已放宽 ×2');
    }
    for (const a of run.approvals) if (a.kind === 'budget' && a.status === 'rejected') a.status = 'approved';
    run.stopReason = undefined;
    // 已生成的部分报告在继续执行后会产生新版本
    const rep = run.plan.find((t) => t.tool === 'compose_report');
    if (rep && rep.status === 'done' && run.plan.some((t) => t.status === 'pending' && t.id !== rep.id)) rep.status = 'pending';
    run.status = run.approvals.some((a) => a.status === 'pending') ? 'awaiting_approval' : 'running';
    this.event(run, 'info', 'resume', '从当前检查点继续执行');
    this.save(run);
    if (run.status === 'running') await this.start(runId);
  }

  /** 回滚到指定检查点（之后的证据/产物被丢弃），状态置为暂停 */
  restore(runId: string, seq: number): RunState | undefined {
    if (this.active.has(runId)) return undefined; // 运行中不可回滚，需先停止
    const snap = this.d.kv.get<RunState>(`ckpt:${runId}:${String(seq).padStart(4, '0')}`);
    if (!snap) return undefined;
    const cur = this.get(runId);
    const restored = deepClone(snap);
    restored.checkpointSeq = cur?.checkpointSeq ?? restored.checkpointSeq; // 序号单调递增
    for (const t of restored.plan) if (t.status === 'running') t.status = 'pending';
    restored.status = restored.status === 'completed' ? 'completed' : 'paused';
    restored.spans = [...(cur?.spans ?? restored.spans)];
    restored.events = [...(cur?.events ?? restored.events)];
    this.event(restored, 'info', 'restore', `已回滚到检查点 #${seq}`);
    this.runs.set(runId, restored);
    this.checkpoint(restored, `回滚至 #${seq}`);
    return restored;
  }

  /** 停止后基于已有证据生成部分报告 */
  async finalizePartial(runId: string): Promise<void> {
    const run = this.get(runId);
    if (!run || this.active.has(runId)) return;
    this.stopFlags.delete(runId);
    let rep = run.plan.find((t) => t.tool === 'compose_report');
    if (!rep) {
      rep = { id: 't_report', title: '撰写部分报告', capability: '产物', tool: 'compose_report', args: { mode: run.intent === 'unknown' ? 'unresolved' : run.intent }, dependsOn: [], required: true, runAlways: true, status: 'pending', attempts: 0, evidenceIds: [] };
      run.plan.push(rep);
    }
    if (!run.outputs['t_calc'] && run.plan.find((t) => t.id === 't_calc')) {
      const calc = run.plan.find((t) => t.id === 't_calc')!;
      await this.execute(run, calc, new AbortController().signal);
    }
    for (const t of run.plan) if (!TERMINAL.has(t.status) && t !== rep) {
      t.status = 'skipped';
      t.error = '运行已停止';
    }
    rep.status = 'pending';
    run.stopReason = run.stopReason ?? '用户手动停止';
    await this.execute(run, rep, new AbortController().signal);
    run.status = 'stopped';
    this.checkpoint(run, '生成部分报告');
  }

  // ---------------- 主循环 ----------------
  private stopRule(run: RunState): string | null {
    const b = run.budget;
    const u = run.usage;
    if (this.authTripped.has(run.id)) return '数据源鉴权失败（请检查 API Key 或切换演示模式），已熔断';
    if (u.toolCalls >= b.maxToolCalls) return `工具调用次数达到上限（${b.maxToolCalls}）`;
    if (u.steps >= b.maxSteps) return `执行步数达到上限（${b.maxSteps}）`;
    if (u.wallMs >= b.maxWallMs) return `运行时长达到上限（${Math.round(b.maxWallMs / 1000)}s）`;
    if (u.costYuan >= b.maxCostYuan) return `成本达到上限（¥${b.maxCostYuan}）`;
    if (u.tokensIn + u.tokensOut >= b.maxLlmTokens) return `LLM Token 达到上限（${b.maxLlmTokens}）`;
    if (u.consecutiveFailures >= b.maxConsecutiveFailures) return `连续失败 ${u.consecutiveFailures} 次，触发熔断`;
    return null;
  }

  private async drive(run: RunState): Promise<void> {
    const ac = new AbortController();
    this.aborts.set(run.id, ac);
    const conc = this.d.concurrency ?? 3;
    try {
      while (true) {
        if (this.stopFlags.has(run.id)) {
          this.stopFlags.delete(run.id);
          for (const t of run.plan) if (t.status === 'running') t.status = 'pending';
          run.status = 'stopped';
          run.stopReason = '用户手动停止';
          this.event(run, 'warn', 'stop', '用户手动停止；可“继续执行”或“生成部分报告”');
          this.checkpoint(run, '用户停止');
          return;
        }
        if (run.approvals.some((a) => a.kind === 'budget' && a.status === 'pending')) {
          run.status = 'awaiting_approval';
          this.save(run);
          return;
        }
        const reason = this.stopRule(run);
        if (reason) {
          run.stopReason = reason;
          this.event(run, 'warn', 'stop_rule', `停止规则触发：${reason}，基于已有证据生成部分报告`);
          this.save(run);
          this.active.delete(run.id);
          await this.finalizePartial(run.id);
          return;
        }
        // 依赖失败的级联跳过
        let changed = true;
        while (changed) {
          changed = false;
          for (const t of run.plan) {
            if (t.status !== 'pending' || t.runAlways) continue;
            const deps = t.dependsOn.map((id) => run.plan.find((x) => x.id === id)).filter(Boolean) as PlanTask[];
            const bad = deps.find((x) => x.status === 'failed' || x.status === 'skipped');
            if (bad) {
              t.status = 'skipped';
              t.error = `前置任务「${bad.title}」${bad.status === 'failed' ? '失败' : '未执行'}`;
              changed = true;
            }
          }
        }
        const ready = run.plan.filter((t) => {
          if (t.status !== 'pending') return false;
          const deps = t.dependsOn.map((id) => run.plan.find((x) => x.id === id));
          if (deps.some((x) => !x)) return true; // 依赖不存在（已被展开替换）视为满足
          return t.runAlways ? deps.every((x) => TERMINAL.has(x!.status)) : deps.every((x) => OK.has(x!.status));
        });
        const runnable: PlanTask[] = [];
        for (const t of ready) {
          const tool = this.d.registry.get(t.tool);
          if (tool && tool.permission !== 'read') {
            const ap = run.approvals.find((a) => a.taskId === t.id);
            if (!ap) {
              run.approvals.push(this.permissionApproval(run, t, tool));
              t.status = 'waiting_approval';
              this.event(run, 'info', 'approval', `等待授权：${t.title}`);
              continue;
            }
            if (ap.status === 'rejected') {
              t.status = 'skipped';
              t.error = '用户拒绝授权';
              continue;
            }
            if (ap.status === 'pending') {
              t.status = 'waiting_approval';
              continue;
            }
          }
          runnable.push(t);
        }
        if (!runnable.length) {
          if (run.plan.some((t) => t.status === 'waiting_approval')) {
            run.status = 'awaiting_approval';
            this.checkpoint(run, '等待授权');
            return;
          }
          if (run.plan.every((t) => TERMINAL.has(t.status))) {
            if (!run.plan.some((t) => t.tool === 'compose_report')) {
              // 例如用户拒绝敏感授权导致计划无法展开：仍输出说明性报告，而不是静默结束
              run.plan.push({ id: 't_report', title: '输出说明（关键步骤未执行）', capability: '产物', tool: 'compose_report', args: { mode: run.intent === 'portfolio' ? 'portfolio' : 'unresolved' }, dependsOn: [], required: true, runAlways: true, status: 'pending', attempts: 0, evidenceIds: [] });
              continue;
            }
            const reportOk = run.plan.some((t) => t.tool === 'compose_report' && OK.has(t.status));
            run.status = reportOk ? 'completed' : 'failed';
            if (!reportOk) run.stopReason = '未能生成报告';
            this.event(run, reportOk ? 'info' : 'error', 'done', reportOk ? `运行完成：${run.plan.filter((t) => OK.has(t.status)).length}/${run.plan.length} 个任务成功` : '运行失败：报告未生成');
            this.checkpoint(run, reportOk ? '运行完成' : '运行失败');
            return;
          }
          if (ready.length) continue; // 本轮仅处理了审批/跳过，重新调度
          run.status = 'failed';
          run.stopReason = '计划存在无法满足的依赖';
          this.checkpoint(run, '调度死锁');
          return;
        }
        run.status = 'running';
        const batch = runnable.slice(0, conc);
        const t0 = this.now();
        await Promise.all(batch.map((t) => this.execute(run, t, ac.signal)));
        run.usage.wallMs += this.now() - t0;
        if (ac.signal.aborted) this.stopFlags.add(run.id);
      }
    } catch (e: any) {
      run.status = 'failed';
      run.stopReason = `运行时异常：${e?.message ?? e}`;
      this.event(run, 'error', 'crash', run.stopReason);
      this.checkpoint(run, '运行异常');
    } finally {
      this.aborts.delete(run.id);
    }
  }

  private permissionApproval(run: RunState, t: PlanTask, tool: ToolSpec): Approval {
    if (tool.permission === 'sensitive_read')
      return this.mkApproval('tool', `授权读取：${tool.title}`, `${tool.description}。数据仅在本次运行内使用，不会发送给第三方；拒绝后将跳过相关分析。`, t.id);
    const rep = run.artifacts[run.artifacts.length - 1];
    return this.mkApproval('memory_write', `写入长期记忆：${tool.title}`, `将把「${rep?.title ?? '本次研究'}」中的事实型结论（含日期与数据模式）写入长期记忆，供后续研究复用。可在记忆面板随时删除。`, t.id);
  }

  private async runTool(run: RunState, tool: ToolSpec, args: Record<string, unknown>, task: PlanTask, signal: AbortSignal, parentSpan: string, useFault: boolean): Promise<ToolResult> {
    const s = this.settingsSafe();
    const fault = useFault ? s.faults[tool.name] : undefined;
    const cacheKey = `${run.dataMode}:${tool.name}:${stableKey(args)}`;
    if (tool.cacheTtlMs > 0 && (!fault || fault === 'none')) {
      const c = this.cache.get(cacheKey);
      if (c && this.now() - c.t < tool.cacheTtlMs) {
        run.usage.cacheHits += 1;
        task.cacheHit = true;
        const sp = this.span(run, `${tool.name}（缓存命中）`, 'tool', { cache: true }, parentSpan);
        this.end(sp, 'ok');
        return c.result;
      }
    }
    let lastErr: ToolError | null = null;
    for (let attempt = 1; attempt <= tool.maxRetries + 1; attempt++) {
      task.attempts += 1;
      run.usage.toolCalls += 1;
      const sp = this.span(run, `${tool.name}${attempt > 1 ? ` 重试#${attempt - 1}` : ''}`, 'tool', { attempt, source: tool.source, endpoint: tool.endpoint, fault: fault && fault !== 'none' ? fault : undefined }, parentSpan);
      try {
        const result = await withTimeout(
          tool.run(args, {
            runId: run.id,
            taskId: task.id,
            signal,
            run,
            outputs: run.outputs,
            now: this.now,
            attempt,
            fault: fault === 'none' ? undefined : fault,
            llmFault: s.faults['llm'] === 'none' ? undefined : s.faults['llm'],
            recordLlm: (u) => this.recordLlm(run, u, 'LLM 摘要生成'),
          }),
          tool.timeoutMs,
          signal,
        );
        this.end(sp, 'ok', { apiCalls: result.apiCalls ?? 0, evidence: result.evidence.length });
        if (tool.cacheTtlMs > 0) this.cache.set(cacheKey, { t: this.now(), result });
        return result;
      } catch (e: any) {
        const err = e instanceof ToolError ? e : new ToolError(String(e?.message ?? e), 'upstream', false);
        this.end(sp, 'error', { error: err.message, kind: err.kind });
        if (err.kind === 'aborted') throw err;
        lastErr = err;
        if (err.retryable && attempt <= tool.maxRetries) {
          run.usage.retries += 1;
          const wait = (this.d.backoffMs ?? 400) * 2 ** (attempt - 1) * (err.kind === 'rate_limit' ? 2 : 1);
          this.event(run, 'warn', 'retry', `${tool.title} ${err.message}，${wait}ms 后第 ${attempt} 次重试`);
          await sleep(wait, signal);
          continue;
        }
        break;
      }
    }
    throw lastErr!;
  }

  private async execute(run: RunState, task: PlanTask, signal: AbortSignal): Promise<void> {
    const tool = this.d.registry.get(task.tool);
    task.status = 'running';
    task.startedAt = this.now();
    task.error = undefined;
    run.usage.steps += 1;
    this.save(run);
    const parent = this.span(run, task.title, 'tool', { task: task.id, tool: task.tool });
    if (!tool) {
      task.status = 'failed';
      task.error = `未注册的工具：${task.tool}`;
      this.end(parent, 'error');
      this.checkpoint(run, `任务失败：${task.id}`);
      return;
    }
    const vErr = this.d.registry.validate(task.tool, task.args);
    if (vErr) {
      task.status = 'failed';
      task.error = `参数校验失败：${vErr}`;
      run.usage.failures += 1;
      this.addEvidence(run, task, [{ source: `参数校验（${tool.title}）`, field: 'args', label: task.title, value: null, status: 'error', note: vErr, asOf: null }]);
      this.end(parent, 'error', { error: vErr });
      this.event(run, 'error', 'fail', `${task.title}：${task.error}`);
      this.checkpoint(run, `任务失败：${task.id}`);
      return;
    }
    let result: ToolResult | null = null;
    let degraded: string | undefined;
    try {
      result = await this.runTool(run, tool, task.args, task, signal, parent.id, true);
      degraded = result.degradedNote;
    } catch (e: any) {
      const err = e as ToolError;
      if (err.kind === 'aborted') {
        task.status = 'pending';
        task.attempts = Math.max(0, task.attempts - 1);
        this.end(parent, 'error', { error: '已停止' });
        return;
      }
      // 降级链
      const fb = tool.fallbackTool ? this.d.registry.get(tool.fallbackTool) : undefined;
      if (fb) {
        this.event(run, 'warn', 'degrade', `${tool.title} 失败（${err.message}）→ 尝试降级：${fb.title}`);
        try {
          result = await this.runTool(run, fb, task.args, task, signal, parent.id, false);
          degraded = result.degradedNote ?? `${tool.title} 失败（${err.message}）→ 降级为 ${fb.title}`;
        } catch (e2: any) {
          if ((e2 as ToolError).kind === 'aborted') {
            task.status = 'pending';
            this.end(parent, 'error');
            return;
          }
          task.error = `${err.message}；降级 ${fb.title} 也失败：${e2.message}`;
        }
      } else task.error = err.message;
      if (!result && err.kind === 'auth' && tool.source !== 'local') this.authTripped.add(run.id);
      if (!result) {
        task.status = 'failed';
        task.endedAt = this.now();
        run.usage.failures += 1;
        run.usage.consecutiveFailures += 1;
        this.addEvidence(run, task, [{ source: `${tool.source === 'fuyao' ? '扶摇' : tool.source === 'ifind' ? 'iFinD' : '本地'} ${tool.endpoint ?? tool.name}`, endpoint: tool.endpoint, params: task.args, field: tool.name, label: `${task.title}（调用失败）`, value: null, status: 'error', note: task.error, asOf: null }]);
        this.end(parent, 'error', { error: task.error });
        this.event(run, 'error', 'fail', `${task.title} 失败：${task.error}${task.required ? '（必需任务，相关结论将标记为不确定）' : ''}`);
        this.checkpoint(run, `任务失败：${task.id}`);
        return;
      }
    }
    // 成功（或降级成功）
    run.usage.apiCalls += result.apiCalls ?? 0;
    run.usage.consecutiveFailures = 0;
    run.outputs[task.id] = result.data;
    const evs = this.addEvidence(run, task, result.evidence);
    task.summary = result.summary;
    task.status = degraded ? 'degraded' : 'done';
    task.degradedNote = degraded;
    if (degraded) run.degradations.push(`${task.title}：${degraded}`);
    task.endedAt = this.now();
    this.end(parent, degraded ? 'degraded' : 'ok', { evidence: evs.length, cache: task.cacheHit });
    if (task.tool === 'compose_report') {
      const art = (result.data as any).artifact as Artifact;
      run.artifacts.push(art);
      this.span(run, `产物：${art.title} v${art.version}`, 'compose', { claims: art.blocks.filter((b) => b.type === 'claims').length });
    }
    const cm = new ContextManager(run.context);
    const before = run.context.compactions.length;
    if (task.tool !== 'compose_report') cm.add('observation', `${task.title}：${result.summary}${evs.length ? `（证据 ${evs[0].id}${evs.length > 1 ? `~${evs[evs.length - 1].id}` : ''}）` : ''}`, { evidenceIds: evs.map((e) => e.id) });
    if (run.context.compactions.length > before) {
      const c = run.context.compactions[run.context.compactions.length - 1];
      const sp = this.span(run, `上下文压缩（${c.before}→${c.after} tokens）`, 'compaction', { merged: c.merged });
      this.end(sp, 'ok');
      this.event(run, 'info', 'compaction', `上下文超过 ${run.context.limitTokens} tokens，已合并 ${c.merged} 条早期观测（${c.before}→${c.after}），证据账本不受影响`);
    }
    if (task.expand) {
      const added = expandPlan(run.intent, task, result.data, this.now()).filter((n) => !run.plan.some((x) => x.id === n.id));
      run.plan.push(...added);
      if (added.length) this.event(run, 'info', 'replan', `计划展开：根据「${task.title}」结果新增 ${added.length} 个任务`);
    }
    this.checkpoint(run, `完成：${task.title}`);
  }

  private addEvidence(run: RunState, task: PlanTask, drafts: ToolResult['evidence']): Evidence[] {
    const out: Evidence[] = [];
    for (const d of drafts) {
      const e: Evidence = { ...d, id: `E-${String(run.evidence.length + 1).padStart(3, '0')}`, runId: run.id, taskId: task.id, tool: task.tool, fetchedAt: d.fetchedAt ?? this.now() };
      run.evidence.push(e);
      task.evidenceIds.push(e.id);
      out.push(e);
    }
    return out;
  }
}

export function intentLabel(i: Intent): string {
  return { stock: '个股研究', compare: '同业对比', market: '市场情绪', portfolio: '持仓体检', sector: '板块观察', unknown: '待澄清' }[i];
}
