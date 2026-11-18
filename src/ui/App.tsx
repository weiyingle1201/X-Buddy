import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildServices } from '../app/services';
import { loadSettings, saveSettings } from '../app/settings';
import { LocalKV } from '../core/store';
import { FaultType, RunState, Settings, Thread } from '../core/types';
import { uid } from '../core/util';
import { Inspector, Tab } from './Inspector';
import { RunActions, RunCard } from './RunCard';
import { SettingsDrawer } from './SettingsDrawer';
import { DialogHost, ui } from './Dialog';

const SAMPLES: [string, string][] = [
  ['研究贵州茅台的基本面和估值', '个股研究 · 写记忆需确认'],
  ['比较宁德时代和比亚迪的盈利能力', '同业对比 · 含数据冲突'],
  ['今天市场情绪如何？', '市场情绪 · iFinD 缺失降级'],
  ['帮我体检一下我的持仓', '持仓体检 · 敏感读取授权'],
  ['看看半导体板块', '板块观察 · 两段式展开'],
  ['对比茅台、五粮液和美的集团', '多标的 · 超预算审批'],
  ['茅台明天会涨吗？现在能买吗？', '合规改写'],
];

const REPO = 'https://github.com/weiyingle1201/X-Buddy';

export function App() {
  const kv = useMemo(() => new LocalKV('xb:'), []);
  const [settings, setSettings] = useState<Settings>(() => loadSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const [, setTick] = useState(0);
  const rerender = useCallback(() => setTick((t) => t + 1), []);
  const [threads, setThreads] = useState<Thread[]>(() => kv.get<Thread[]>('threads') ?? []);
  const [activeThread, setActiveThread] = useState<string | null>(() => kv.get<string>('activeThread'));
  const [input, setInput] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [tab, setTab] = useState<Tab>('evidence');
  const [focus, setFocus] = useState<string | undefined>();
  const [inspRun, setInspRun] = useState<string | null>(null);
  const [inspOpen, setInspOpen] = useState(false);
  const [sideOpen, setSideOpen] = useState(false);
  const [memVersion, setMemVersion] = useState(0);
  const [interrupted, setInterrupted] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const feedRef = useRef<HTMLDivElement>(null);

  const svcKey = `${settings.dataMode}|${settings.fuyaoKey}|${settings.ifindUrl}|${settings.ifindToken}|${settings.llmProvider}|${settings.llmModel}|${settings.llmBase}|${settings.llmKey}|${settings.demoLatencyMs}`;
  const services = useMemo(
    () =>
      buildServices(kv, () => settingsRef.current, (run) => {
        // 运行更新时同步线程实体（供追问沿用）
        if (run.entities.length) {
          setThreads((ts) => {
            const t = ts.find((x) => x.id === run.threadId);
            if (!t || JSON.stringify(t.entities) === JSON.stringify(run.entities)) return ts;
            const next = ts.map((x) => (x.id === run.threadId ? { ...x, entities: run.entities, updatedAt: Date.now() } : x));
            kv.set('threads', next);
            return next;
          });
        }
        rerender();
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [svcKey],
  );
  const { runtime, memory, registry } = services;

  useEffect(() => {
    kv.set('threads', threads);
  }, [threads, kv]);
  useEffect(() => {
    kv.set('activeThread', activeThread);
  }, [activeThread, kv]);
  // 启动时检测中断的运行
  useEffect(() => {
    const ids = threads.flatMap((t) => t.runIds);
    setInterrupted(runtime.recoverInterrupted(ids));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const thread = threads.find((t) => t.id === activeThread) ?? null;
  const runs = (thread?.runIds ?? []).map((id) => runtime.get(id)).filter(Boolean) as RunState[];
  const selRun = (inspRun && runtime.get(inspRun)) || runs[runs.length - 1];
  const anyActive = runs.some((r) => runtime.isActive(r.id));

  useEffect(() => {
    feedRef.current?.scrollTo({ top: feedRef.current.scrollHeight, behavior: 'smooth' });
  }, [runs.length, activeThread]);

  const newThread = () => {
    setActiveThread(null);
    setInspRun(null);
    setSideOpen(false);
  };

  const send = async (goalRaw?: string, forceNew = false) => {
    const goal = (goalRaw ?? input).trim();
    if (!goal || busy) return;
    setBusy(true);
    if (goalRaw === undefined) setInput('');
    let t = forceNew ? null : thread;
    if (!t) {
      t = { id: uid('th'), title: goal.slice(0, 26), createdAt: Date.now(), updatedAt: Date.now(), runIds: [], entities: [] };
      setThreads((ts) => [t!, ...ts]);
      setActiveThread(t.id);
    }
    const notes = (forceNew ? [] : runs)
      .slice(-3)
      .map((r) => `上一轮「${r.goal}」：${(((r.artifacts[r.artifacts.length - 1] as any)?.summary as string) ?? '无报告').replace(/\[E-[^\]]+\]/g, '').slice(0, 160)}`);
    try {
      const run = await runtime.createRun(t.id, goal, { threadEntities: t.entities, threadNotes: notes });
      const tid = t.id;
      setThreads((ts) => ts.map((x) => (x.id === tid ? { ...x, runIds: [...x.runIds, run.id], updatedAt: Date.now() } : x)));
      setInspRun(null);
      setFocus(undefined);
      if (run.status === 'running') void runtime.start(run.id).then(rerender);
      rerender();
    } finally {
      setBusy(false);
    }
  };

  const act: RunActions = {
    approve: (rid, ap, yes) => void runtime.approve(rid, ap, yes).then(() => {
      rerender();
      setMemVersion((v) => v + 1);
    }),
    stop: (rid) => {
      runtime.stop(rid);
      rerender();
    },
    resume: (rid, extend) => {
      setInterrupted((x) => x.filter((i) => i !== rid));
      void runtime.resume(rid, { extendBudget: extend }).then(rerender);
    },
    partial: (rid) => void runtime.finalizePartial(rid).then(rerender),
    openEvidence: (rid, id) => {
      setInspRun(rid);
      setTab('evidence');
      setFocus(id);
      setInspOpen(true);
    },
    toolSource: (name) => registry.get(name)?.source ?? '',
  };

  const saveSet = (s: Settings) => {
    if (anyActive) {
      ui.alert('有运行正在执行，请先停止后再修改设置。');
      return;
    }
    saveSettings(s);
    setSettings(s);
    setShowSettings(false);
  };
  const setFault = (tool: string, f: FaultType) => {
    const s = { ...settingsRef.current, faults: { ...settingsRef.current.faults, [tool]: f } };
    saveSettings(s);
    setSettings(s);
  };
  const faultsOn = Object.values(settings.faults).filter((f) => f && f !== 'none').length;
  const llmOn = services.llm.enabled();

  const deleteThread = (id: string) => {
    ui.confirm('删除该线程及其运行记录（仅本机浏览器中的数据）？', () => doDeleteThread(id), '删除');
  };
  const doDeleteThread = (id: string) => {
    const t = threads.find((x) => x.id === id);
    for (const r of t?.runIds ?? []) {
      kv.del(`run:${r}`);
      for (const k of kv.keys(`ckpt:${r}:`)) kv.del(k);
      kv.del(`ckptmeta:${r}`);
    }
    setThreads((ts) => ts.filter((x) => x.id !== id));
    if (activeThread === id) setActiveThread(null);
  };

  return (
    <div className="app">
      <header className="topbar">
        <button className="btn ghost sm show-sm" onClick={() => setSideOpen((v) => !v)} aria-label="打开线程列表">
          ☰
        </button>
        <div className="logo">
          <span className="logo-mark">X</span>
          <span>
            X-Buddy <small>投资研究 Agent 工作台</small>
          </span>
        </div>
        <span className={`badge ${settings.dataMode === 'demo' ? 'demo' : 'live'}`} title={settings.dataMode === 'demo' ? '全部数值为构造样例，不代表真实市场' : '调用扶摇 / iFinD 实时接口'}>
          <span className="hide-sm">{settings.dataMode === 'demo' ? '演示数据（构造）' : '实时数据'}</span>
          <span className="show-sm">{settings.dataMode === 'demo' ? '演示' : '实时'}</span>
        </span>
        <span className={`badge hide-sm ${llmOn ? 'accent' : ''}`}>{llmOn ? `LLM：${settings.llmModel}` : 'LLM：规则引擎'}</span>
        {faultsOn > 0 && <span className="badge err">故障注入 {faultsOn}</span>}
        <span className="spacer" />
        <a className="btn ghost sm hide-sm" href={REPO} target="_blank" rel="noreferrer">
          源代码
        </a>
        <button className="btn sm toggle-insp" onClick={() => setInspOpen((v) => !v)}>
          {inspOpen ? '关闭' : '证据'}
        </button>
        <button className="btn sm" onClick={() => setShowSettings(true)}>
          ⚙<span className="hide-sm"> 设置</span>
        </button>
      </header>
      <div className="main">
        <nav className={`sidebar ${sideOpen ? 'open' : ''}`}>
          <div className="sec">
            <button className="btn primary" style={{ width: '100%', justifyContent: 'center' }} onClick={newThread}>
              ＋ 新研究
            </button>
          </div>
          <div className="thread-list">
            <h4 style={{ margin: '4px 4px 6px', fontSize: 12, color: 'var(--text-3)' }}>研究线程</h4>
            {threads.length === 0 && <div className="muted" style={{ padding: '0 4px' }}>暂无线程</div>}
            {threads.map((t) => {
              const last = runtime.get(t.runIds[t.runIds.length - 1]);
              return (
                <div key={t.id} className={`thread-item ${t.id === activeThread ? 'active' : ''}`} onClick={() => { setActiveThread(t.id); setInspRun(null); setSideOpen(false); }}>
                  <div className="t">{t.title}</div>
                  <div className="m">
                    <span>{t.runIds.length} 轮</span>
                    {t.entities.length > 0 && <span className="ents">{t.entities.map((e) => e.name).join('、')}</span>}
                    {last && ['interrupted', 'awaiting_approval'].includes(last.status) && <span className="badge warn" style={{ padding: '0 5px' }}>{last.status === 'interrupted' ? '中断' : '待确认'}</span>}
                    <span style={{ flex: 1 }} />
                    <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }} title="删除线程" aria-label="删除线程">
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="sec">
            <h4>试试这些研究目标</h4>
            {SAMPLES.slice(0, 7).map(([g, d]) => (
              <button key={g} className="sample" onClick={() => { setSideOpen(false); void send(g, true); }} aria-label={`示例：${g}（${d}）`}>
                {g}
                <div className="muted" style={{ fontSize: 11 }}>{d}</div>
              </button>
            ))}
          </div>
        </nav>

        <section className="center">
          {interrupted.length > 0 && (
            <div className="banner">
              ⚠ 检测到 {interrupted.length} 个运行在执行中被中断（页面刷新/崩溃）。
              {interrupted.map((id) => {
                const r = runtime.get(id);
                return (
                  <button key={id} className="btn sm" onClick={() => { const th = threads.find((t) => t.runIds.includes(id)); if (th) setActiveThread(th.id); act.resume(id); }}>
                    从检查点恢复「{r?.goal.slice(0, 12)}」
                  </button>
                );
              })}
              <button className="btn sm ghost" onClick={() => setInterrupted([])}>
                忽略
              </button>
            </div>
          )}
          <div className="thread-head">
            <h2>{thread ? thread.title : '新研究'}</h2>
            {thread && thread.entities.length > 0 && <span className="badge hide-sm">线程标的：{thread.entities.map((e) => e.name).join('、')}</span>}
          </div>
          <div className="feed" ref={feedRef}>
            {!thread && (
              <div className="empty">
                <h1>你的研究目标是什么？</h1>
                <div>X-Buddy 会规划任务、调用金融数据工具、把每个数字记入证据账本，在需要时请你确认，并输出区分「事实 / 推断 / 不确定」的可验证研究报告。</div>
                <div className="flow">
                  <div>
                    <b>① 规划</b>意图识别 → 实体解析 → 两阶段展开任务
                  </div>
                  <div>
                    <b>② 执行</b>注册工具 · 权限审批 · 重试/降级 · 缓存
                  </div>
                  <div>
                    <b>③ 证据</b>来源 / 字段 / 时点 / 单位 / 口径 · 冲突与缺失检测
                  </div>
                  <div>
                    <b>④ 产物</b>分级结论 · 动态图表 · 合规审查 · 导出
                  </div>
                  <div>
                    <b>⑤ 状态</b>检查点恢复 · 上下文压缩 · 长期记忆
                  </div>
                </div>
                <div className="muted">从左侧示例开始，或在下方输入。当前为{settings.dataMode === 'demo' ? '演示模式：数据为构造样例，无需任何 Key' : '实时模式'}。</div>
              </div>
            )}
            {runs.map((r) => (
              <RunCard key={r.id} run={r} active={runtime.isActive(r.id)} act={act} />
            ))}
          </div>
          <div className="composer">
            <div className="composer-box">
              <textarea
                value={input}
                rows={1}
                placeholder={thread ? '追问（可省略标的，例如：再和五粮液比较一下）' : '输入研究目标，例如：研究贵州茅台的基本面和估值'}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                aria-label="研究目标"
              />
              <button className="btn primary" style={{ height: 42 }} disabled={!input.trim() || busy} onClick={() => void send()}>
                开始研究
              </button>
            </div>
            <div className="hint">
              <span>Enter 发送 · Shift+Enter 换行</span>
              <span>不提供涨跌预测、收益承诺或买卖建议</span>
            </div>
          </div>
        </section>

        <Inspector
          open={inspOpen}
          tab={tab}
          setTab={setTab}
          run={selRun}
          focus={focus}
          setFocus={setFocus}
          checkpoints={selRun ? runtime.listCheckpoints(selRun.id) : []}
          runActive={selRun ? runtime.isActive(selRun.id) : false}
          onRestore={(seq) => {
            if (!selRun) return;
            const rid = selRun.id;
            ui.confirm(`回滚到检查点 #${seq}？之后的证据与产物将被丢弃，运行进入暂停状态。`, () => {
              runtime.restore(rid, seq);
              rerender();
            }, '回滚');
          }}
          memory={memory}
          memVersion={memVersion}
          bumpMem={() => setMemVersion((v) => v + 1)}
          registry={registry}
          settings={settings}
          setFault={setFault}
        />
      </div>
      <DialogHost />
      {showSettings && <SettingsDrawer initial={settings} onClose={() => setShowSettings(false)} onSave={saveSet} />}
    </div>
  );
}
