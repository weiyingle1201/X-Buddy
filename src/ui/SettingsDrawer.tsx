import { useState } from 'react';
import { FuyaoLiveClient } from '../adapters/fuyao';
import { Settings } from '../core/types';

export function SettingsDrawer({ initial, onClose, onSave }: { initial: Settings; onClose: () => void; onSave: (s: Settings) => void }) {
  const [s, setS] = useState<Settings>({ ...initial, budget: { ...initial.budget } });
  const [test, setTest] = useState<string>('');
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((x) => ({ ...x, [k]: v }));
  const setB = (k: keyof Settings['budget'], v: number) => setS((x) => ({ ...x, budget: { ...x.budget, [k]: v } }));
  const testFuyao = async () => {
    setTest('测试中…');
    try {
      const c = new FuyaoLiveClient(s.fuyaoKey, s.fuyaoBase, 0);
      const env = await c.get('/api/meta/tickers/search', { q: '600519', limit: 1 });
      setTest(`✓ 连接成功：${env.data?.item?.[0]?.name ?? '无结果'}（request_id ${env.request_id ?? '-'}）`);
    } catch (e: any) {
      setTest(`✕ ${e.message}`);
    }
  };
  return (
    <div className="drawer-mask" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="设置">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3>设置</h3>
          <button className="btn ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="muted">API Key 仅保存在当前浏览器标签页（sessionStorage），直接从浏览器调用数据源，不经过任何第三方服务器。</div>

        <div className="field">
          <label>数据模式</label>
          <div className="seg-ctl">
            <button className={s.dataMode === 'demo' ? 'on' : ''} onClick={() => set('dataMode', 'demo')}>
              演示（构造数据）
            </button>
            <button className={s.dataMode === 'live' ? 'on' : ''} onClick={() => set('dataMode', 'live')}>
              实时（扶摇 / iFinD）
            </button>
          </div>
          <div className="help">演示模式无需任何 Key，数值为人工构造、结构对齐扶摇 API；实时模式由浏览器直接调用真实接口。若页面运行在禁止外部请求的托管沙箱中（如 claude.ai Artifact），实时模式会显示“网络错误”，请改用 GitHub Pages 地址或本地 npm run dev。</div>
        </div>

        <div className="field">
          <label>扶摇 API Key（X-api-key）</label>
          <input type="password" value={s.fuyaoKey} onChange={(e) => set('fuyaoKey', e.target.value)} placeholder="在 fuyao.aicubes.cn/admin 签发" autoComplete="off" />
          <div className="row" style={{ marginTop: 6 }}>
            <button className="btn sm" onClick={testFuyao} disabled={!s.fuyaoKey}>
              测试连接
            </button>
            <span className="muted">{test}</span>
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label>iFinD MCP 地址</label>
            <input value={s.ifindUrl} onChange={(e) => set('ifindUrl', e.target.value)} placeholder="iFinD 终端一键复制配置中的 url" />
          </div>
          <div className="field">
            <label>iFinD MCP 密钥</label>
            <input type="password" value={s.ifindToken} onChange={(e) => set('ifindToken', e.target.value)} placeholder="Authorization 字段" autoComplete="off" />
          </div>
        </div>
        <div className="help muted">iFinD 若因浏览器 CORS 无法直连，可在本地运行 <code>npm run proxy</code> 并把地址填为 http://localhost:8787/ifind。</div>

        <h4 style={{ marginTop: 18 }}>LLM（可选）</h4>
        <div className="muted">不配置时使用规则引擎规划 + 模板摘要（即“模型失败”时的降级路径）。配置后：LLM 负责意图/实体理解与摘要写作，输出须通过 schema 校验、证据数值校验与合规审查，否则自动回退。</div>
        <div className="grid2">
          <div className="field">
            <label>提供方</label>
            <select value={s.llmProvider} onChange={(e) => set('llmProvider', e.target.value as Settings['llmProvider'])}>
              <option value="none">不使用</option>
              <option value="openai">OpenAI 兼容（DeepSeek/通义/Kimi…）</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </div>
          <div className="field">
            <label>模型</label>
            <input value={s.llmModel} onChange={(e) => set('llmModel', e.target.value)} placeholder="如 deepseek-chat" />
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label>Base URL</label>
            <input value={s.llmBase} onChange={(e) => set('llmBase', e.target.value)} placeholder="如 https://api.deepseek.com/v1" />
          </div>
          <div className="field">
            <label>API Key</label>
            <input type="password" value={s.llmKey} onChange={(e) => set('llmKey', e.target.value)} autoComplete="off" />
          </div>
        </div>
        <div className="grid2">
          <div className="field">
            <label>输入单价（¥/1k tokens）</label>
            <input type="number" step="0.001" value={s.llmPriceInPer1k} onChange={(e) => set('llmPriceInPer1k', +e.target.value)} />
          </div>
          <div className="field">
            <label>输出单价（¥/1k tokens）</label>
            <input type="number" step="0.001" value={s.llmPriceOutPer1k} onChange={(e) => set('llmPriceOutPer1k', +e.target.value)} />
          </div>
        </div>

        <h4 style={{ marginTop: 18 }}>预算与停止规则</h4>
        <div className="grid2">
          <div className="field">
            <label>最大工具调用次数</label>
            <input type="number" value={s.budget.maxToolCalls} onChange={(e) => setB('maxToolCalls', +e.target.value)} />
          </div>
          <div className="field">
            <label>最大运行时长（秒）</label>
            <input type="number" value={s.budget.maxWallMs / 1000} onChange={(e) => setB('maxWallMs', +e.target.value * 1000)} />
          </div>
          <div className="field">
            <label>LLM 成本上限（¥）</label>
            <input type="number" step="0.01" value={s.budget.maxCostYuan} onChange={(e) => setB('maxCostYuan', +e.target.value)} />
          </div>
          <div className="field">
            <label>连续失败熔断（次）</label>
            <input type="number" value={s.budget.maxConsecutiveFailures} onChange={(e) => setB('maxConsecutiveFailures', +e.target.value)} />
          </div>
          <div className="field">
            <label>预估调用超过 N 次需审批</label>
            <input type="number" value={s.budget.approveAboveCalls} onChange={(e) => setB('approveAboveCalls', +e.target.value)} />
          </div>
          <div className="field">
            <label>上下文上限（tokens）</label>
            <input type="number" value={s.contextLimitTokens} onChange={(e) => set('contextLimitTokens', +e.target.value)} />
            <div className="help">默认值较小，便于观察压缩</div>
          </div>
        </div>
        <div className="field">
          <label>
            <input type="checkbox" style={{ width: 'auto', marginRight: 6 }} checked={!s.autoApproveRead} onChange={(e) => set('autoApproveRead', !e.target.checked)} />
            每次运行开始前都需要我确认（否则仅超预算时确认）
          </label>
        </div>
        <div className="field">
          <label>演示接口模拟时延（ms）</label>
          <input type="number" value={s.demoLatencyMs} onChange={(e) => set('demoLatencyMs', +e.target.value)} />
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" onClick={() => onSave(s)}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
