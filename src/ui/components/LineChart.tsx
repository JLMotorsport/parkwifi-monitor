import { useEffect, useMemo, useRef, useState } from 'react';

export interface Pt {
  t: number;
  v: number | null;
}

interface Props {
  title: string;
  unit: string;
  data: Pt[];
  hours: number;
  /** dashed reference line, e.g. the alert threshold */
  threshold?: number;
  /** fixed y range; otherwise padded around the data */
  min?: number;
  max?: number;
  digits?: number;
  /** extra line for the tooltip, e.g. worst ping in the sample */
  extra?: (i: number) => string | null;
  height?: number;
}

const PAD = { l: 40, r: 10, t: 10, b: 22 };

/** Single-series line chart: one axis, recessive grid, crosshair + tooltip, gaps where data is missing. */
export function LineChart({ title, unit, data: raw, hours, threshold, min, max, digits = 0, extra, height = 140 }: Props) {
  const H = height;
  const data = useMemo(() => [...raw].sort((a, b) => a.t - b.t), [raw]);
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(400);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const to = Date.now();
  const from = to - hours * 3600 * 1000;
  const vals = data.map((d) => d.v).filter((v): v is number => v !== null);

  const [lo, hi, ticksY] = useMemo(() => {
    let a = min ?? (vals.length ? Math.min(...vals) : 0);
    let b = max ?? (vals.length ? Math.max(...vals) : 1);
    if (threshold !== undefined) {
      a = Math.min(a, threshold);
      b = Math.max(b, threshold);
    }
    if (a === b) {
      a -= 1;
      b += 1;
    }
    return niceScale(min ?? a, max ?? b, 4);
  }, [vals.join(','), min, max, threshold]);

  const x = (t: number) => PAD.l + ((t - from) / (to - from)) * (w - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - (v - lo) / (hi - lo)) * (H - PAD.t - PAD.b);

  // path with gaps (breaks on null or gaps longer than 5 minutes)
  let d = '';
  let prevT = 0;
  data.forEach((p) => {
    if (p.v === null) {
      prevT = 0;
      return;
    }
    const cmd = !prevT || p.t - prevT > 5 * 60 * 1000 ? 'M' : 'L';
    d += `${cmd}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    prevT = p.t;
  });

  const nx = Math.max(2, Math.min(6, Math.floor((w - PAD.l) / 75)));
  const ticksX = Array.from({ length: nx }, (_, i) => from + ((to - from) * i) / (nx - 1));
  const fmtT = (t: number) =>
    hours > 48
      ? new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })
      : hours >= 24
        ? new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '')
        : new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  const onMove = (e: React.MouseEvent) => {
    if (!data.length) return;
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    let best = 0;
    let bd = Infinity;
    data.forEach((p, i) => {
      const dd = Math.abs(x(p.t) - px);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    });
    setHover(best);
  };

  const hp = hover !== null ? data[hover] : null;
  const latest = [...data].reverse().find((p) => p.v !== null);

  return (
    <div className="cblock">
      <div className="ch">
        <span className="t">{title}</span>
        {threshold !== undefined && <span className="sub num">limit {threshold} {unit}</span>}
        <span className={`now ${latest && threshold !== undefined && breach(latest.v!, threshold, unit) ? 'weak' : ''}`}>
          {latest ? `${latest.v!.toFixed(digits)} ${unit}` : 'no data'}
        </span>
      </div>
        <div className="chart" ref={ref}>
          <svg
            viewBox={`0 0 ${w} ${H}`}
            height={H}
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
            role="img"
            aria-label={`${title} over the last ${hours} hours`}
          >
            {ticksY.map((v, i) => (
              <g key={i}>
                <line x1={PAD.l} x2={w - PAD.r} y1={y(v)} y2={y(v)} stroke="var(--grid)" />
                <text x={PAD.l - 6} y={y(v) + 4} textAnchor="end" fontSize="11" fill="var(--text-3)">
                  {v}
                </text>
              </g>
            ))}
            {ticksX.map((t, i) => (
              <text
                key={i}
                x={x(t)}
                y={H - 4}
                textAnchor={i === 0 ? 'start' : i === nx - 1 ? 'end' : 'middle'}
                fontSize="11"
                fill="var(--text-3)"
              >
                {fmtT(t)}
              </text>
            ))}
            {threshold !== undefined && (
              <line
                x1={PAD.l}
                x2={w - PAD.r}
                y1={y(threshold)}
                y2={y(threshold)}
                stroke="var(--critical)"
                strokeDasharray="4 4"
                strokeWidth={1}
                opacity={0.7}
              />
            )}
            <path d={d} fill="none" stroke="var(--series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {hp && hp.v !== null && (
              <>
                <line x1={x(hp.t)} x2={x(hp.t)} y1={PAD.t} y2={H - PAD.b} stroke="var(--text-3)" strokeWidth={1} />
                <circle cx={x(hp.t)} cy={y(hp.v)} r={4.5} fill="var(--series)" stroke="var(--surface)" strokeWidth={2} />
              </>
            )}
          </svg>
          {hp && (
            <div
              className="tt"
              style={{ left: Math.min(Math.max(x(hp.t) - 70, 0), w - 150), top: -6 }}
            >
              <div className="faint">{new Date(hp.t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}</div>
              <b>{hp.v === null ? 'no reply' : `${hp.v.toFixed(digits)} ${unit}`}</b>
              {hover !== null && extra?.(hover) && <div className="faint">{extra(hover)}</div>}
            </div>
          )}
        </div>
    </div>
  );
}

/** Ping/noise style limits are ceilings; capacity/CCQ (in %) are floors. */
function breach(v: number, limit: number, unit: string) {
  return unit === '%' ? v < limit : v > limit;
}

/** Round the y-domain out to 1/2/5 x 10^n steps so tick labels are clean numbers. */
function niceScale(a: number, b: number, count: number): [number, number, number[]] {
  const raw = (b - a) / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(a / step) * step;
  const hi = Math.ceil(b / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toFixed(6)));
  return [lo, hi, ticks];
}
