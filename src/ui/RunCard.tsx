import { useState } from 'react';
import { intentLabel } from '../core/runtime';
import { Artifact, RunState } from '../core/types';
import { fmtDate } from '../core/util';
import { Blocks, CitedText, EvCtx } from './Blocks';
import { ui } from './Dialog';

const STATUS: Record<RunState['status'], [string, string]> = {
  planning: ['规划中', 'accent'],
  running: ['执行中', 'accent'],
  awaiting_approval: ['等待确认', 'warn'],
  paused: ['已暂停', 'warn'],
  stopped: ['已停止', 'warn'],
  completed: ['已完成', 'live'],
  failed: ['失败', 'err'],
  interrupted: ['已中断', 'err'],
};
const ICON: Record<string, string> = { pending: '', running: '', waiting_approval: '?', done: '✓', degraded: '!', failed: '✕', skipped: '–' };
const SRC: Record<string, string> = { fuyao: '扶摇', ifind: 'iFinD', local: '本地', memory: '记忆' };

export interface RunActions {
  approve: (runId: string, apId: string, yes: boolean) => void;
  stop: (runId: string) => void;
  resume: (runId: string, extend?: boolean) => void;
  partial: (runId: string) => void;
  openEvidence: (runId: string, id: string) => void;
  toolSource: (tool: string) => string;
}

