import { useEffect, useMemo, useRef, useState } from 'react';
import { MemoryStore } from '../core/memory';
import { ToolRegistry } from '../core/registry';
import { CheckpointMeta } from '../core/runtime';
import { EvidenceStatus, FaultType, MemoryItem, RunState, Settings } from '../core/types';
import { fmtDate, fmtNum, percentile } from '../core/util';
import { STATUS_LABEL } from './Blocks';

export type Tab = 'evidence' | 'trace' | 'context' | 'checkpoints' | 'memory' | 'tools';
const TABS: [Tab, string][] = [
  ['evidence', '证据'],
  ['trace', '观测'],
  ['context', '上下文'],
  ['checkpoints', '检查点'],
  ['memory', '记忆'],
  ['tools', '工具/故障演练'],
];

interface Props {
  open: boolean;
  tab: Tab;
  setTab: (t: Tab) => void;
  run?: RunState;
  focus?: string;
  setFocus: (id: string) => void;
  checkpoints: CheckpointMeta[];
  onRestore: (seq: number) => void;
  runActive: boolean;
  memory: MemoryStore;
  memVersion: number;
  bumpMem: () => void;
  registry: ToolRegistry;
  settings: Settings;
  setFault: (tool: string, f: FaultType) => void;
}

export function Inspector(p: Props) {
  return (
    <aside className={`inspector ${p.open ? 'open' : ''}`}>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => (
          <button key={k} className={p.tab === k ? 'on' : ''} onClick={() => p.setTab(k)} role="tab" aria-selected={p.tab === k}>
            {l}
            {k === 'evidence' && p.run ? ` ${p.run.evidence.length}` : ''}
          </button>
        ))}
      </div>
      <div className="insp-body">
        {p.tab === 'evidence' && <EvidenceTab run={p.run} focus={p.focus} setFocus={p.setFocus} />}
        {p.tab === 'trace' && <TraceTab run={p.run} />}
        {p.tab === 'context' && <ContextTab run={p.run} />}
        {p.tab === 'checkpoints' && <CheckpointTab run={p.run} metas={p.checkpoints} onRestore={p.onRestore} active={p.runActive} />}
        {p.tab === 'memory' && <MemoryTab memory={p.memory} version={p.memVersion} bump={p.bumpMem} run={p.run} />}
        {p.tab === 'tools' && <ToolsTab registry={p.registry} settings={p.settings} setFault={p.setFault} />}
      </div>
    </aside>
  );
}

const FILTERS: (EvidenceStatus | 'all' | 'issue')[] = ['all', 'issue', 'ok', 'demo', 'derived', 'missing', 'conflict', 'stale', 'error'];

