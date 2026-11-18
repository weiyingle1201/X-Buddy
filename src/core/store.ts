/** 持久化抽象：浏览器用 localStorage，测试/不可用时用内存；所有读写均容错 */
export interface KV {
  get<T>(key: string): T | null;
  set(key: string, value: unknown): void;
  del(key: string): void;
  keys(prefix: string): string[];
}

export class MemoryKV implements KV {
  private m = new Map<string, string>();
  get<T>(key: string): T | null {
    const v = this.m.get(key);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  set(key: string, value: unknown) {
    this.m.set(key, JSON.stringify(value));
  }
  del(key: string) {
    this.m.delete(key);
  }
  keys(prefix: string) {
    return [...this.m.keys()].filter((k) => k.startsWith(prefix));
  }
}

export class LocalKV implements KV {
  private fallback = new MemoryKV();
  constructor(private ns = 'xb:') {}
  private ok(): boolean {
    try {
      return typeof localStorage !== 'undefined';
    } catch {
      return false;
    }
  }
  get<T>(key: string): T | null {
    if (!this.ok()) return this.fallback.get<T>(key);
    try {
      const v = localStorage.getItem(this.ns + key);
      return v === null ? this.fallback.get<T>(key) : (JSON.parse(v) as T);
    } catch {
      return this.fallback.get<T>(key);
    }
  }
  set(key: string, value: unknown) {
    this.fallback.set(key, value);
    if (!this.ok()) return;
    try {
      localStorage.setItem(this.ns + key, JSON.stringify(value));
    } catch {
      // 配额满时淘汰最旧的检查点后重试一次
      try {
        const ck = this.keys('ckpt:').sort();
        for (const k of ck.slice(0, Math.ceil(ck.length / 2))) this.del(k);
        localStorage.setItem(this.ns + key, JSON.stringify(value));
      } catch {
        /* 仍失败则只保留内存副本 */
      }
    }
  }
  del(key: string) {
    this.fallback.del(key);
    if (!this.ok()) return;
    try {
      localStorage.removeItem(this.ns + key);
    } catch {
      /* ignore */
    }
  }
  keys(prefix: string): string[] {
    const set = new Set(this.fallback.keys(prefix));
    if (this.ok()) {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith(this.ns + prefix)) set.add(k.slice(this.ns.length));
        }
      } catch {
        /* ignore */
      }
    }
    return [...set];
  }
}
