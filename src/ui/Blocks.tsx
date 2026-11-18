import React, { useMemo, useState } from 'react';
import { Claim, Evidence, EvidenceStatus, UIBlock } from '../core/types';
import { fmtDate, fmtNum } from '../core/util';

export const STATUS_LABEL: Record<EvidenceStatus, string> = { ok: '正常', demo: '演示', missing: '缺失', stale: '过期', conflict: '冲突', error: '失败', derived: '计算' };
const KIND_LABEL = { fact: '事实', inference: '推断', uncertain: '不确定' } as const;

export interface EvCtx {
  byId: Map<string, Evidence>;
  open: (id: string) => void;
}

export function EvChip({ id, ctx }: { id: string; ctx: EvCtx }) {
  const e = ctx.byId.get(id);
  const title = e ? `${e.label} = ${e.value ?? '—'}${e.unit ?? ''}\n口径：${e.caliber ?? '—'}\n时点：${fmtDate(e.asOf, true)}\n来源：${e.source} · ${e.field}\n状态：${STATUS_LABEL[e.status]}${e.note ? `\n备注：${e.note}` : ''}` : id;
  return (
    <button className={`ev s-${e?.status ?? 'missing'}`} title={title} onClick={() => ctx.open(id)}>
      {id}
    </button>
  );
}

/** 把文本中的 [E-001, E-002] 渲染为可点击证据芯片 */
export function CitedText({ text, ctx }: { text: string; ctx: EvCtx }) {
  const parts = text.split(/(\[E-\d{3,}(?:,\s*E-\d{3,})*\])/g);
  return (
    <>
      {parts.map((p, i) => {
        const m = p.match(/^\[(E-\d{3,}(?:,\s*E-\d{3,})*)\]$/);
        if (!m) return <React.Fragment key={i}>{p}</React.Fragment>;
        return (
          <span key={i}>
            {m[1].split(/,\s*/).map((id) => (
              <EvChip key={id} id={id} ctx={ctx} />
            ))}
          </span>
        );
      })}
    </>
  );
}

function Claims({ items, ctx }: { items: Claim[]; ctx: EvCtx }) {
  return (
    <ul className="claims">
      {items.map((c, i) => (
        <li key={i}>
          <span className={`kind ${c.kind}`}>{KIND_LABEL[c.kind]}</span>
          <span>
            <CitedText text={c.text} ctx={ctx} />
          </span>
        </li>
      ))}
    </ul>
  );
}

const PALETTE = ['#2557d6', '#c8102e', '#12924f', '#b7791f', '#7c5cc4', '#0f8fa3'];

function LineChart({ block, ctx }: { block: Extract<UIBlock, { type: 'line' }>; ctx: EvCtx }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const H = 200;
  const P = { l: 46, r: 12, t: 10, b: 22 };
  const all = block.series.flatMap((s) => s.points);
  const { minX, maxX, minY, maxY } = useMemo(() => {
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const lo = Math.min(...ys);
    const hi = Math.max(...ys);
    const pad = (hi - lo) * 0.08 || 1;
    return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: lo - pad, maxY: hi + pad };
  }, [block]);
  if (!all.length) return null;
  const x = (v: number) => P.l + ((v - minX) / (maxX - minX || 1)) * (W - P.l - P.r);
  const y = (v: number) => P.t + (1 - (v - minY) / (maxY - minY || 1)) * (H - P.t - P.b);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => minY + f * (maxY - minY));
  const base = block.series[0].points;
  const hp = hover !== null ? base[hover] : null;
  return (
    <div className="chart">
      <div className="block-title">
        {block.title}
        {block.evidenceIds?.map((id) => <EvChip key={id} id={id} ctx={ctx} />)}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const t = minX + ((px - P.l) / (W - P.l - P.r)) * (maxX - minX);
          let best = 0;
          base.forEach((p, i) => {
            if (Math.abs(p[0] - t) < Math.abs(base[best][0] - t)) best = i;
          });
          setHover(best);
        }}
        role="img"
        aria-label={block.title}
      >
        {ticks.map((v, i) => (
          <g key={i}>
            <line x1={P.l} x2={W - P.r} y1={y(v)} y2={y(v)} stroke="var(--line-2)" />
            <text x={P.l - 6} y={y(v) + 4} fontSize="10" textAnchor="end" fill="var(--text-3)">
              {v.toFixed(v > 100 ? 0 : 1)}
            </text>
          </g>
        ))}
        <text x={P.l} y={H - 6} fontSize="10" fill="var(--text-3)">
          {fmtDate(minX)}
        </text>
        <text x={W - P.r} y={H - 6} fontSize="10" textAnchor="end" fill="var(--text-3)">
          {fmtDate(maxX)}
        </text>
        {block.series.map((s, i) => (
          <polyline key={s.name} fill="none" stroke={PALETTE[i % PALETTE.length]} strokeWidth="1.6" points={s.points.map((p) => `${x(p[0]).toFixed(1)},${y(p[1]).toFixed(1)}`).join(' ')} />
        ))}
        {hp && (
          <g>
            <line x1={x(hp[0])} x2={x(hp[0])} y1={P.t} y2={H - P.b} stroke="var(--text-3)" strokeDasharray="3 3" />
            {block.series.map((s, i) => {
              const pt = s.points[hover!];
              return pt ? <circle key={s.name} cx={x(pt[0])} cy={y(pt[1])} r="3" fill={PALETTE[i % PALETTE.length]} /> : null;
            })}
          </g>
        )}
      </svg>
      <div className="legend">
        {block.series.map((s, i) => (
          <span key={s.name}>
            <i style={{ background: PALETTE[i % PALETTE.length] }} />
            {s.name}
            {hp && s.points[hover!] ? `：${s.points[hover!][1].toFixed(2)}` : ''}
          </span>
        ))}
        {hp && <span className="muted">{fmtDate(hp[0])}</span>}
      </div>
      {block.caption && <div className="muted">{block.caption}</div>}
    </div>
  );
}

