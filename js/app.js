import {
  UPDATE_LIMIT_MS, STALE_AFTER_MS, SMOKE_CUTOFF_MS, COEFF_TOLERANCE,
  MIN_SPEED_FOR_COEFF_MS, DEFAULT_FRONTAL_AREA_MM2, MAX_SESSION_SAMPLES,
} from './config.js';
import { parseLine, coefficient } from './parser.js';
import { SerialSource } from './serial.js';
import { Simulator } from './simulator.js';
import { Dashboard } from './charts.js';
import { RunStore, newRun, runStats, runToCsv, csvToRun, downloadText, safeFileName } from './runs.js';
import { buildReport, testPointsCsv, readingsCsv, perSecond, fmtClock } from './report.js';

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const state = {
  source: null,          // 'serial' | 'demo' | null
  serial: null,
  sim: null,
  sessionStart: 0,
  samples: [],           // { t, timestamp, mode, airspeed_ms, drag_N, lift_N, Cd, Cl }
  lastArrival: 0,
  intervals: [],         // recent inter-arrival times (ms)
  latest: null,
  paused: false,
  dirty: false,
  recording: null,       // run currently being recorded
  compare: new Set(),    // run ids overlaid on the scatter chart (max 2)
  consoleLines: [],
  events: [],            // { t, kind: 'mode' | 'message', text, mode? } for the session report
  startedAt: null,       // wall-clock start of the session
  report: null,          // the report currently on screen
  lastMessage: '',
};

const store = new RunStore();
let charts;

// ---------------------------------------------------------------------------
// Preferences (per-browser convenience only)
// ---------------------------------------------------------------------------
const pref = {
  get(k, d) { try { const v = localStorage.getItem(`wt.${k}`); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`wt.${k}`, v); } catch { /* ignore */ } },
};

function frontalAreaM2() {
  const mm2 = Number($('inpArea').value);
  return Number.isFinite(mm2) && mm2 > 0 ? mm2 / 1e6 : DEFAULT_FRONTAL_AREA_MM2 / 1e6;
}

// ---------------------------------------------------------------------------
// Incoming lines → samples
// ---------------------------------------------------------------------------
function handleLine(line) {
  logConsole(line);
  const parsed = parseLine(line);
  if (!parsed) return;
  if (parsed.type === 'message') {
    state.lastMessage = parsed.text;
    if (state.source) state.events.push({ t: (performance.now() - state.sessionStart) / 1000, kind: 'message', text: parsed.text });
    $('deviceMsg').textContent = parsed.text;
    $('deviceMsg').title = parsed.text;
    return;
  }
  if (parsed.type !== 'sample') return;

  const now = performance.now();
  if (state.lastArrival) {
    state.intervals.push(now - state.lastArrival);
    if (state.intervals.length > 20) state.intervals.shift();
  }
  state.lastArrival = now;

  const { type, ...fields } = parsed;
  const sample = { t: (now - state.sessionStart) / 1000, ...fields };
  if (!state.latest || state.latest.mode !== sample.mode) {
    state.events.push({ t: sample.t, kind: 'mode', mode: sample.mode, text: `Entered ${sample.mode} mode` });
  }
  state.samples.push(sample);
  if (state.samples.length > MAX_SESSION_SAMPLES) state.samples.splice(0, state.samples.length - MAX_SESSION_SAMPLES);
  state.latest = sample;
  if (state.recording) state.recording.samples.push(sample);
  state.dirty = true;

  updateReadouts(sample);
  updateBanner();
}

// ---------------------------------------------------------------------------
// Readouts
// ---------------------------------------------------------------------------
const fmt = (v, d) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : v.toFixed(d));

