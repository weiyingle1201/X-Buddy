import { DEMO_HOLDINGS } from '../data/fixtures';
import { KV } from './store';
import { MemoryItem } from './types';
import { uid } from './util';

const KEY = 'memory:items';
const STALE_MS = 30 * 86400e3;

/** 长期记忆：用户画像 / 偏好 / 自选 / 持仓（敏感） / 历史研究笔记 */
export class MemoryStore {
  constructor(private kv: KV, private now: () => number = Date.now) {}

  all(): MemoryItem[] {
    return this.kv.get<MemoryItem[]>(KEY) ?? [];
  }

  private save(items: MemoryItem[]) {
    this.kv.set(KEY, items);
  }

  /** 首次使用时写入构造的匿名画像与持仓 */
  seedIfEmpty() {
    if (this.all().length) return;
    const t = this.now();
    const items: MemoryItem[] = [
      { id: uid('m'), kind: 'profile', title: '用户画像（构造·匿名）', content: '投资研究者，中长期视角，风险偏好：稳健；不接受杠杆。', sensitive: false, createdAt: t, updatedAt: t },
      { id: uid('m'), kind: 'preference', title: '研究偏好', content: '优先关注：盈利质量与现金流、估值所处区间、负债水平；报告需列出数据口径与时点。', sensitive: false, createdAt: t, updatedAt: t },
      { id: uid('m'), kind: 'watchlist', title: '自选', content: '贵州茅台 600519.SH；宁德时代 300750.SZ；美的集团 000333.SZ', sensitive: false, createdAt: t, updatedAt: t },
      {
        id: uid('m'),
        kind: 'holding',
        title: '模拟持仓（构造·匿名）',
        content: DEMO_HOLDINGS.map((h) => `${h.name} ${h.weight}%`).join('；'),
        sensitive: true,
        createdAt: t,
        updatedAt: t,
        data: DEMO_HOLDINGS,
      },
    ];
    this.save(items);
  }

  upsert(item: Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): MemoryItem {
    const items = this.all();
    const t = this.now();
    const existing = item.id
      ? items.find((x) => x.id === item.id)
      : item.kind === 'research_note' && item.entity
        ? items.find((x) => x.kind === 'research_note' && x.entity === item.entity)
        : undefined;
    if (existing) {
      Object.assign(existing, item, { id: existing.id, updatedAt: t });
      this.save(items);
      return existing;
    }
    const created: MemoryItem = { ...item, id: uid('m'), createdAt: t, updatedAt: t } as MemoryItem;
    items.push(created);
    this.save(items);
    return created;
  }

  remove(id: string) {
    this.save(this.all().filter((x) => x.id !== id));
  }

  holdings(): { thscode: string; name: string; weight: number }[] {
    const h = this.all().find((x) => x.kind === 'holding');
    return (h?.data as any[]) ?? [];
  }

  /**
   * 检索与本次目标相关的记忆。敏感项（持仓）不会自动注入上下文，需通过需审批的工具读取。
   */
  retrieve(goal: string, entities: string[]): { item: MemoryItem; stale: boolean }[] {
    const t = this.now();
    return this.all()
      .filter((m) => !m.sensitive)
      .filter((m) => m.kind === 'profile' || m.kind === 'preference' || (m.kind === 'watchlist' && /自选|关注/.test(goal)) || (m.kind === 'research_note' && !!m.entity && entities.includes(m.entity)))
      .map((item) => ({ item, stale: item.kind === 'research_note' && t - item.updatedAt > STALE_MS }));
  }
}
