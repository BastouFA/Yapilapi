'use client';

import { useId, type ReactNode } from 'react';
import { useI18n } from '@/i18n';

/**
 * Simple accessible charts (SVG, no chart library, no inline styles so a strict CSP holds). Every chart is a <figure>
 * with a visible title and plain-language summary, and a "View as table" disclosure holding the same numbers, so the
 * chart is never the only way to read the data. Suppressed cells (counts under the privacy threshold) are `null` and
 * are shown as "suppressed", never as zero.
 */

export interface TableSpec {
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export function ChartFigure({
  title,
  summary,
  table,
  legend,
  children,
  empty,
  noTable,
}: {
  title: string;
  summary: string;
  table: TableSpec;
  legend?: Array<{ label: string; series: 1 | 2 | 3 | 4 }>;
  children: ReactNode;
  empty?: boolean;
  /** The visual is itself a real data table (heatmap): do not repeat it in the disclosure. */
  noTable?: boolean;
}) {
  const { t, fmt } = useI18n();
  const id = useId();
  return (
    <figure className="chart" aria-labelledby={`${id}-t`} aria-describedby={`${id}-s`}>
      <figcaption>
        <span id={`${id}-t`} className="chart__title">
          {title}
        </span>
      </figcaption>
      <p id={`${id}-s`} className="chart__summary">
        {summary}
      </p>
      {legend && legend.length > 1 ? (
        <ul className="chart__legend" aria-label={t('chart.legend')}>
          {legend.map((l) => (
            <li key={l.label}>
              <span className={`swatch swatch--${l.series}`} aria-hidden="true" />
              {l.label}
            </li>
          ))}
        </ul>
      ) : null}
      {empty ? <p className="muted">{t('chart.noData')}</p> : children}
      {noTable ? null : (
        <details className="chart__table">
          <summary>{t('chart.viewTable')}</summary>
          <div
            className="table-wrap"
            role="region"
            aria-label={t('chart.tableRegion', { title })}
            tabIndex={0}
          >
            <table className="data-table">
              <caption className="yl-sr-only">{title}</caption>
              <thead>
                <tr>
                  {table.columns.map((c, i) => (
                    <th key={c} scope="col" className={i > 0 ? 'num' : ''}>
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, ci) =>
                      ci === 0 ? (
                        <th key={ci} scope="row">
                          {c ?? ''}
                        </th>
                      ) : (
                        <td key={ci} className="num">
                          {c === null ? (
                            <span className="muted">{t('chart.suppressed')}</span>
                          ) : typeof c === 'number' ? (
                            fmt.number(c)
                          ) : (
                            c
                          )}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </figure>
  );
}

/** Horizontal bars for category comparisons: label, bar and value on one row; sorted by the caller. */
export function HBarChart({
  title,
  summary,
  unit,
  data,
  valueHeader,
}: {
  title: string;
  summary: string;
  unit?: string;
  valueHeader?: string;
  data: Array<{ label: string; value: number | null }>;
}) {
  const { t, fmt } = useI18n();
  const max = Math.max(1, ...data.map((d) => d.value ?? 0));
  return (
    <ChartFigure
      title={title}
      summary={summary}
      empty={data.length === 0}
      table={{
        columns: [t('chart.category'), valueHeader ?? unit ?? t('chart.value')],
        rows: data.map((d) => [d.label, d.value]),
      }}
    >
      <ul className="hbar-list">
        {data.map((d) => (
          <li key={d.label} className="hbar">
            <span className="hbar__label">{d.label}</span>
            <span className="hbar__track" aria-hidden="true">
              <svg viewBox="0 0 100 10" preserveAspectRatio="none">
                <rect
                  className="fill-1"
                  x="0"
                  y="0"
                  width={d.value === null ? 0 : Math.max(0.8, (d.value / max) * 100)}
                  height="10"
                />
              </svg>
            </span>
            <span className="hbar__value">
              {d.value === null ? t('chart.suppressed') : fmt.number(d.value)}
            </span>
          </li>
        ))}
      </ul>
    </ChartFigure>
  );
}

const W = 640,
  H = 220,
  PL = 44,
  PR = 16,
  PT = 16,
  PB = 32;

function niceMax(v: number): number {
  if (v <= 5) return 5;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

/** One-series time line. Suppressed points (null) break the line instead of drawing a false zero. */
export function LineChart({
  title,
  summary,
  points,
  valueHeader,
  xHeader,
}: {
  title: string;
  summary: string;
  points: Array<{ x: string; y: number | null }>;
  valueHeader: string;
  xHeader?: string;
}) {
  const { t, fmt } = useI18n();
  const ys = points.map((p) => p.y ?? 0);
  const max = niceMax(Math.max(0, ...ys));
  const xAt = (i: number) =>
    PL + (points.length <= 1 ? (W - PL - PR) / 2 : (i / (points.length - 1)) * (W - PL - PR));
  const yAt = (v: number) => PT + (1 - v / max) * (H - PT - PB);
  const segments: string[] = [];
  let cur = '';
  points.forEach((p, i) => {
    if (p.y === null) {
      if (cur) segments.push(cur);
      cur = '';
      return;
    }
    cur += `${cur ? 'L' : 'M'}${xAt(i).toFixed(1)} ${yAt(p.y).toFixed(1)}`;
  });
  if (cur) segments.push(cur);
  const ticks = [0, 0.5, 1].map((f) => Math.round(max * f));
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
  return (
    <ChartFigure
      title={title}
      summary={summary}
      empty={points.length === 0}
      table={{
        columns: [xHeader ?? t('chart.date'), valueHeader],
        rows: points.map((p) => [p.x, p.y]),
      }}
    >
      <div
        className="chart__scroll"
        role="region"
        aria-label={t('chart.scrollRegion', { title })}
        tabIndex={0}
      >
        <svg
          className="chart__svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${title}. ${summary}`}
        >
          {ticks.map((tv) => (
            <g key={tv}>
              <line className="viz-grid" x1={PL} x2={W - PR} y1={yAt(tv)} y2={yAt(tv)} />
              <text className="viz-axis-text" x={PL - 8} y={yAt(tv) + 4} textAnchor="end">
                {fmt.compact(tv)}
              </text>
            </g>
          ))}
          {segments.map((d, i) => (
            <path key={i} className="viz-line" d={d} />
          ))}
          {points.map((p, i) =>
            p.y === null ? null : (
              <circle key={i} className="viz-dot" cx={xAt(i)} cy={yAt(p.y)} r="4">
                <title>{`${p.x}: ${fmt.number(p.y)}`}</title>
              </circle>
            ),
          )}
          {points.map((p, i) =>
            i % labelEvery === 0 ? (
              <text
                key={`x${i}`}
                className="viz-axis-text"
                x={xAt(i)}
                y={H - 10}
                textAnchor="middle"
              >
                {p.x.slice(5)}
              </text>
            ) : null,
          )}
        </svg>
      </div>
    </ChartFigure>
  );
}

/** Stacked vertical bars (one bar per period, one segment per series). Use only for parts of a whole. */
export function StackedBarChart({
  title,
  summary,
  groups,
  series,
}: {
  title: string;
  summary: string;
  groups: Array<{ label: string; values: Array<number | null> }>;
  series: Array<{ label: string; slot: 1 | 2 | 3 | 4 }>;
}) {
  const { t, fmt } = useI18n();
  const totals = groups.map((g) => g.values.reduce<number>((a, v) => a + (v ?? 0), 0));
  const max = niceMax(Math.max(0, ...totals));
  const bw = Math.min(56, ((W - PL - PR) / Math.max(1, groups.length)) * 0.6);
  const xAt = (i: number) => PL + ((i + 0.5) / Math.max(1, groups.length)) * (W - PL - PR);
  const yAt = (v: number) => PT + (1 - v / max) * (H - PT - PB);
  return (
    <ChartFigure
      title={title}
      summary={summary}
      empty={groups.length === 0}
      legend={series.map((s) => ({ label: s.label, series: s.slot }))}
      table={{
        columns: [t('chart.period'), ...series.map((s) => s.label)],
        rows: groups.map((g) => [g.label, ...g.values]),
      }}
    >
      <div
        className="chart__scroll"
        role="region"
        aria-label={t('chart.scrollRegion', { title })}
        tabIndex={0}
      >
        <svg
          className="chart__svg"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`${title}. ${summary}`}
        >
          {[0, 0.5, 1].map((f) => {
            const v = Math.round(max * f);
            return (
              <g key={f}>
                <line className="viz-grid" x1={PL} x2={W - PR} y1={yAt(v)} y2={yAt(v)} />
                <text className="viz-axis-text" x={PL - 8} y={yAt(v) + 4} textAnchor="end">
                  {fmt.compact(v)}
                </text>
              </g>
            );
          })}
          {groups.map((g, gi) => {
            let acc = 0;
            return (
              <g key={g.label}>
                {g.values.map((v, si) => {
                  if (!v) return null;
                  const y0 = yAt(acc);
                  acc += v;
                  const y1 = yAt(acc);
                  return (
                    <rect
                      key={si}
                      className={`fill-${series[si]!.slot} viz-gap`}
                      x={xAt(gi) - bw / 2}
                      y={y1}
                      width={bw}
                      height={Math.max(1, y0 - y1)}
                      rx="3"
                    >
                      <title>{`${g.label}, ${series[si]!.label}: ${fmt.number(v)}`}</title>
                    </rect>
                  );
                })}
                <text className="viz-axis-text" x={xAt(gi)} y={H - 10} textAnchor="middle">
                  {g.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </ChartFigure>
  );
}

/** Cohort retention grid: a real data table; each cell shows its percentage as text and the shading is a redundant one-hue ramp. */
export function RetentionHeatmap({
  title,
  summary,
  cohorts,
  weeks,
  cohortHeader,
}: {
  title: string;
  summary: string;
  cohortHeader: string;
  cohorts: Array<{ label: string; size: number | null; cells: Array<number | null | undefined> }>;
  weeks: number;
}) {
  const { t, fmt } = useI18n();
  const cols = Array.from({ length: weeks + 1 }, (_, i) => i);
  const bucket = (r: number) => Math.min(6, Math.floor(r * 7));
  return (
    <ChartFigure
      title={title}
      summary={summary}
      empty={cohorts.length === 0}
      noTable
      table={{ columns: [], rows: [] }}
    >
      <div
        className="chart__scroll"
        role="region"
        aria-label={t('chart.scrollRegion', { title })}
        tabIndex={0}
      >
        <table className="heat">
          <caption className="yl-sr-only">{title}</caption>
          <thead>
            <tr>
              <th scope="col">{cohortHeader}</th>
              <th scope="col">{t('analytics.retention.size')}</th>
              {cols.map((c) => (
                <th key={c} scope="col">
                  {t('analytics.retention.week', { week: c })}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cohorts.map((c) => (
              <tr key={c.label}>
                <th scope="row">{c.label}</th>
                <td className="heat-na">
                  {c.size === null ? t('chart.suppressed') : fmt.number(c.size)}
                </td>
                {cols.map((k) => {
                  const v = c.cells[k];
                  if (v === undefined) return <td key={k} />;
                  if (v === null)
                    return (
                      <td key={k} className="heat-na">
                        {t('chart.suppressed')}
                      </td>
                    );
                  return (
                    <td key={k} className={`heat-${bucket(v)}`}>
                      {fmt.percent(v)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartFigure>
  );
}

export function Kpi({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="kpi">
      <span className="kpi__label">{label}</span>
      <span className="kpi__value">{value}</span>
      {note ? <span className="kpi__note">{note}</span> : null}
    </div>
  );
}
