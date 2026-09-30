import { FIELDS, MIN_SPEED_FOR_COEFF_MS } from './config.js';
import { parseLine } from './parser.js';

const STORAGE_KEY = 'windTunnelRuns.v1';

/**
 * Saved test runs (ConOps Scenario A: record drag & downforce → repeat with
 * other vehicles → compare). Runs are kept in the browser's localStorage and
 * can be exported/imported as CSV for analysis or CFD comparison (SN-08).
 */
export class RunStore {
  constructor() {
    this.runs = [];
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      this.runs = raw ? JSON.parse(raw) : [];
    } catch {
      this.runs = [];
    }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.runs));
      return true;
    } catch {
      return false; // storage full or blocked — runs still live in memory
    }
  }

  add(run) {
    this.runs.push(run);
    return this.save();
  }

  remove(id) {
    this.runs = this.runs.filter((r) => r.id !== id);
    this.save();
  }

  get(id) {
    return this.runs.find((r) => r.id === id);
  }
}

export function newRun(name, frontalAreaMm2) {
  return {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: name || 'Untitled model',
    frontalAreaMm2,
    startedAt: new Date().toISOString(),
    samples: [],
  };
}

/** Summary statistics over the Force-mode portion of a run. */
export function runStats(run) {
  const force = run.samples.filter((s) => s.mode === 'FORCE');
  const steady = force.filter((s) => s.airspeed_ms !== null && s.airspeed_ms >= MIN_SPEED_FOR_COEFF_MS);
  const mean = (arr, k) => {
    const v = arr.map((s) => s[k]).filter((x) => x !== null && Number.isFinite(x));
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  const max = (arr, k) => {
    const v = arr.map((s) => s[k]).filter((x) => x !== null && Number.isFinite(x));
    return v.length ? Math.max(...v) : null;
  };
  const min = (arr, k) => {
    const v = arr.map((s) => s[k]).filter((x) => x !== null && Number.isFinite(x));
    return v.length ? Math.min(...v) : null;
  };
  const first = run.samples[0]?.t ?? 0;
  const last = run.samples[run.samples.length - 1]?.t ?? 0;
  return {
    duration: last - first,
    count: run.samples.length,
    maxAirspeed: max(force, 'airspeed_ms'),
    peakDrag: max(force, 'drag_N'),
    peakDownforce: min(force, 'lift_N'), // most negative lift = most downforce
    meanCd: mean(steady, 'Cd'),
    meanCl: mean(steady, 'Cl'),
  };
}

// ---------------------------------------------------------------------------
// CSV export / import
// ---------------------------------------------------------------------------
const cell = (v) => (v === null || v === undefined ? '' : v);

export function runToCsv(run) {
  const lines = [
    `# model,${run.name.replace(/[\r\n,]/g, ' ')}`,
    `# frontal_area_mm2,${run.frontalAreaMm2}`,
    `# started_at,${run.startedAt}`,
    `${FIELDS.join(',')},host_time_s`,
  ];
  for (const s of run.samples) {
    lines.push([...FIELDS.map((f) => cell(s[f])), s.t.toFixed(3)].join(','));
  }
  return lines.join('\n') + '\n';
}

export function csvToRun(text, fallbackName) {
  const run = newRun(fallbackName, null);
  let hostCol = false;
  let firstTs = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const meta = line.match(/^#\s*(model|frontal_area_mm2|started_at),(.*)$/);
    if (meta) {
      if (meta[1] === 'model') run.name = meta[2].trim() || run.name;
      if (meta[1] === 'frontal_area_mm2') run.frontalAreaMm2 = Number(meta[2]) || null;
      if (meta[1] === 'started_at') run.startedAt = meta[2].trim();
      continue;
    }
    if (line.toLowerCase().startsWith('timestamp')) {
      hostCol = line.toLowerCase().includes('host_time_s');
      continue;
    }
    const parsed = parseLine(line);
    if (parsed?.type !== 'sample') continue;
    if (firstTs === null) firstTs = parsed.timestamp;
    const parts = line.split(',');
    const t = hostCol && parts[7] !== undefined ? Number(parts[7]) : (parsed.timestamp - firstTs) / 1000;
    const { type, ...sample } = parsed;
    run.samples.push({ ...sample, t });
  }
  return run;
}

export function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const safeFileName = (s) => s.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '') || 'run';