function Bars({ block, ctx }: { block: Extract<UIBlock, { type: 'bars' }>; ctx: EvCtx }) {
  const max = Math.max(1e-9, ...block.items.map((i) => Math.abs(i.value ?? 0)));
  return (
    <div className="chart bars">
      <div className="block-title">{block.title}</div>
      {block.items.map((it) => (
        <div className="bar" key={it.label}>
          <span title={it.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {it.label}
          </span>
          <div className="track">
            <div className="fill" style={{ width: `${(Math.abs(it.value ?? 0) / max) * 100}%`, background: (it.value ?? 0) < 0 ? 'var(--down)' : undefined }} />
          </div>
          <span style={{ textAlign: 'right' }}>
            {fmtNum(it.value, block.unit ?? '', 1)}
            {it.evidenceId && <EvChip id={it.evidenceId} ctx={ctx} />}
          </span>
        </div>
      ))}
      {block.caption && <div className="muted">{block.caption}</div>}
    </div>
  );
}

export function Blocks({ blocks, ctx }: { blocks: UIBlock[]; ctx: EvCtx }) {
  return (
    <>
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'notice':
            return (
              <div key={i} className={`notice ${b.level}`}>
                {b.text}
              </div>
            );
          case 'claims':
            return (
              <div key={i}>
                <div className="block-title">{b.title}</div>
                <Claims items={b.items} ctx={ctx} />
              </div>
            );
          case 'kpis':
            return (
              <div key={i}>
                {b.title && <div className="block-title">{b.title}</div>}
                <div className="kpis">
                  {b.items.map((k, j) => (
                    <div key={j} className={`kpi ${k.value === null ? 'missing' : ''}`}>
                      <div className="l">
                        <span>{k.label}</span>
                        {k.evidenceId && <EvChip id={k.evidenceId} ctx={ctx} />}
                      </div>
                      <div className={`v ${k.tone === 'up' ? 'up' : k.tone === 'down' ? 'down' : ''}`}>{k.value === null ? '缺失' : fmtNum(k.value, k.unit)}</div>
                      {(k.sub || k.status === 'conflict' || k.status === 'stale') && (
                        <div className={`s ${k.tone === 'up' ? 'up' : k.tone === 'down' ? 'down' : ''}`}>
                          {k.sub}
                          {k.status === 'conflict' ? ' ⚠冲突' : k.status === 'stale' ? ' ⚠过期' : ''}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            );
          case 'line':
            return <LineChart key={i} block={b} ctx={ctx} />;
          case 'bars':
            return <Bars key={i} block={b} ctx={ctx} />;
          case 'table':
            return (
              <div key={i}>
                <div className="block-title">{b.title}</div>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        {b.columns.map((c) => (
                          <th key={c}>{c}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {b.rows.map((r, j) => (
                        <tr key={j}>
                          {r.cells.map((c, k) => (
                            <td key={k}>
                              {c === null ? '—' : String(c)}
                              {r.evidenceIds?.[k] && <EvChip id={r.evidenceIds[k]!} ctx={ctx} />}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {b.caption && <div className="caption">{b.caption}</div>}
              </div>
            );
          case 'quality':
            return (
              <div key={i}>
                <div className="block-title">{b.title}</div>
                <ul className="quality">
                  {b.items.map((q, j) => (
                    <li key={j}>
                      <span className={`st ${q.status}`}>{STATUS_LABEL[q.status]}</span>
                      <span>{q.text}</span>
                      {q.evidenceId && <EvChip id={q.evidenceId} ctx={ctx} />}
                    </li>
                  ))}
                </ul>
              </div>
            );
          default:
            return null;
        }
      })}
    </>
  );
}
