import { DEFAULT_BUDGET } from '../core/runtime';
import { Settings } from '../core/types';

export const DEFAULT_SETTINGS: Settings = {
  dataMode: 'demo',
  fuyaoKey: '',
  fuyaoBase: 'https://fuyao.aicubes.cn',
  ifindUrl: '',
  ifindToken: '',
  llmProvider: 'none',
  llmBase: '',
  llmModel: '',
  llmKey: '',
  llmPriceInPer1k: 0.002,
  llmPriceOutPer1k: 0.008,
  contextLimitTokens: 900,
  budget: { ...DEFAULT_BUDGET },
  faults: {},
  autoApproveRead: true,
  demoLatencyMs: 350,
};

/** 密钥类字段只保存在 sessionStorage（关闭标签页即清除），其余设置保存在 localStorage */
const SECRET_KEYS: (keyof Settings)[] = ['fuyaoKey', 'ifindToken', 'llmKey'];

export function loadSettings(): Settings {
  let s: Settings = { ...DEFAULT_SETTINGS, budget: { ...DEFAULT_BUDGET } };
  try {
    const raw = localStorage.getItem('xb:settings');
    if (raw) s = { ...s, ...JSON.parse(raw), budget: { ...DEFAULT_BUDGET, ...(JSON.parse(raw).budget ?? {}) } };
  } catch {
    /* ignore */
  }
  try {
    for (const k of SECRET_KEYS) {
      const v = sessionStorage.getItem(`xb:secret:${k}`);
      if (v) (s as any)[k] = v;
    }
  } catch {
    /* ignore */
  }
  return s;
}

export function saveSettings(s: Settings) {
  const pub: any = { ...s };
  for (const k of SECRET_KEYS) delete pub[k];
  try {
    localStorage.setItem('xb:settings', JSON.stringify(pub));
  } catch {
    /* ignore */
  }
  try {
    for (const k of SECRET_KEYS) {
      if ((s as any)[k]) sessionStorage.setItem(`xb:secret:${k}`, (s as any)[k]);
      else sessionStorage.removeItem(`xb:secret:${k}`);
    }
  } catch {
    /* ignore */
  }
}
