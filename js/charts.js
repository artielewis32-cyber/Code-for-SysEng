/* global Chart */
import { SMOKE_BAND_MS, SMOKE_CUTOFF_MS, FORCE_MAX_MS } from './config.js';

// ---------------------------------------------------------------------------
// Theme helpers — colours come from CSS custom properties so light/dark mode
// is defined in one place (css/styles.css).
// ---------------------------------------------------------------------------
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function theme() {
  return {
    ink: css('--text-primary'),
    ink2: css('--text-secondary'),
    muted: css('--text-muted'),
    grid: css('--grid'),
    axis: css('--axis'),
    surface: css('--surface-1'),
    band: css('--band'),
    s1: css('--series-1'),
    s2: css('--series-2'),
    s3: css('--series-3'),
  };
}

const fmtClock = (s) => {
  const sign = s < 0 ? '-' : '';
  const a = Math.abs(Math.round(s));
  return `${sign}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------------------
// Small Chart.js plugins
// ---------------------------------------------------------------------------

// Vertical crosshair that follows the tooltip on time-series charts.
const crosshair = {
  id: 'crosshair',
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() ?? [];
    if (!active.length || chart.config.type !== 'line') return;
    const x = active[0].element.x;
    const { top, bottom } = chart.chartArea;
    const ctx = chart.ctx;
    ctx.save();
    ctx.strokeStyle = theme().axis;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    ctx.restore();
  },
};

// Shaded horizontal bands + dashed reference lines (e.g. the smoke-mode band).
const references = {
  id: 'references',
  beforeDatasetsDraw(chart, _args, opts) {
    const y = chart.scales.y;
    if (!y || !opts) return;
    const { left, right, top, bottom } = chart.chartArea;
    const t = theme();
    const ctx = chart.ctx;
    ctx.save();
    ctx.font = '11px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'bottom';
    for (const b of opts.bands ?? []) {
      const y1 = Math.max(top, Math.min(bottom, y.getPixelForValue(b.to)));
      const y2 = Math.max(top, Math.min(bottom, y.getPixelForValue(b.from)));
      if (y2 - y1 < 1) continue;
      ctx.fillStyle = t.band;
      ctx.fillRect(left, y1, right - left, y2 - y1);
      ctx.fillStyle = t.muted;
      // Label sits inside the band when it fits, otherwise just above it.
      ctx.textAlign = 'right';
      ctx.fillText(b.label, right - 6, y2 - y1 >= 16 ? y2 - 3 : y1 - 2);
      ctx.textAlign = 'left';
    }
    for (const l of opts.lines ?? []) {
      const py = y.getPixelForValue(l.y);
      if (py < top || py > bottom) continue;
      ctx.strokeStyle = t.muted;
      ctx.setLineDash([4, 4]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, py);
      ctx.lineTo(right, py);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = t.muted;
      ctx.textAlign = 'right';
      ctx.fillText(l.label, right - 4, py - 2);
      ctx.textAlign = 'left';
    }
    ctx.restore();
  },
};

// Direct label at the right-hand end of each line series (identity is never
// carried by colour alone). Text uses ink colour; a short coloured tick sits
// beside it.
const endLabels = {
  id: 'endLabels',
  afterDatasetsDraw(chart, _args, opts) {
    if (!opts?.enabled) return;
    const t = theme();
    const ctx = chart.ctx;
    const placed = [];
    ctx.save();
    ctx.font = '12px system-ui, -apple-system, "Segoe UI", sans-serif';
    ctx.textBaseline = 'middle';
    chart.data.datasets.forEach((ds, i) => {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden || !meta.data.length) return;
      const pt = meta.data[meta.data.length - 1];
      let y = pt.y;
      for (const p of placed) if (Math.abs(p - y) < 14) y = p + (y >= p ? 14 : -14);
      placed.push(y);
      const x = chart.chartArea.right + 6;
      ctx.strokeStyle = ds.borderColor;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + 8, y);
      ctx.stroke();
      ctx.fillStyle = t.ink2;
      ctx.fillText(ds.shortLabel ?? ds.label, x + 12, y);
    });
    ctx.restore();
  },
};

// ---------------------------------------------------------------------------
// Chart construction
// ---------------------------------------------------------------------------
function baseOptions({ yTitle, xTitle, xTicks }) {
  const t = theme();
  const font = { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 12 };
  return {
    animation: false,
    responsive: true,
    maintainAspectRatio: false,
    parsing: false,
    normalized: true,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    layout: { padding: { right: 8 } },
    scales: {
      x: {
        type: 'linear',
        title: { display: !!xTitle, text: xTitle, color: t.muted, font },
        grid: { color: t.grid, drawTicks: false },
        border: { color: t.axis },
        ticks: { color: t.muted, font, padding: 6, maxRotation: 0, callback: xTicks },
      },
      y: {
        title: { display: true, text: yTitle, color: t.muted, font },
        grid: { color: t.grid, drawTicks: false },
        border: { display: false },
        ticks: { color: t.muted, font, padding: 6 },
      },
    },
    plugins: {
      legend: {
        position: 'top',
        align: 'start',
        labels: { color: t.ink2, font, usePointStyle: true, pointStyle: 'line', boxWidth: 18, padding: 14 },
      },
      tooltip: {
        backgroundColor: t.surface,
        titleColor: t.ink,
        bodyColor: t.ink2,
        borderColor: t.axis,
        borderWidth: 1,
        padding: 10,
        usePointStyle: true,
        titleFont: { ...font, weight: '600' },
        bodyFont: font,
      },
    },
  };
}

const lineDataset = (label, shortLabel, color) => ({
  label,
  shortLabel,
  data: [],
  borderColor: color,
  backgroundColor: color,
  borderWidth: 2,
  pointRadius: 0,
  pointHoverRadius: 5,
  pointHoverBorderWidth: 2,
  tension: 0,
  spanGaps: false,
});

export class Dashboard {
  constructor({ forceCanvas, airspeedCanvas, scatterCanvas }) {
    const t = theme();
    const timeTicks = (v) => fmtClock(v);

    // 1. Drag & lift vs time — both in newtons, so one shared axis is correct.
    const fOpts = baseOptions({ yTitle: 'Force (N)', xTicks: timeTicks });
    fOpts.layout.padding.right = 56;
    fOpts.interaction = { mode: 'index', intersect: false };
    fOpts.scales.y.suggestedMin = -0.2;
    fOpts.scales.y.suggestedMax = 0.5;
    fOpts.plugins.endLabels = { enabled: true };
    fOpts.plugins.references = { lines: [{ y: 0, label: '' }] };
    fOpts.plugins.tooltip.callbacks = {
      title: (items) => `t = ${fmtClock(items[0].parsed.x)}`,
      label: (c) => ` ${c.dataset.label}: ${c.parsed.y.toFixed(3)} N`,
    };
    this.force = new Chart(forceCanvas, {
      type: 'line',
      data: { datasets: [lineDataset('Drag (drag_N)', 'Drag', t.s1), lineDataset('Lift / downforce (lift_N)', 'Lift', t.s2)] },
      options: fOpts,
      plugins: [crosshair, references, endLabels],
    });

    // 2. Airspeed vs time — single series, so no legend; the title names it.
    const aOpts = baseOptions({ yTitle: 'Airspeed (m/s)', xTicks: timeTicks });
    aOpts.interaction = { mode: 'index', intersect: false };
    aOpts.plugins.legend.display = false;
    aOpts.scales.y.min = 0;
    aOpts.scales.y.suggestedMax = 6;
    aOpts.plugins.references = {
      bands: [{ from: SMOKE_BAND_MS[0], to: SMOKE_BAND_MS[1], label: 'Smoke-mode band 1–3 m/s' }],
      lines: [
        { y: SMOKE_CUTOFF_MS, label: 'Smoke cut-off 4 m/s' },
        { y: FORCE_MAX_MS, label: 'Force-mode max 80 km/h' },
      ],
    };
    aOpts.plugins.tooltip.callbacks = {
      title: (items) => `t = ${fmtClock(items[0].parsed.x)}`,
      label: (c) => ` Airspeed: ${c.parsed.y.toFixed(2)} m/s (${(c.parsed.y * 3.6).toFixed(1)} km/h)`,
    };
    this.airspeed = new Chart(airspeedCanvas, {
      type: 'line',
      data: { datasets: [lineDataset('Airspeed (airspeed_ms)', 'Airspeed', t.s1)] },
      options: aOpts,
      plugins: [crosshair, references],
    });

    // 3. Drag vs airspeed (Force mode) — shows drag rising with speed and
    //    lets saved runs be compared (ConOps scenarios A & B).
    //    Capped at 3 series: the palette's first three slots are the only
    //    ones safe for colour-blind readers when every pair can overlap.
    const sOpts = baseOptions({ yTitle: 'Drag (N)', xTitle: 'Airspeed (m/s)', xTicks: (v) => v });
    sOpts.normalized = false; // scatter points are not sorted by x
    sOpts.interaction = { mode: 'nearest', intersect: true };
    sOpts.scales.x.min = 0;
    sOpts.scales.x.suggestedMax = 23;
    sOpts.scales.y.suggestedMin = 0;
    sOpts.scales.y.suggestedMax = 0.5;
    sOpts.plugins.legend.labels.pointStyle = 'circle';
    sOpts.plugins.legend.labels.boxWidth = 8;
    sOpts.plugins.tooltip.callbacks = {
      label: (c) => ` ${c.dataset.label}: ${c.parsed.y.toFixed(3)} N at ${c.parsed.x.toFixed(1)} m/s`,
    };
    this.scatter = new Chart(scatterCanvas, {
      type: 'scatter',
      data: { datasets: [] },
      options: sOpts,
    });

    this.seriesColors = () => [theme().s1, theme().s2, theme().s3];
  }

  /**
   * Redraw the charts.
   * @param samples   session samples, each with `t` (seconds since session start)
   * @param windowS   visible time window in seconds
   * @param compare   up to two saved runs to overlay on the drag-vs-airspeed chart
   */
  render(samples, windowS, compare = []) {
    const now = samples.length ? samples[samples.length - 1].t : 0;
    const from = Math.max(0, now - windowS);
    const start = lowerBound(samples, from);

    const drag = [], lift = [], air = [], live = [];
    for (let i = start; i < samples.length; i++) {
      const s = samples[i];
      if (s.gap) { // break the line across a reconnect
        drag.push({ x: s.t, y: null }); lift.push({ x: s.t, y: null }); air.push({ x: s.t, y: null });
        continue;
      }
      drag.push({ x: s.t, y: s.drag_N });
      lift.push({ x: s.t, y: s.lift_N });
      air.push({ x: s.t, y: s.airspeed_ms });
      if (s.mode === 'FORCE' && s.airspeed_ms !== null && s.drag_N !== null && s.airspeed_ms > 0.5) {
        live.push({ x: s.airspeed_ms, y: s.drag_N });
      }
    }

    for (const c of [this.force, this.airspeed]) {
      c.options.scales.x.min = from;
      c.options.scales.x.max = Math.max(from + windowS, now);
    }
    this.force.data.datasets[0].data = drag;
    this.force.data.datasets[1].data = lift;
    this.airspeed.data.datasets[0].data = air;

    const colors = this.seriesColors();
    const sets = [scatterSet('Live session', live, colors[0])];
    compare.slice(0, 2).forEach((run, i) => {
      const pts = [];
      for (const s of run.samples) {
        if (s.mode === 'FORCE' && s.airspeed_ms > 0.5 && s.drag_N !== null) pts.push({ x: s.airspeed_ms, y: s.drag_N });
      }
      sets.push(scatterSet(run.name, thin(pts, 800), colors[i + 1]));
    });
    this.scatter.data.datasets = sets;

    this.force.update('none');
    this.airspeed.update('none');
    this.scatter.update('none');
  }

  /** Re-read colours after a light/dark switch. */
  applyTheme() {
    const t = theme();
    for (const c of [this.force, this.airspeed, this.scatter]) {
      const o = c.options;
      for (const axis of [o.scales.x, o.scales.y]) {
        axis.grid.color = t.grid;
        axis.ticks.color = t.muted;
        axis.title.color = t.muted;
        if (axis.border) axis.border.color = t.axis;
      }
      o.plugins.legend.labels.color = t.ink2;
      Object.assign(o.plugins.tooltip, {
        backgroundColor: t.surface, titleColor: t.ink, bodyColor: t.ink2, borderColor: t.axis,
      });
    }
    const setColor = (ds, col) => { ds.borderColor = col; ds.backgroundColor = col; };
    setColor(this.force.data.datasets[0], t.s1);
    setColor(this.force.data.datasets[1], t.s2);
    setColor(this.airspeed.data.datasets[0], t.s1);
    for (const c of [this.force, this.airspeed, this.scatter]) c.update('none');
  }
}

function scatterSet(label, data, color) {
  return {
    label,
    data,
    borderColor: theme().surface, // 1px surface ring keeps overlapping points legible
    borderWidth: 1,
    backgroundColor: color,
    pointRadius: 4,
    pointHoverRadius: 6,
    pointHitRadius: 6,
  };
}

function lowerBound(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function thin(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[Math.floor(i)]);
  return out;
}
