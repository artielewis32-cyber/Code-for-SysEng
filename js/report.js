import { FIELDS, MIN_SPEED_FOR_COEFF_MS } from './config.js';

/**
 * End-of-session report.
 *
 * Built from everything the tunnel sent during a session:
 *   - a summary (duration, readings, peaks, time in each mode, faults)
 *   - test points: each period where the airspeed was held steady, with the
 *     average airspeed, drag, lift, Cd and Cl over that period
 *   - an event log (mode changes and status / fault messages)
 *   - the full list of readings
 */

// A test point is a run of samples in one mode whose airspeed stays within
// this band of the running average, for at least MIN_HOLD_S seconds.
const HOLD_TOL_MS = 0.35;   // m/s
const HOLD_TOL_FRAC = 0.03; // or 3 % of airspeed, whichever is larger
const MIN_HOLD_S = 2.0;
const MIN_POINT_SPEED_MS = 0.5;

export const fmtClock = (s, decimals = 0) => {
  const neg = s < 0;
  const a = Math.abs(s);
  const m = Math.floor(a / 60);
  const sec = (a - m * 60).toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
  return `${neg ? '-' : ''}${m}:${sec}`;
};

const meanOf = (arr, key) => {
  let sum = 0, n = 0;
  for (const s of arr) {
    const v = s[key];
    if (v !== null && v !== undefined && Number.isFinite(v)) { sum += v; n++; }
  }
  return n ? sum / n : null;
};

/** Split the session into steady-airspeed test points. */
export function findTestPoints(samples) {
  const points = [];
  let seg = [];
  let segMean = 0;

  const close = () => {
    if (seg.length >= 2) {
      const hold = seg[seg.length - 1].t - seg[0].t;
      if (hold >= MIN_HOLD_S) {
        const mode = seg[0].mode;
        const v = meanOf(seg, 'airspeed_ms');
        const coeffOk = mode === 'FORCE' && v !== null && v >= MIN_SPEED_FOR_COEFF_MS;
        points.push({
          mode,
          start: seg[0].t,
          hold,
          count: seg.length,
          airspeed_ms: v,
          drag_N: meanOf(seg, 'drag_N'),
          lift_N: meanOf(seg, 'lift_N'),
          Cd: coeffOk ? meanOf(seg, 'Cd') : null,
          Cl: coeffOk ? meanOf(seg, 'Cl') : null,
        });
      }
    }
    seg = [];
  };

  for (const s of samples) {
    const usable = (s.mode === 'FORCE' || s.mode === 'SMOKE')
      && s.airspeed_ms !== null && s.airspeed_ms >= MIN_POINT_SPEED_MS;
    if (!usable) { close(); continue; }
    if (seg.length) {
      const tol = Math.max(HOLD_TOL_MS, segMean * HOLD_TOL_FRAC);
      const gap = s.t - seg[seg.length - 1].t;
      if (s.mode !== seg[0].mode || Math.abs(s.airspeed_ms - segMean) > tol || gap > 1.5) close();
    }
    seg.push(s);
    segMean += (s.airspeed_ms - segMean) / seg.length;
    if (seg.length === 1) segMean = s.airspeed_ms;
  }
  close();
  return points;
}

export function buildReport({ samples, events, meta }) {
  const modeTime = { FORCE: 0, SMOKE: 0, IDLE: 0, FAULT: 0 };
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt > 0 && dt < 2) modeTime[samples[i - 1].mode] += dt;
  }
  const force = samples.filter((s) => s.mode === 'FORCE');
  const steady = force.filter((s) => s.airspeed_ms !== null && s.airspeed_ms >= MIN_SPEED_FOR_COEFF_MS);
  const vals = (arr, k) => arr.map((s) => s[k]).filter((x) => x !== null && Number.isFinite(x));
  const maxV = vals(samples, 'airspeed_ms');
  const drags = vals(force, 'drag_N');
  const lifts = vals(force, 'lift_N');

  return {
    meta,
    samples,
    events,
    points: findTestPoints(samples),
    summary: {
      duration: samples.length ? samples[samples.length - 1].t - samples[0].t : 0,
      count: samples.length,
      maxAirspeed: maxV.length ? Math.max(...maxV) : null,
      peakDrag: drags.length ? Math.max(...drags) : null,
      peakDownforce: lifts.length && Math.min(...lifts) < 0 ? -Math.min(...lifts) : null,
      meanCd: meanOf(steady, 'Cd'),
      meanCl: meanOf(steady, 'Cl'),
      modeTime,
      faults: events.filter((e) => e.kind === 'mode' && e.mode === 'FAULT').length,
    },
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------
const c = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? '' : v.toFixed(d));
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

function metaLines(r) {
  return [
    `# Wind tunnel session report`,
    `# model,${q(r.meta.model || '')}`,
    `# source,${r.meta.source}`,
    `# started_at,${r.meta.startedAt}`,
    `# ended_at,${r.meta.endedAt}`,
    `# frontal_area_mm2,${r.meta.frontalAreaMm2 ?? ''}`,
  ];
}

export function testPointsCsv(r) {
  const rows = [
    ...metaLines(r),
    'point,mode,start_s,hold_s,airspeed_ms,airspeed_kmh,drag_N,lift_N,Cd,Cl,readings',
    ...r.points.map((p, i) => [
      i + 1, p.mode, p.start.toFixed(1), p.hold.toFixed(1),
      c(p.airspeed_ms, 2), c(p.airspeed_ms === null ? null : p.airspeed_ms * 3.6, 1),
      c(p.drag_N, 3), c(p.lift_N, 3), c(p.Cd, 3), c(p.Cl, 3), p.count,
    ].join(',')),
  ];
  return rows.join('\n') + '\n';
}

export function readingsCsv(r) {
  const rows = [
    ...metaLines(r),
    `session_time_s,${FIELDS.join(',')}`,
    ...r.samples.map((s) => [
      s.t.toFixed(3), s.timestamp, s.mode,
      c(s.airspeed_ms, 2), c(s.drag_N, 3), c(s.lift_N, 3), c(s.Cd, 3), c(s.Cl, 3),
    ].join(',')),
  ];
  return rows.join('\n') + '\n';
}

/** Readings thinned to roughly one per second (the last reading in each second). */
export function perSecond(samples) {
  const out = [];
  let lastSec = -1;
  for (let i = 0; i < samples.length; i++) {
    const sec = Math.floor(samples[i].t);
    const next = samples[i + 1];
    if (!next || Math.floor(next.t) !== sec || next.mode !== samples[i].mode) {
      if (sec !== lastSec || out[out.length - 1]?.mode !== samples[i].mode) out.push(samples[i]);
      lastSec = sec;
    }
  }
  return out;
}