export function RunCard({ run, active, act }: { run: RunState; active: boolean; act: RunActions }) {
  const [showPlan, setShowPlan] = useState(true);
  const byId = new Map(run.evidence.map((e) => [e.id, e]));
  const ctx: EvCtx = { byId, open: (id) => act.openEvidence(run.id, id) };
  const total = run.plan.length || 1;
  const done = run.plan.filter((t) => ['done', 'degraded', 'failed', 'skipped'].includes(t.status)).length;
  const [label, tone] = STATUS[run.status];
  const pending = run.approvals.filter((a) => a.status === 'pending');
  const report = run.artifacts[run.artifacts.length - 1];
  const canResume = !active && ['stopped', 'paused', 'interrupted'].includes(run.status) && run.plan.some((t) => t.status !== 'done');
  const u = run.usage;
  return (
    <div className="run">
      <div className="goal">
        <div className="bubble">{run.goal}</div>
      </div>
      {run.compliance.length > 0 && run.effectiveGoal !== run.goal && (
        <div className="notice warn">
          合规改写：{run.compliance[0]}
          <div className="muted">执行目标：{run.effectiveGoal}</div>
        </div>
      )}
      <div className="card">
        <div className="card-h">
          <h3>执行计划</h3>
          <span className={`badge ${tone}`}>{label}</span>
          <span className="badge">{intentLabel(run.intent)}</span>
          <span className="badge" title="意图/实体由谁解析">{run.plannerSource === 'llm' ? '规划：LLM+规则' : '规划：规则引擎'}</span>
          <div className="progress" title={`${done}/${total}`}>
            <div style={{ width: `${(done / total) * 100}%` }} />
          </div>
          <span className="muted">
            {done}/{total}
          </span>
          {active && (
            <button className="btn sm danger" onClick={() => act.stop(run.id)}>
              ■ 停止
            </button>
          )}
          {canResume && (
            <>
              <button className="btn sm" onClick={() => act.resume(run.id)}>
                ▶ 从检查点继续
              </button>
              {run.stopReason && /上限|熔断/.test(run.stopReason) && (
                <button className="btn sm" onClick={() => act.resume(run.id, true)}>
                  放宽预算×2 继续
                </button>
              )}
              {!report && (
                <button className="btn sm" onClick={() => act.partial(run.id)}>
                  生成部分报告
                </button>
              )}
            </>
          )}
          <button className="btn sm ghost" onClick={() => setShowPlan((v) => !v)}>
            {showPlan ? '收起' : '展开'}
          </button>
        </div>
        {showPlan && (
          <div className="card-b">
            {run.stopReason && <div className="notice warn">停止原因：{run.stopReason}</div>}
            <ul className="tasks">
              {run.plan.map((t) => (
                <li className="task" key={t.id}>
                  <span className={`ic ${t.status}`}>{ICON[t.status]}</span>
                  <div>
                    <div className="title">{t.title}</div>
                    <div className="row" style={{ gap: 4, marginTop: 2 }}>
                      <span className="tag">{t.capability}</span>
                      <span className="tag mono">{t.tool}</span>
                      <span className="tag">{SRC[act.toolSource(t.tool)] ?? ''}</span>
                      {t.required && <span className="tag">必需</span>}
                      {t.cacheHit && <span className="tag">缓存</span>}
                      {t.attempts > 1 && <span className="tag">尝试 {t.attempts}</span>}
                    </div>
                    {t.summary && <div className="sub">{t.summary}</div>}
                    {t.degradedNote && <div className="sub deg">降级：{t.degradedNote}</div>}
                    {t.error && <div className="sub err">{t.error}</div>}
                  </div>
                  <span className="muted">{t.startedAt && t.endedAt ? `${t.endedAt - t.startedAt}ms` : ''}</span>
                </li>
              ))}
            </ul>
            <div className="usage">
              <div>
                <b>
                  {u.toolCalls}/{run.budget.maxToolCalls}
                </b>
                <span>工具调用/上限</span>
              </div>
              <div>
                <b>{u.apiCalls}</b>
                <span>外部 API 请求</span>
              </div>
              <div>
                <b>{u.retries}</b>
                <span>重试</span>
              </div>
              <div>
                <b>{u.cacheHits}</b>
                <span>缓存命中</span>
              </div>
              <div>
                <b>{(u.wallMs / 1000).toFixed(1)}s</b>
                <span>执行耗时</span>
              </div>
              <div>
                <b>{u.tokensIn + u.tokensOut}</b>
                <span>LLM tokens</span>
              </div>
              <div>
                <b>¥{u.costYuan.toFixed(4)}</b>
                <span>LLM 成本</span>
              </div>
              <div>
                <b>{run.evidence.length}</b>
                <span>证据条目</span>
              </div>
            </div>
            {run.degradations.length > 0 && (
              <div className="notice warn" style={{ marginTop: 10, marginBottom: 0 }}>
                降级记录：
                {run.degradations.map((d, i) => (
                  <div key={i}>· {d}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      {pending.map((a) => (
        <div className="approval" key={a.id}>
          <h4>需要你确认：{a.title}</h4>
          <p>{a.detail}</p>
          <div className="row">
            <button className="btn ok" onClick={() => act.approve(run.id, a.id, true)}>
              批准
            </button>
            <button className="btn" onClick={() => act.approve(run.id, a.id, false)}>
              拒绝
            </button>
          </div>
        </div>
      ))}
      {report && <ReportCard art={report} run={run} ctx={ctx} />}
    </div>
  );
}


function ReportCard({ art, run, ctx }: { art: Artifact; run: RunState; ctx: EvCtx }) {
  const summary: string = (art as any).summary ?? '';
  return (
    <div className="card">
      <div className="card-h">
        <h3>📄 {art.title}</h3>
        <span className="badge">v{art.version}</span>
        {art.partial && <span className="badge warn">部分结果</span>}
        <span className="badge" title="摘要来源">{art.narrativeSource === 'llm' ? '摘要：LLM（已校验）' : '摘要：模板'}</span>
        <span className="muted hide-sm">{fmtDate(art.createdAt, true)}</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => ui.exportText('导出报告（Markdown，含证据附录）', `${art.title}-v${art.version}.md`, art.markdown)}>
          导出 Markdown
        </button>
        <button className="btn sm" onClick={() => ui.exportText('导出证据账本（JSON）', `${art.title}-evidence.json`, JSON.stringify({ run: { id: run.id, goal: run.goal, dataMode: run.dataMode }, evidence: run.evidence }, null, 2), 'application/json')}>
          导出证据 JSON
        </button>
      </div>
      <div className="card-b">
        {summary && (
          <div className="summary">
            <CitedText text={summary} ctx={ctx} />
          </div>
        )}
        <Blocks blocks={art.blocks} ctx={ctx} />
      </div>
    </div>
  );
}