function updateReadouts(s) {
  const chip = $('modeChip');
  chip.dataset.mode = s.mode;
  chip.querySelector('.chip-text').textContent = s.mode;

  $('vAirspeed').textContent = fmt(s.airspeed_ms, 2);
  $('vAirspeedKmh').textContent = s.airspeed_ms === null ? '— km/h' : `${(s.airspeed_ms * 3.6).toFixed(1)} km/h`;
  $('vDrag').textContent = fmt(s.drag_N, 2);
  $('vLift').textContent = fmt(s.lift_N, 2);
  $('vLiftSub').textContent = s.lift_N === null ? 'Vertical force'
    : s.lift_N < -0.005 ? `${Math.abs(s.lift_N).toFixed(2)} N downforce`
    : s.lift_N > 0.005 ? `${s.lift_N.toFixed(2)} N lift` : 'Vertical force';

  $('vCd').textContent = fmt(s.Cd, 3);
  $('vCl').textContent = fmt(s.Cl, 3);
  coeffCheck('vCdCheck', s.Cd, s.drag_N, s);
  coeffCheck('vClCheck', s.Cl, s.lift_N, s);

  // REQ-016 / REQ-017: telemetry must refresh at 1 s or faster.
  if (state.intervals.length >= 3) {
    const sorted = [...state.intervals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const worst = sorted[sorted.length - 1];
    $('vRate').textContent = Math.round(median);
    const ok = worst <= UPDATE_LIMIT_MS;
    $('vRateSub').innerHTML = ok
      ? `<span class="ok">✓ Meets ≤ 1 s</span><br>slowest ${Math.round(worst)} ms`
      : `<span class="bad">✕ Too slow</span><br>slowest ${Math.round(worst)} ms`;
  }

  if (state.tableOpen) renderSampleTable();
}

/**
 * Cross-check the firmware's coefficient against one computed here from
 * force, airspeed and the operator's frontal area (REQ-018/019: ±5 %).
 */
function coeffCheck(id, deviceVal, force, s) {
  const el = $(id);
  if (s.mode !== 'FORCE') { el.textContent = 'Shown in Force mode'; return; }
  const web = s.airspeed_ms >= MIN_SPEED_FOR_COEFF_MS ? coefficient(force, s.airspeed_ms, frontalAreaM2()) : null;
  if (web === null) { el.textContent = `Needs ≥ ${MIN_SPEED_FOR_COEFF_MS} m/s`; return; }
  if (deviceVal === null) { el.textContent = `Web calc ${web.toFixed(3)} (not sent by tunnel)`; return; }
  const err = Math.abs(web) > 1e-6 ? Math.abs(deviceVal - web) / Math.abs(web) : 0;
  const ok = err <= COEFF_TOLERANCE;
  el.innerHTML = `Web check ${web.toFixed(3)}<br><span class="${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'} ${(err * 100).toFixed(1)}%</span>`;
  el.title = ok ? 'Matches the tunnel within ±5 % (REQ-018/019)'
    : 'Differs from the tunnel by more than 5 %. Check the frontal area matches the value set on the tunnel.';
}

function resetReadouts() {
  for (const id of ['vAirspeed', 'vDrag', 'vLift', 'vCd', 'vCl', 'vRate']) $(id).textContent = '—';
  $('vAirspeedKmh').textContent = '— km/h';
  $('vLiftSub').textContent = 'Vertical force';
  $('vCdCheck').textContent = 'Shown in Force mode';
  $('vClCheck').textContent = 'Shown in Force mode';
  $('vRateSub').textContent = 'Requirement: ≤ 1000 ms';
  const chip = $('modeChip');
  chip.dataset.mode = 'NONE';
  chip.querySelector('.chip-text').textContent = 'No data';
}

// ---------------------------------------------------------------------------
// Banner: fault > stale link > smoke over-speed
// ---------------------------------------------------------------------------
function updateBanner() {
  const b = $('banner');
  const s = state.latest;
  const stale = state.source && state.lastArrival && performance.now() - state.lastArrival > STALE_AFTER_MS;
  let level = null, title = '', text = '';

  if (s?.mode === 'FAULT' && !stale) {
    level = 'critical';
    title = 'Fault: fan held off.';
    text = state.lastMessage && /fault/i.test(state.lastMessage) ? state.lastMessage : 'The tunnel reported a fault. Check the lid interlock and force sensors.';
  } else if (stale) {
    level = 'warning';
    title = 'No data.';
    text = `Nothing received for ${((performance.now() - state.lastArrival) / 1000).toFixed(0)} s. Check the USB cable, or that the tunnel is powered on.`;
  } else if (s?.mode === 'SMOKE' && s.airspeed_ms > SMOKE_CUTOFF_MS) {
    level = 'warning';
    title = 'Airspeed above 4 m/s in Smoke mode.';
    text = 'Smoke injection should be disabled (REQ-006).';
  }

  if (!level) { b.hidden = true; return; }
  b.hidden = false;
  b.dataset.level = level;
  b.querySelector('.banner-title').textContent = title;
  b.querySelector('.banner-text').textContent = text;
}

function updateLinkPill() {
  const pill = $('linkStatus');
  const txt = pill.querySelector('.txt');
  const stale = state.source && state.lastArrival && performance.now() - state.lastArrival > STALE_AFTER_MS;
  if (!state.source) { pill.dataset.state = 'off'; txt.textContent = 'Not connected'; }
  else if (stale) { pill.dataset.state = 'stale'; txt.textContent = 'Waiting for data'; }
  else if (state.source === 'demo') { pill.dataset.state = 'demo'; txt.textContent = 'Demo data'; }
  else { pill.dataset.state = state.lastArrival ? 'live' : 'stale'; txt.textContent = state.lastArrival ? 'Live · USB' : 'Connected, waiting'; }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------
function beginSession(source) {
  state.source = source;
  state.sessionStart = performance.now();
  state.samples = [];
  state.intervals = [];
  state.lastArrival = 0;
  state.latest = null;
  state.lastMessage = '';
  state.events = [];
  state.startedAt = new Date();
  resetReadouts();
  $('deviceMsg').textContent = source === 'demo' ? 'Starting demo…' : 'Connected. Waiting for the tunnel…';
  syncButtons();
}

function endSession(reason, showReport = true) {
  if (state.recording) stopRecording();
  // End of the tunnel's run: produce the session report automatically.
  if (showReport && state.samples.length) openReport(true);
  state.source = null;
  state.serial = null;
  state.sim = null;
  if (reason) $('deviceMsg').textContent = reason;
  syncButtons();
  updateBanner();
  updateLinkPill();
}

async function connectSerial() {
  const serial = new SerialSource({
    onLine: handleLine,
    onClose: (reason) => { if (state.serial === serial) endSession(reason); },
  });
  try {
    await serial.connect();
  } catch (err) {
    if (err.name !== 'NotFoundError') { // NotFoundError = user closed the port picker
      $('deviceMsg').textContent = `Could not open port: ${err.message}`;
    }
    return;
  }
  stopDemo(false);
  state.serial = serial;
  beginSession('serial');
  logConsole('--- connected at 115200 baud ---');
}

function startDemo() {
  if (state.serial) return;
  const sim = new Simulator({ onLine: handleLine, getFrontalAreaM2: frontalAreaM2 });
  state.sim = sim;
  beginSession('demo');
  logConsole('--- demo started ---');
  sim.start();
}

function stopDemo(showReport = true) {
  if (state.sim) { state.sim.stop(); endSession('Demo stopped.', showReport); }
}

async function disconnect() {
  if (state.serial) await state.serial.disconnect();
  else stopDemo();
}

function syncButtons() {
  const src = state.source;
  $('btnConnect').hidden = src === 'serial';
  $('btnConnect').disabled = !SerialSource.isSupported();
  $('btnDemo').hidden = src === 'serial';
  $('btnDemo').textContent = src === 'demo' ? 'Stop demo' : 'Run demo';
  $('btnFault').hidden = src !== 'demo';
  $('btnDisconnect').hidden = src !== 'serial';
  $('btnReportNow').hidden = !src || state.samples.length === 0;
  $('btnRecord').disabled = !src;
  $('btnExportSession').disabled = state.samples.length === 0 && !src;
}

// ---------------------------------------------------------------------------
// Recording & runs
// ---------------------------------------------------------------------------
function startRecording() {
  const name = $('inpModel').value.trim() || `Run ${store.runs.length + 1}`;
  state.recording = newRun(name, Number($('inpArea').value) || null);
  const btn = $('btnRecord');
  btn.setAttribute('aria-pressed', 'true');
  btn.querySelector('.txt').textContent = 'Stop & save';
  $('inpModel').disabled = true;
}

function stopRecording() {
  const run = state.recording;
  state.recording = null;
  const btn = $('btnRecord');
  btn.setAttribute('aria-pressed', 'false');
  btn.querySelector('.txt').textContent = 'Start recording';
  $('inpModel').disabled = false;
  if (!run || run.samples.length === 0) { $('recStatus').textContent = 'Nothing recorded.'; return; }
  const persisted = store.add(run);
  $('recStatus').textContent = persisted
    ? `Saved “${run.name}” (${run.samples.length} samples).`
    : `Saved “${run.name}” for this visit only (browser storage is full or blocked). Export it to keep it.`;
  $('inpModel').value = '';
  renderRuns();
}

function updateRecStatus() {
  const run = state.recording;
  if (!run) return;
  const n = run.samples.length;
  const dur = n ? run.samples[n - 1].t - run.samples[0].t : 0;
  $('recStatus').textContent = `Recording “${run.name}”: ${dur.toFixed(0)} s, ${n} samples`;
}

function renderRuns() {
  const tbody = $('runsTable').querySelector('tbody');
  tbody.innerHTML = '';
  $('runsEmpty').hidden = store.runs.length > 0;
  const colors = ['--series-2', '--series-3'];
  const compareIds = [...state.compare];

  for (const run of store.runs) {
    const st = runStats(run);
    const tr = document.createElement('tr');
    const checked = state.compare.has(run.id);
    const slot = compareIds.indexOf(run.id);
    const full = state.compare.size >= 2 && !checked;
    tr.innerHTML = `
      <td><label><input type="checkbox" data-act="compare" ${checked ? 'checked' : ''} ${full ? 'disabled title="Up to two runs can be compared at once"' : ''}>
        ${checked ? `<span class="swatch" style="background:var(${colors[slot]})"></span>` : ''}<span class="sr-only">Compare ${escapeHtml(run.name)}</span></label></td>
      <td>${escapeHtml(run.name)}<div class="tile-sub">${new Date(run.startedAt).toLocaleString()}${run.frontalAreaMm2 ? ` · ${run.frontalAreaMm2} mm²` : ''}</div></td>
      <td class="num">${st.duration.toFixed(0)} s</td>
      <td class="num">${st.maxAirspeed === null ? '—' : `${st.maxAirspeed.toFixed(1)} m/s`}</td>
      <td class="num">${st.peakDrag === null ? '—' : `${st.peakDrag.toFixed(3)} N`}</td>
      <td class="num">${st.peakDownforce === null || st.peakDownforce >= 0 ? '—' : `${Math.abs(st.peakDownforce).toFixed(3)} N`}</td>
      <td class="num">${fmt(st.meanCd, 3)}</td>
      <td class="num">${fmt(st.meanCl, 3)}</td>
      <td><div class="actions">
        <button class="btn small" type="button" data-act="export">CSV</button>
        <button class="btn small" type="button" data-act="delete" aria-label="Delete ${escapeHtml(run.name)}">Delete</button>
      </div></td>`;
    tr.dataset.id = run.id;
    tbody.appendChild(tr);
  }
  state.dirty = true;
}

function onRunsTableClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = el.closest('tr').dataset.id;
  const run = store.get(id);
  if (!run) return;
  const act = el.dataset.act;
  if (act === 'compare') {
    if (el.checked) state.compare.add(id); else state.compare.delete(id);
    renderRuns();
  } else if (act === 'export') {
    downloadText(`${safeFileName(run.name)}.csv`, runToCsv(run));
  } else if (act === 'delete') {
    if (!confirm(`Delete run “${run.name}”?`)) return;
    store.remove(id);
    state.compare.delete(id);
    renderRuns();
  }
}

async function importCsv(files) {
  let added = 0;
  for (const f of files) {
    const run = csvToRun(await f.text(), f.name.replace(/\.csv$/i, ''));
    if (run.samples.length) { store.add(run); added++; }
  }
  $('recStatus').textContent = added ? `Imported ${added} run${added > 1 ? 's' : ''}.` : 'No telemetry rows found in that file.';
  renderRuns();
}

function exportSession() {
  if (!state.samples.length) return;
  const run = newRun('Session', Number($('inpArea').value) || null);
  run.samples = state.samples;
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  downloadText(`wind-tunnel-session-${stamp}.csv`, runToCsv(run));
}

// ---------------------------------------------------------------------------
// End-of-session report
// ---------------------------------------------------------------------------
function openReport(ended) {
  const model = $('inpModel').value.trim();
  state.report = buildReport({
    samples: state.samples.slice(),
    events: state.events.slice(),
    meta: {
      ended,
      model,
      source: state.source === 'demo' ? 'Demo (simulated data)' : 'Wind tunnel (USB)',
      startedAt: (state.startedAt ?? new Date()).toISOString(),
      endedAt: new Date().toISOString(),
      frontalAreaMm2: Number($('inpArea').value) || null,
    },
  });
  renderReport();
  const el = $('report');
  el.hidden = false;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderReport() {
  const r = state.report;
  if (!r) return;
  const sm = r.summary;
  const start = new Date(r.meta.startedAt);
  $('reportTitle').textContent = r.meta.ended ? 'Session report' : 'Session report (so far)';
  $('reportMeta').textContent = [
    start.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }),
    `${start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–${new Date(r.meta.endedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
    r.meta.source,
    r.meta.model && `Model: ${r.meta.model}`,
    r.meta.frontalAreaMm2 && `Frontal area ${r.meta.frontalAreaMm2} mm²`,
  ].filter(Boolean).join(' · ');

  const mt = sm.modeTime;
  const stat = (value, label) => `<div class="stat"><b>${value}</b><span>${label}</span></div>`;
  $('reportSummary').innerHTML = [
    stat(fmtClock(sm.duration), 'Duration'),
    stat(sm.count.toLocaleString(), 'Readings'),
    stat(r.points.length, 'Test points'),
    stat(sm.maxAirspeed === null ? '—' : `${sm.maxAirspeed.toFixed(1)} m/s`, `Max airspeed${sm.maxAirspeed === null ? '' : ` (${(sm.maxAirspeed * 3.6).toFixed(0)} km/h)`}`),
    stat(sm.peakDrag === null ? '—' : `${sm.peakDrag.toFixed(3)} N`, 'Peak drag'),
    stat(sm.peakDownforce === null ? '—' : `${sm.peakDownforce.toFixed(3)} N`, 'Peak downforce'),
    stat(fmt(sm.meanCd, 3), 'Mean C<sub>d</sub> (Force ≥ 3 m/s)'),
    stat(fmt(sm.meanCl, 3), 'Mean C<sub>l</sub> (Force ≥ 3 m/s)'),
    stat(`${fmtClock(mt.FORCE)} / ${fmtClock(mt.SMOKE)}`, 'Time in Force / Smoke'),
    stat(sm.faults, sm.faults === 1 ? 'Fault' : 'Faults'),
  ].join('');

  $('pointsTable').querySelector('tbody').innerHTML = r.points.map((p, i) => `
    <tr><td class="num">${i + 1}</td><td>${p.mode}</td><td class="num">${fmtClock(p.start)}</td><td class="num">${p.hold.toFixed(1)} s</td>
    <td class="num">${fmt(p.airspeed_ms, 2)}</td><td class="num">${fmt(p.airspeed_ms === null ? null : p.airspeed_ms * 3.6, 1)}</td>
    <td class="num">${fmt(p.drag_N, 3)}</td><td class="num">${fmt(p.lift_N, 3)}</td>
    <td class="num">${fmt(p.Cd, 3)}</td><td class="num">${fmt(p.Cl, 3)}</td><td class="num">${p.count}</td></tr>`).join('');
  $('pointsEmpty').hidden = r.points.length > 0;

  $('eventLog').innerHTML = r.events.length
    ? r.events.map((e) => `<li><time>${fmtClock(e.t)}</time><span class="${/fault/i.test(e.text) ? 'fault' : ''}">${escapeHtml(e.text)}</span></li>`).join('')
    : '<li><span>No events recorded.</span></li>';

  renderReadings();
}

function renderReadings() {
  const r = state.report;
  if (!r) return;
  const all = $('selReadings').value === 'all';
  const rows = all ? r.samples : perSecond(r.samples);
  $('readingsTable').querySelector('tbody').innerHTML = rows.map((s) => `
    <tr><td>${fmtClock(s.t, 1)}</td><td class="mode-cell-${s.mode}">${s.mode}</td><td class="num">${fmt(s.airspeed_ms, 2)}</td>
    <td class="num">${fmt(s.drag_N, 3)}</td><td class="num">${fmt(s.lift_N, 3)}</td>
    <td class="num">${fmt(s.Cd, 3)}</td><td class="num">${fmt(s.Cl, 3)}</td></tr>`).join('');
  $('readingsNote').textContent = all
    ? `Showing all ${r.samples.length.toLocaleString()} readings.`
    : `Showing ${rows.length.toLocaleString()} of ${r.samples.length.toLocaleString()} readings (one per second). “Download all readings” saves every one.`;
}

function reportFileStem() {
  const r = state.report;
  const stamp = r.meta.startedAt.slice(0, 16).replace(/[:T]/g, '-');
  return `wind-tunnel-${r.meta.model ? `${safeFileName(r.meta.model)}-` : ''}${stamp}`;
}

// ---------------------------------------------------------------------------
// Console + table view
// ---------------------------------------------------------------------------
function logConsole(line) {
  state.consoleLines.push(line);
  if (state.consoleLines.length > 300) state.consoleLines.shift();
  state.consoleDirty = true;
}

function renderConsole() {
  if (!state.consoleDirty || !$('consoleDetails').open) return;
  const pre = $('console');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
  pre.textContent = state.consoleLines.join('\n');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
  state.consoleDirty = false;
}

function renderSampleTable() {
  const rows = state.samples.slice(-25).reverse();
  $('sampleTable').querySelector('tbody').innerHTML = rows.map((s) => `
    <tr><td>${s.timestamp}</td><td>${s.mode}</td><td class="num">${fmt(s.airspeed_ms, 2)}</td>
    <td class="num">${fmt(s.drag_N, 3)}</td><td class="num">${fmt(s.lift_N, 3)}</td>
    <td class="num">${fmt(s.Cd, 3)}</td><td class="num">${fmt(s.Cl, 3)}</td></tr>`).join('');
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------
function effectiveDark() {
  const forced = document.documentElement.dataset.theme;
  if (forced) return forced === 'dark';
  return matchMedia('(prefers-color-scheme: dark)').matches;
}
function toggleTheme() {
  const next = effectiveDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  pref.set('theme', next);
  charts.applyTheme();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
function init() {
  const savedTheme = pref.get('theme', '');
  if (savedTheme) document.documentElement.dataset.theme = savedTheme;

  if (typeof Chart === 'undefined') {
    document.querySelector('.charts').innerHTML = '<p class="note">Charts could not load (Chart.js CDN unreachable). Check your internet connection and refresh.</p>';
  } else {
    charts = new Dashboard({
      forceCanvas: $('forceChart'),
      airspeedCanvas: $('airspeedChart'),
      scatterCanvas: $('scatterChart'),
    });
  }

  $('inpArea').value = pref.get('area', DEFAULT_FRONTAL_AREA_MM2);
  $('selWindow').value = pref.get('window', '60');
  if (!SerialSource.isSupported()) $('serialNote').hidden = false;

  $('btnConnect').addEventListener('click', connectSerial);
  $('btnDemo').addEventListener('click', () => (state.source === 'demo' ? stopDemo() : startDemo()));
  $('btnFault').addEventListener('click', () => state.sim?.triggerFault());
  $('btnDisconnect').addEventListener('click', disconnect);
  $('btnReportNow').addEventListener('click', () => openReport(false));
  $('btnReportClose').addEventListener('click', () => { $('report').hidden = true; });
  $('btnReportPoints').addEventListener('click', () => state.report && downloadText(`${reportFileStem()}-test-points.csv`, testPointsCsv(state.report)));
  $('btnReportAll').addEventListener('click', () => state.report && downloadText(`${reportFileStem()}-readings.csv`, readingsCsv(state.report)));
  $('btnReportPrint').addEventListener('click', () => window.print());
  $('selReadings').addEventListener('change', renderReadings);
  $('btnTheme').addEventListener('click', toggleTheme);
  $('btnPause').addEventListener('click', (e) => {
    state.paused = !state.paused;
    e.currentTarget.setAttribute('aria-pressed', String(state.paused));
    e.currentTarget.textContent = state.paused ? 'Resume charts' : 'Pause charts';
    state.dirty = true;
  });
  $('selWindow').addEventListener('change', (e) => { pref.set('window', e.target.value); state.dirty = true; });
  $('inpArea').addEventListener('change', (e) => pref.set('area', e.target.value));
  $('btnRecord').addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));
  $('inpModel').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !state.recording && state.source) startRecording(); });
  $('runsTable').addEventListener('change', onRunsTableClick);
  $('runsTable').addEventListener('click', (e) => { if (e.target.closest('button[data-act]')) onRunsTableClick(e); });
  $('inpImport').addEventListener('change', (e) => { importCsv([...e.target.files]); e.target.value = ''; });
  $('btnExportSession').addEventListener('click', exportSession);
  $('tableDetails').addEventListener('toggle', (e) => { state.tableOpen = e.target.open; if (state.tableOpen) renderSampleTable(); });
  $('consoleDetails').addEventListener('toggle', () => { state.consoleDirty = true; renderConsole(); });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => charts?.applyTheme());
  window.addEventListener('beforeunload', (e) => { if (state.recording) { e.preventDefault(); e.returnValue = ''; } });

  // Chart redraw at ~10 fps, independent of how fast data arrives.
  setInterval(() => {
    if (charts && state.dirty && !state.paused) {
      const compare = [...state.compare].map((id) => store.get(id)).filter(Boolean);
      charts.render(state.samples, Number($('selWindow').value), compare);
      state.dirty = false;
    }
    renderConsole();
    updateRecStatus();
  }, 100);

  // Link health check.
  setInterval(() => { updateLinkPill(); updateBanner(); syncButtons(); }, 500);

  syncButtons();
  renderRuns();

  // ?demo in the URL starts the simulator straight away (handy for sharing).
  if (new URLSearchParams(location.search).has('demo')) startDemo();
}

init();
