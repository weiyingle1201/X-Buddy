// 检查点 / 停止与恢复 / 崩溃中断恢复 / 回滚 / 上下文压缩 / 长期记忆
import { describe, expect, it } from 'vitest';
import { buildServices } from '../src/app/services';
import { ContextManager } from '../src/core/context';
import { MemoryStore } from '../src/core/memory';
import { MemoryKV } from '../src/core/store';
import { runToEnd, setup } from './helpers';

describe('状态管理', () => {
  it('每个任务完成都写检查点，最多保留 15 个', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '比较宁德时代和比亚迪的盈利能力');
    const metas = sv.runtime.listCheckpoints(r.id);
    expect(metas.length).toBe(15);
    expect(r.checkpointSeq).toBeGreaterThan(15);
    expect(sv.kv.keys(`ckpt:${r.id}:`).length).toBe(15);
  });

  it('运行中停止 → 状态 stopped，未完成任务回到 pending → 继续执行可完成', async () => {
    const sv = setup();
    sv.runtime['d'].concurrency = 1;
    const run = await sv.runtime.createRun('th', '研究贵州茅台');
    const p = sv.runtime.start(run.id);
    await new Promise((r) => setTimeout(r, 15));
    sv.runtime.stop(run.id);
    await p;
    const stopped = sv.runtime.get(run.id)!;
    expect(stopped.status).toBe('stopped');
    expect(stopped.plan.some((t) => t.status === 'pending')).toBe(true);
    const doneBefore = stopped.plan.filter((t) => t.status === 'done').length;
    await sv.runtime.resume(run.id);
    let r = sv.runtime.get(run.id)!;
    const ap = r.approvals.find((a) => a.status === 'pending');
    if (ap) await sv.runtime.approve(r.id, ap.id, true);
    r = sv.runtime.get(run.id)!;
    expect(r.status).toBe('completed');
    // 已完成任务不重复执行（恢复只跑剩余任务）
    const quote = r.plan.find((t) => t.tool === 'resolve_entities')!;
    expect(quote.attempts).toBe(1);
    expect(r.plan.filter((t) => t.status === 'done').length).toBeGreaterThan(doneBefore);
  });

  it('停止后可基于已有证据生成部分报告', async () => {
    const sv = setup();
    sv.runtime['d'].concurrency = 1;
    const run = await sv.runtime.createRun('th', '研究贵州茅台');
    const p = sv.runtime.start(run.id);
    await new Promise((r) => setTimeout(r, 25));
    sv.runtime.stop(run.id);
    await p;
    await sv.runtime.finalizePartial(run.id);
    const r = sv.runtime.get(run.id)!;
    expect(r.artifacts.at(-1)!.partial).toBe(true);
    expect(JSON.stringify(r.artifacts.at(-1)!.blocks)).toContain('部分结果');
  });

  it('崩溃恢复：新进程读取持久化状态，标记 interrupted，从检查点续跑到完成', async () => {
    const kv = new MemoryKV();
    const a = setup({}, { kv });
    a.runtime['d'].concurrency = 1;
    const run = await a.runtime.createRun('th', '研究贵州茅台');
    const p = a.runtime.start(run.id);
    await new Promise((r) => setTimeout(r, 20));
    // 模拟崩溃：直接用持久化中的“运行中”状态构造新运行时（不调用 stop）
    const persisted = kv.get<any>(`run:${run.id}`);
    persisted.status = 'running';
    kv.set(`run:${run.id}`, persisted);
    a.runtime.stop(run.id); // 让旧进程的循环退出，避免干扰
    await p;
    kv.set(`run:${run.id}`, { ...persisted });
    const b = buildServices(kv, () => a.settings, undefined, { backoffMs: 0, demoLatencyMs: 1 });
    const ids = b.runtime.recoverInterrupted([run.id]);
    expect(ids).toEqual([run.id]);
    expect(b.runtime.get(run.id)!.status).toBe('interrupted');
    await b.runtime.resume(run.id);
    let r = b.runtime.get(run.id)!;
    const ap = r.approvals.find((x) => x.status === 'pending');
    if (ap) await b.runtime.approve(r.id, ap.id, true);
    r = b.runtime.get(run.id)!;
    expect(r.status).toBe('completed');
    expect(r.artifacts.length).toBeGreaterThan(0);
  });

  it('回滚到检查点：证据与产物恢复到当时状态，状态为暂停，可重新执行', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '研究贵州茅台');
    const metas = sv.runtime.listCheckpoints(r.id);
    const target = metas.find((m) => m.label.includes('计算'))!;
    const snapEvidence = sv.kv.get<any>(`ckpt:${r.id}:${String(target.seq).padStart(4, '0')}`).evidence.length;
    const restored = sv.runtime.restore(r.id, target.seq)!;
    expect(restored.status).toBe('paused');
    expect(restored.evidence.length).toBe(snapEvidence);
    expect(restored.artifacts.length).toBe(0);
    await sv.runtime.resume(r.id);
    const ap = sv.runtime.get(r.id)!.approvals.find((a) => a.status === 'pending');
    if (ap) await sv.runtime.approve(r.id, ap.id, true);
    expect(sv.runtime.get(r.id)!.status).toBe('completed');
  });

  it('上下文压缩：超过上限时合并早期观测为摘要，固定消息保留，证据账本不变', async () => {
    const sv = setup({ contextLimitTokens: 200 });
    const r = await runToEnd(sv, '比较宁德时代和比亚迪的盈利能力');
    expect(r.context.compactions.length).toBeGreaterThan(0);
    expect(r.context.messages.some((m) => m.role === 'summary')).toBe(true);
    expect(r.context.messages.filter((m) => m.pinned).length).toBeGreaterThanOrEqual(2);
    expect(r.evidence.length).toBeGreaterThan(50);
    // 摘要保留了证据 ID
    expect(r.context.messages.find((m) => m.role === 'summary')!.evidenceIds!.length).toBeGreaterThan(0);
  });

  it('ContextManager 单元：pinned 永不被压缩', () => {
    const cm = ContextManager.create(50);
    cm.add('system', '约束'.repeat(10), { pinned: true });
    for (let i = 0; i < 8; i++) cm.add('observation', `观测${i}：` + '数据'.repeat(8), { evidenceIds: [`E-00${i}`] });
    expect(cm.state.messages[0].role).toBe('system');
    expect(cm.state.compactions.length).toBeGreaterThan(0);
  });

  it('长期记忆：画像/偏好自动注入，持仓（敏感）不自动注入；研究笔记按标的召回并标注过期', () => {
    const kv = new MemoryKV();
    let now = Date.UTC(2026, 0, 1);
    const m = new MemoryStore(kv, () => now);
    m.seedIfEmpty();
    m.upsert({ kind: 'research_note', title: '茅台笔记', content: 'x', entity: '600519.SH', sensitive: false });
    now += 40 * 86400e3;
    const got = m.retrieve('研究茅台', ['600519.SH']);
    expect(got.some((g) => g.item.kind === 'holding')).toBe(false);
    expect(got.some((g) => g.item.kind === 'preference')).toBe(true);
    const note = got.find((g) => g.item.kind === 'research_note')!;
    expect(note.stale).toBe(true);
    // 同标的笔记更新而非重复
    m.upsert({ kind: 'research_note', title: '茅台笔记2', content: 'y', entity: '600519.SH', sensitive: false });
    expect(m.all().filter((x) => x.kind === 'research_note').length).toBe(1);
  });

  it('观测：每次工具调用都有 span，审批与检查点也被追踪', async () => {
    const sv = setup();
    const r = await runToEnd(sv, '研究贵州茅台');
    const kinds = new Set(r.spans.map((s) => s.kind));
    for (const k of ['tool', 'plan', 'approval', 'checkpoint', 'guard', 'memory']) expect(kinds.has(k as any)).toBe(true);
    expect(r.spans.filter((s) => s.kind === 'tool' && s.parentId).every((s) => s.end && s.end >= s.start)).toBe(true);
  });
});