function EvidenceTab({ run, focus, setFocus }: { run?: RunState; focus?: string; setFocus: (id: string) => void }) {
  const [f, setF] = useState<(typeof FILTERS)[number]>('all');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) {
      setF('all');
      setTimeout(() => ref.current?.querySelector(`[data-ev="${focus}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30);
    }
  }, [focus]);
  if (!run) return <div className="muted">选择或开始一次研究后，这里会显示证据账本：每条事实都能回到原始接口、字段、时点、单位与口径。</div>;
  const list = run.evidence.filter((e) => f === 'all' || (f === 'issue' ? ['missing', 'conflict', 'stale', 'error'].includes(e.status) : e.status === f));
  return (
    <div ref={ref}>
      <div className="filters">
        {FILTERS.map((x) => (
          <button key={x} className={f === x ? 'on' : ''} onClick={() => setF(x)}>
            {x === 'all' ? '全部' : x === 'issue' ? '问题项' : STATUS_LABEL[x as EvidenceStatus]} {x === 'all' ? run.evidence.length : x === 'issue' ? run.evidence.filter((e) => ['missing', 'conflict', 'stale', 'error'].includes(e.status)).length : run.evidence.filter((e) => e.status === x).length}
          </button>
        ))}
      </div>
      {list.map((e) => (
        <div key={e.id} data-ev={e.id} className={`ev-item ${focus === e.id ? 'focus' : ''}`}>
          <div className="h">
            <b style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{e.id}</b>
            <span className={`st ${e.status}`}>{STATUS_LABEL[e.status]}</span>
          </div>
          <div>{e.label}</div>
          <div className="val">{typeof e.value === 'number' ? fmtNum(e.value, e.unit, Math.abs(e.value) < 1 ? 4 : 2) : e.value ?? '—'}</div>
          <dl className="kv">
            <dt>来源</dt>
            <dd>{e.source}</dd>
            <dt>字段</dt>
            <dd style={{ fontFamily: 'var(--mono)' }}>{e.field}</dd>
            <dt>单位</dt>
            <dd>{e.unit ?? '—'}</dd>
            <dt>口径</dt>
            <dd>{e.caliber ?? '—'}</dd>
            <dt>数据时点</dt>
            <dd>{fmtDate(e.asOf, true)}</dd>
            <dt>获取时间</dt>
            <dd>{fmtDate(e.fetchedAt, true)}</dd>
            {e.params && (
              <>
                <dt>参数</dt>
                <dd style={{ fontFamily: 'var(--mono)' }}>{JSON.stringify(e.params)}</dd>
              </>
            )}
            {e.formula && (
              <>
                <dt>公式</dt>
                <dd>{e.formula}</dd>
              </>
            )}
            {e.derivedFrom?.length ? (
              <>
                <dt>来源证据</dt>
                <dd>
                  {e.derivedFrom.map((id) => (
                    <button key={id} className="ev" onClick={() => setFocus(id)}>
                      {id}
                    </button>
                  ))}
                </dd>
              </>
            ) : null}
            {e.note && (
              <>
                <dt>备注</dt>
                <dd style={{ color: 'var(--warn)' }}>{e.note}</dd>
              </>
            )}
          </dl>
          {e.raw !== undefined && e.raw !== null && (
            <details>
              <summary className="muted">原始记录</summary>
              <pre className="raw">{JSON.stringify(e.raw, null, 1)}</pre>
            </details>
          )}
        </div>
      ))}
    </div>
  );
}

function TraceTab({ run }: { run?: RunState }) {
  if (!run) return <div className="muted">暂无运行。</div>;
  const spans = run.spans.filter((s) => s.end);
  const t0 = Math.min(...spans.map((s) => s.start), run.createdAt);
  const t1 = Math.max(...spans.map((s) => s.end!), t0 + 1);
  const toolLat = spans.filter((s) => s.kind === 'tool' && s.parentId).map((s) => s.end! - s.start);
  const errors = spans.filter((s) => s.kind === 'tool' && s.parentId && s.status === 'error').length;
  const exportTrace = () => {
    const blob = new Blob([JSON.stringify({ run: run.id, usage: run.usage, spans: run.spans, events: run.events }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `trace-${run.id}.json`;
    a.click();
  };
  return (
    <div>
      <div className="usage" style={{ marginTop: 0, marginBottom: 10 }}>
        <div>
          <b>{toolLat.length}</b>
          <span>工具 span</span>
        </div>
        <div>
          <b>{percentile(toolLat, 50)}ms</b>
          <span>P50 时延</span>
        </div>
        <div>
          <b>{percentile(toolLat, 95)}ms</b>
          <span>P95 时延</span>
        </div>
        <div>
          <b>{toolLat.length ? ((errors / toolLat.length) * 100).toFixed(0) : 0}%</b>
          <span>错误率</span>
        </div>
      </div>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <b style={{ fontSize: 13 }}>调用时间线</b>
        <button className="btn sm" onClick={exportTrace}>
          导出 Trace
        </button>
      </div>
      <div className="gantt">
        {spans.slice(-80).map((s) => (
          <div className="g" key={s.id} title={`${s.name}\n${JSON.stringify(s.attrs)}`}>
            <span className="n">
              {s.parentId ? '　' : ''}
              {s.name}
            </span>
            <div className="lane">
              <div className={`seg k-${s.kind} ${s.status}`} style={{ left: `${((s.start - t0) / (t1 - t0)) * 100}%`, width: `${Math.max(0.5, ((s.end! - s.start) / (t1 - t0)) * 100)}%` }} />
            </div>
            <span className="muted" style={{ textAlign: 'right' }}>
              {s.end! - s.start}ms
            </span>
          </div>
        ))}
      </div>
      <div className="row muted" style={{ margin: '6px 0 12px', gap: 10 }}>
        <span>
          <i className="seg k-tool" style={{ display: 'inline-block', width: 10, height: 8, position: 'static' }} /> 工具
        </span>
        <span>
          <i className="seg k-llm" style={{ display: 'inline-block', width: 10, height: 8, position: 'static' }} /> LLM
        </span>
        <span>
          <i className="seg k-approval" style={{ display: 'inline-block', width: 10, height: 8, position: 'static' }} /> 审批
        </span>
        <span>
          <i className="seg error" style={{ display: 'inline-block', width: 10, height: 8, position: 'static' }} /> 错误
        </span>
      </div>
      <b style={{ fontSize: 13 }}>事件日志</b>
      <ul className="events">
        {[...run.events].reverse().map((e, i) => (
          <li key={i} className={e.level}>
            <span className="muted">{new Date(e.t).toLocaleTimeString('zh-CN', { hour12: false })}</span>
            <span>{e.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ContextTab({ run }: { run?: RunState }) {
  if (!run) return <div className="muted">暂无运行。</div>;
  const total = run.context.messages.reduce((s, m) => s + m.tokens, 0);
  const lim = run.context.limitTokens;
  return (
    <div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b style={{ fontSize: 13 }}>上下文窗口</b>
        <span className="muted">
          {total} / {lim} tokens · 压缩 {run.context.compactions.length} 次
        </span>
      </div>
      <div className={`gauge ${total > lim ? 'over' : ''}`}>
        <div style={{ width: `${Math.min(100, (total / lim) * 100)}%` }} />
      </div>
      <div className="muted" style={{ marginBottom: 8 }}>
        规则：系统约束、用户目标、画像/偏好记忆固定保留；工具观测超限时合并为摘要（保留证据 ID），原始数据仍在证据账本，压缩不丢证据。
      </div>
      {run.context.messages.map((m) => (
        <div key={m.id} className={`ctx-msg ${m.role === 'summary' ? 'summary' : ''}`}>
          <div className="row" style={{ gap: 4, marginBottom: 2 }}>
            <span className="tag">{m.role}</span>
            {m.pinned && <span className="tag">📌 固定</span>}
            <span className="muted">{m.tokens} tok</span>
          </div>
          {m.text}
        </div>
      ))}
      {run.context.compactions.length > 0 && (
        <>
          <b style={{ fontSize: 13 }}>压缩记录</b>
          <ul className="events">
            {run.context.compactions.map((c, i) => (
              <li key={i}>
                <span className="muted">#{i + 1}</span>
                <span>
                  合并 {c.merged} 条：{c.before} → {c.after} tokens
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CheckpointTab({ run, metas, onRestore, active }: { run?: RunState; metas: CheckpointMeta[]; onRestore: (seq: number) => void; active: boolean }) {
  if (!run) return <div className="muted">暂无运行。</div>;
  return (
    <div>
      <div className="muted" style={{ marginBottom: 8 }}>
        每完成一个任务、每次审批/停止都会写入检查点（保留最近 15 个，存于浏览器本地）。页面刷新或崩溃后，运行会被标记为“已中断”，可从最近检查点继续；也可回滚到任意检查点重新执行（之后的证据与产物会被丢弃）。
      </div>
      {active && <div className="notice warn">运行中不可回滚，请先停止。</div>}
      <button
        className="btn sm"
        style={{ marginBottom: 10 }}
        disabled={!active}
        title="刷新页面以模拟进程崩溃，用于验证中断恢复"
        onClick={() => {
          if (confirm('将立即刷新页面以模拟崩溃，刷新后可在顶部横幅中从检查点恢复。继续？')) location.reload();
        }}
      >
        ⚡ 模拟崩溃（刷新页面）
      </button>
      {[...metas].reverse().map((m) => (
        <div key={m.seq} className="tool-row">
          <div className="h">
            <b>
              #{m.seq} {m.label}
            </b>
            <button className="btn sm" disabled={active} onClick={() => onRestore(m.seq)}>
              回滚到此
            </button>
          </div>
          <div className="muted">
            {new Date(m.t).toLocaleTimeString('zh-CN', { hour12: false })} · 任务 {m.done}/{m.total} · 状态 {m.status}
          </div>
        </div>
      ))}
    </div>
  );
}

const KIND: Record<MemoryItem['kind'], string> = { profile: '画像', preference: '偏好', watchlist: '自选', holding: '持仓', research_note: '研究笔记' };

function MemoryTab({ memory, version, bump, run }: { memory: MemoryStore; version: number; bump: () => void; run?: RunState }) {
  const items = useMemo(() => memory.all(), [memory, version]);
  const [text, setText] = useState('');
  return (
    <div>
      <div className="muted" style={{ marginBottom: 8 }}>
        长期记忆跨线程保存在本机浏览器。画像/偏好自动注入上下文；持仓为敏感信息，只有经你授权的工具才能读取；研究笔记需确认后写入。所有画像与持仓均为构造的匿名数据。
      </div>
      {items.map((m) => (
        <div className="tool-row" key={m.id}>
          <div className="h">
            <span className="row" style={{ gap: 4 }}>
              <span className="tag">{KIND[m.kind]}</span>
              {m.sensitive && <span className="tag" style={{ color: 'var(--err)' }}>敏感</span>}
              {run?.memoryUsed.includes(m.id) && <span className="tag" style={{ color: 'var(--accent)' }}>本次已使用</span>}
              <b>{m.title}</b>
            </span>
            <button
              className="btn sm ghost danger"
              onClick={() => {
                memory.remove(m.id);
                bump();
              }}
            >
              删除
            </button>
          </div>
          <div style={{ fontSize: 12.5 }}>{m.content}</div>
          <div className="muted">更新于 {fmtDate(m.updatedAt, true)}</div>
        </div>
      ))}
      <div className="field">
        <label>新增研究偏好</label>
        <div className="row">
          <input style={{ flex: 1 }} value={text} onChange={(e) => setText(e.target.value)} placeholder="例如：关注分红稳定性" />
          <button
            className="btn sm"
            disabled={!text.trim()}
            onClick={() => {
              memory.upsert({ kind: 'preference', title: '研究偏好（用户添加）', content: text.trim(), sensitive: false });
              setText('');
              bump();
            }}
          >
            添加
          </button>
        </div>
      </div>
    </div>
  );
}

const FAULTS: [FaultType, string][] = [
  ['none', '正常'],
  ['error', '服务错误'],
  ['timeout', '超时'],
  ['rate_limit', '限流(首次)'],
  ['auth', '鉴权失败'],
  ['empty', '返回空'],
  ['stale', '数据过期'],
];

function ToolsTab({ registry, settings, setFault }: { registry: ToolRegistry; settings: Settings; setFault: (tool: string, f: FaultType) => void }) {
  const caps = registry.capabilities();
  const perm = { read: '只读', sensitive_read: '敏感读·需授权', write: '写入·需确认' } as const;
  const active = Object.entries(settings.faults).filter(([, v]) => v && v !== 'none');
  return (
    <div>
      <div className="notice info">
        故障演练：为任意工具注入错误，观察重试、降级链、熔断与“不静默生成正常结论”。当前注入 {active.length} 项
        {active.length > 0 && (
          <button className="btn sm" style={{ marginLeft: 8 }} onClick={() => active.forEach(([k]) => setFault(k, 'none'))}>
            全部恢复
          </button>
        )}
      </div>
      <div className="tool-row">
        <div className="h">
          <b>LLM（摘要/规划）</b>
          <select value={settings.faults['llm'] ?? 'none'} onChange={(e) => setFault('llm', e.target.value as FaultType)}>
            {FAULTS.filter(([f]) => ['none', 'error', 'timeout'].includes(f)).map(([f, l]) => (
              <option key={f} value={f}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="muted">仅在配置了 LLM 时生效；失败后回退规则规划 / 模板摘要</div>
      </div>
      {Object.entries(caps).map(([cap, tools]) => (
        <div key={cap}>
          <div className="block-title" style={{ marginTop: 10 }}>
            {cap}
          </div>
          {tools.map((t) => (
            <div className="tool-row" key={t.name}>
              <div className="h">
                <span>
                  <b style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{t.name}</b> {t.title}
                </span>
                {t.source !== 'local' && t.source !== 'memory' && (
                  <select value={settings.faults[t.name] ?? 'none'} onChange={(e) => setFault(t.name, e.target.value as FaultType)} aria-label={`${t.name} 故障注入`}>
                    {FAULTS.map(([f, l]) => (
                      <option key={f} value={f}>
                        {l}
                      </option>
                    ))}
                  </select>
                )}
              </div>
              <div className="muted">{t.description}</div>
              <div className="row" style={{ gap: 4, marginTop: 3 }}>
                <span className="tag">{perm[t.permission]}</span>
                {t.endpoint && <span className="tag mono">{t.endpoint}</span>}
                <span className="tag">超时 {t.timeoutMs / 1000}s</span>
                <span className="tag">重试 {t.maxRetries}</span>
                <span className="tag">缓存 {t.cacheTtlMs ? `${Math.round(t.cacheTtlMs / 60000)}min` : '无'}</span>
                {t.fallbackTool && <span className="tag">降级→{t.fallbackTool}</span>}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
