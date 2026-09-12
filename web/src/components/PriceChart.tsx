import { useEffect, useMemo, useRef, useState } from 'react';
import type { HistoryPoint } from '../types';

export interface Series {
  id: string;
  label: string;
  color: string;
  points: HistoryPoint[];
}

interface Props {
  series: Series[];
  height?: number;
  loading?: boolean;
}

const PAD = { top: 12, right: 52, bottom: 22, left: 6 };

/**
 * Multi-series line chart with a crosshair and value pills pinned to the right
 * edge. Hand-rolled SVG rather than a chart library: it keeps the dependency
 * list short and gives exact control over the terminal look.
 */
export function PriceChart({ series, height = 220, loading }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hoverX, setHoverX] = useState<number | null>(null);

  // Track the container so the chart reflows with the panel.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(el);
    setWidth(el.clientWidth);
    return () => observer.disconnect();
  }, []);

  const model = useMemo(() => {
    const points = series.flatMap((s) => s.points);
    if (!points.length) return null;

    const times = points.map((p) => p.t);
    const values = points.map((p) => p.p);
    const tMin = Math.min(...times);
    const tMax = Math.max(...times);
    let vMin = Math.min(...values);
    let vMax = Math.max(...values);

    // Pad a flat series so it renders as a line rather than sitting on an edge.
    if (vMax - vMin < 1e-6) { vMin -= 0.01; vMax += 0.01; }
    const headroom = (vMax - vMin) * 0.12;
    vMin = Math.max(0, vMin - headroom);
    vMax = Math.min(1, vMax + headroom);

    const plotW = Math.max(1, width - PAD.left - PAD.right);
    const plotH = Math.max(1, height - PAD.top - PAD.bottom);
    const x = (t: number) => PAD.left + (tMax === tMin ? plotW : ((t - tMin) / (tMax - tMin)) * plotW);
    const y = (p: number) => PAD.top + plotH - ((p - vMin) / (vMax - vMin)) * plotH;

    return { tMin, tMax, vMin, vMax, plotW, plotH, x, y };
  }, [series, width, height]);

  if (loading) return <div className="empty">Loading history…</div>;
  if (!model) return <div className="empty">No history for this market</div>;

  const { x, y, tMin, tMax, vMin, vMax, plotH } = model;

  // Nearest sample to the cursor, per series.
  const hoverT = hoverX != null ? tMin + ((hoverX - PAD.left) / model.plotW) * (tMax - tMin) : null;
  const readouts = series.map((s) => {
    if (hoverT == null || !s.points.length) {
      const last = s.points[s.points.length - 1];
      return { series: s, point: last ?? null };
    }
    let best = s.points[0];
    for (const p of s.points) {
      if (Math.abs(p.t - hoverT) < Math.abs(best.t - hoverT)) best = p;
    }
    return { series: s, point: best };
  });

  const gridValues = [vMin, (vMin + vMax) / 2, vMax];
  const dateFmt = (t: number) =>
    new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

  return (
    <div ref={wrapRef} style={{ width: '100%' }}>
      <svg
        width={width}
        height={height}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          setHoverX(e.clientX - box.left);
        }}
        onMouseLeave={() => setHoverX(null)}
        style={{ display: 'block', cursor: 'crosshair' }}
      >
        {gridValues.map((v) => (
          <g key={v}>
            <line
              x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)}
              stroke="var(--line)" strokeDasharray="2 4"
            />
            <text x={width - PAD.right + 6} y={y(v) + 3} fill="var(--faint)" fontSize="10">
              {v.toFixed(2)}
            </text>
          </g>
        ))}

        {[tMin, (tMin + tMax) / 2, tMax].map((t, i) => (
          <text
            key={t}
            x={x(t)}
            y={height - 6}
            fill="var(--faint)"
            fontSize="10"
            textAnchor={i === 0 ? 'start' : i === 2 ? 'end' : 'middle'}
          >
            {dateFmt(t)}
          </text>
        ))}

        {series.map((s) => {
          if (s.points.length < 2) return null;
          const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.p).toFixed(1)}`).join(' ');
          return <path key={s.id} d={d} fill="none" stroke={s.color} strokeWidth="1.6" />;
        })}

        {hoverX != null && hoverX > PAD.left && hoverX < width - PAD.right && (
          <line
            x1={hoverX} x2={hoverX} y1={PAD.top} y2={PAD.top + plotH}
            stroke="var(--dim)" strokeDasharray="3 3"
          />
        )}

        {readouts.map(({ series: s, point }) => {
          if (!point) return null;
          return (
            <g key={s.id}>
              <circle cx={x(point.t)} cy={y(point.p)} r="3" fill={s.color} />
              <rect
                x={width - PAD.right + 2} y={y(point.p) - 8}
                width={46} height={16} rx="3" fill={s.color}
              />
              <text
                x={width - PAD.right + 25} y={y(point.p) + 3}
                fill="#fff" fontSize="10" textAnchor="middle" fontWeight="600"
              >
                {point.p.toFixed(3)}
              </text>
            </g>
          );
        })}
      </svg>

      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', padding: '6px 2px 0' }}>
        {readouts.map(({ series: s, point }) => (
          <span key={s.id} style={{ fontSize: 11, color: 'var(--dim)' }}>
            <span style={{
              display: 'inline-block', width: 8, height: 2,
              background: s.color, marginRight: 6, verticalAlign: 'middle',
            }} />
            {s.label}
            {point && (
              <strong style={{ marginLeft: 6, color: 'var(--text)', fontFamily: 'var(--mono)' }}>
                {point.p.toFixed(3)}
              </strong>
            )}
          </span>
        ))}
        {hoverT != null && (
          <span style={{ fontSize: 11, color: 'var(--faint)', marginLeft: 'auto' }}>
            {new Date(hoverT).toLocaleString()}
          </span>
        )}
      </div>
    </div>
  );
}
