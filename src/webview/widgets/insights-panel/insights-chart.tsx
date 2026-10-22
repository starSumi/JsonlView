import React, { useId } from 'react';

export interface InsightCategory {
  label: string;
  count: number;
  approximate?: boolean;
}

export interface InsightTimeBucket {
  start: string;
  count: number;
}

interface CategoryChartProps {
  categories: readonly InsightCategory[];
}

interface TimeChartProps {
  buckets: readonly InsightTimeBucket[];
}

const CHART_WIDTH = 640;
const CHART_HEIGHT = 200;
const PLOT_TOP = 16;
const PLOT_BOTTOM = 184;
const PLOT_HEIGHT = PLOT_BOTTOM - PLOT_TOP;
const BAR_GAP = 3;
const MAX_RENDERED_BARS = 64;

export function CategoryChart({ categories }: CategoryChartProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const visible = categories.slice(0, MAX_RENDERED_BARS);
  const maximum = maximumCount(visible);

  return (
    <div className="insights-chart-frame">
      <svg
        className="insights-chart insights-chart-categories"
        viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
        width={CHART_WIDTH}
        height={CHART_HEIGHT}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>Category count comparison</title>
        <desc id={descriptionId}>
          {chartDescription(visible.length, categories.length, maximum, 'categories')}
        </desc>
        <ChartGrid />
        {visible.map((category, index) => {
          const count = safeCount(category.count);
          const geometry = verticalBar(index, visible.length, count, maximum);
          return (
            <rect
              className={`insights-chart-bar${category.approximate === true ? ' is-approximate' : ''}`}
              key={`${category.label}:${String(index)}`}
              x={geometry.x}
              y={geometry.y}
              width={geometry.width}
              height={geometry.height}
              rx={1}
            >
              <title>{`${category.label}: ${formatCount(count)}${category.approximate === true ? ' approximate' : ''}`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

export function TimeChart({ buckets }: TimeChartProps): React.JSX.Element {
  const titleId = useId();
  const descriptionId = useId();
  const visible = buckets.slice(0, MAX_RENDERED_BARS);
  const maximum = maximumCount(visible);

  return (
    <div className="insights-chart-frame">
      <svg
        className="insights-chart insights-chart-time"
        viewBox={`0 0 ${String(CHART_WIDTH)} ${String(CHART_HEIGHT)}`}
        width={CHART_WIDTH}
        height={CHART_HEIGHT}
        role="img"
        aria-labelledby={`${titleId} ${descriptionId}`}
      >
        <title id={titleId}>Records over time</title>
        <desc id={descriptionId}>
          {chartDescription(visible.length, buckets.length, maximum, 'time buckets')}
        </desc>
        <ChartGrid />
        {visible.map((bucket, index) => {
          const count = safeCount(bucket.count);
          const geometry = verticalBar(index, visible.length, count, maximum);
          return (
            <rect
              className="insights-chart-bar"
              key={`${bucket.start}:${String(index)}`}
              x={geometry.x}
              y={geometry.y}
              width={geometry.width}
              height={geometry.height}
              rx={1}
            >
              <title>{`${formatBucketStart(bucket.start)}: ${formatCount(count)}`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}

function ChartGrid(): React.JSX.Element {
  return (
    <g className="insights-chart-grid" aria-hidden="true">
      {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
        const y = PLOT_BOTTOM - ratio * PLOT_HEIGHT;
        return <line key={ratio} x1={0} x2={CHART_WIDTH} y1={y} y2={y} />;
      })}
    </g>
  );
}

function verticalBar(index: number, total: number, count: number, maximum: number): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const slotWidth = total > 0 ? CHART_WIDTH / total : CHART_WIDTH;
  const width = Math.max(1, slotWidth - Math.min(BAR_GAP, slotWidth * 0.35));
  const ratio = maximum > 0 ? count / maximum : 0;
  const height = Math.max(count > 0 ? 1 : 0, ratio * PLOT_HEIGHT);
  return {
    x: index * slotWidth + (slotWidth - width) / 2,
    y: PLOT_BOTTOM - height,
    width,
    height,
  };
}

function maximumCount(values: readonly { count: number }[]): number {
  let maximum = 0;
  for (const value of values) maximum = Math.max(maximum, safeCount(value.count));
  return maximum;
}

export function safeCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
}

export function formatCount(value: number): string {
  return safeCount(value).toLocaleString();
}

export function formatBucketStart(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toISOString().replace('.000Z', 'Z').replace('T', ' ');
}

function chartDescription(visible: number, total: number, maximum: number, noun: string): string {
  const subset = visible < total ? ` Showing the first ${String(visible)} of ${String(total)}.` : '';
  return `${String(visible)} ${noun}; largest count ${formatCount(maximum)}.${subset}`;
}
