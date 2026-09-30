import { AIR_DENSITY, FORCE_MAX_MS } from './config.js';

/**
 * Demo source: behaves like the tunnel firmware and emits the same serial
 * lines (SW-04 CSV records plus '#' status messages), so the whole dashboard
 * can be exercised with no hardware attached.
 *
 * Sequence (per the ConOps / SW-01):
 *   Boot → Self-check + auto-tare → Idle → Smoke mode → Idle → Force-mode
 *   speed sweep → Idle → (repeat with a different "model")
 */
const TICK_MS = 100; // 10 Hz, comfortably inside the ≤1 s update requirement
const RAMP_S = 3.5;  // REQ-005: speed changes ramp over ≥3 s

const gauss = () => {
  // Box–Muller
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export class Simulator {
  constructor({ onLine, getFrontalAreaM2 }) {
    this.onLine = onLine;
    this.getArea = getFrontalAreaM2;
    this.timer = null;
  }

  start() {
    this.t0 = performance.now();
    this.airspeed = 0;
    this.setpoint = 0;
    this.rampRate = 0;
    this.phaseQueue = [];
    this.phase = null;
    this.phaseElapsed = 0;
    this.newModel();
    this.queueBoot();
    this.onLine('timestamp,mode,airspeed_ms,drag_N,lift_N,Cd,Cl');
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  get running() {
    return this.timer !== null;
  }

  /** Simulate a lid-interlock sensor fault (REQ-027/028/029). */
  triggerFault() {
    if (!this.running) return;
    this.phaseQueue = [];
    this.startPhase({ mode: 'FAULT', dur: 8, setpoint: 0, instant: true,
      msg: 'FAULT: lid interlock signal invalid - fan held off. Check lid sensor wiring.' });
    this.phaseQueue.push({ mode: 'BOOT', dur: 1, msg: 'Fault cleared - restarting' });
    this.queueBoot(false);
  }

  newModel() {
    // Each loop tests a different "car" so saved runs have something to compare.
    this.trueCd = 0.28 + Math.random() * 0.25;
    this.trueCl = -(0.15 + Math.random() * 0.35); // negative = downforce
    this.tareOffsetDrag = (Math.random() - 0.5) * 0.3; // raw offset removed by tare
    this.tareOffsetLift = (Math.random() - 0.5) * 0.3;
    this.tared = false;
  }

  queueBoot(includeFirstBoot = true) {
    if (includeFirstBoot) this.phaseQueue.push({ mode: 'BOOT', dur: 1.5, msg: 'BOOT: wind tunnel firmware v1.0' });
    this.phaseQueue.push(
      { mode: 'SELFCHECK', dur: 3, msg: 'SELF-CHECK: taring force sensors, please wait...' },
      { mode: 'SELFCHECK_DONE', dur: 0.1, msg: 'SELF-CHECK PASS: drag cell OK, lift cell OK, airspeed OK', tare: true },
    );
    this.queueCycle();
  }

  /** One test cycle: idle → smoke → idle → force sweep → idle. */
  queueCycle() {
    this.phaseQueue.push(
      { mode: 'IDLE', dur: 3, setpoint: 0 },
      { mode: 'SMOKE', dur: 14, setpoint: 2.0, msg: 'Mode: SMOKE (auto-tare complete)', tare: true },
      { mode: 'IDLE', dur: 5, setpoint: 0 },
      { mode: 'FORCE', dur: 1, setpoint: 0, msg: 'Mode: FORCE (auto-tare complete)', tare: true },
    );
    for (const sp of [6, 11, 16, FORCE_MAX_MS, 16, 9]) {
      this.phaseQueue.push({ mode: 'FORCE', dur: 7, setpoint: sp });
    }
    this.phaseQueue.push(
      { mode: 'FORCE', dur: 5, setpoint: 0 },
      { mode: 'IDLE', dur: 5, setpoint: 0, msg: 'Mode: IDLE', nextModel: true },
    );
  }

  startPhase(p) {
    this.phase = p;
    this.phaseElapsed = 0;
    if (p.msg) this.onLine(`# ${p.msg}`);
    if (p.tare) this.tared = true;
    if (p.setpoint !== undefined) {
      this.setpoint = p.setpoint;
      this.rampRate = p.instant ? Infinity : Math.max(Math.abs(this.setpoint - this.airspeed) / RAMP_S, 0.01);
    }
  }

  tick() {
    const dt = TICK_MS / 1000;
    if (!this.phase || this.phaseElapsed >= this.phase.dur) {
      if (this.phase?.nextModel) this.newModel();
      if (this.phaseQueue.length === 0) this.queueCycle();
      this.startPhase(this.phaseQueue.shift());
    }
    this.phaseElapsed += dt;

    // Linear ramp toward the setpoint; a fault drops the fan almost instantly.
    const diff = this.setpoint - this.airspeed;
    const step = this.rampRate === Infinity ? Math.sign(diff) * 3 : this.rampRate * dt;
    this.airspeed = Math.abs(diff) <= Math.abs(step) ? this.setpoint : this.airspeed + Math.sign(diff) * Math.abs(step);

    const mode = this.phase.mode;
    if (mode === 'BOOT' || mode === 'SELFCHECK' || mode === 'SELFCHECK_DONE') return; // no telemetry yet

    const v = Math.max(0, this.airspeed + (this.airspeed > 0.2 ? gauss() * 0.06 : 0));
    const area = this.getArea();
    const q = 0.5 * AIR_DENSITY * this.airspeed * this.airspeed;
    const offD = this.tared ? 0 : this.tareOffsetDrag;
    const offL = this.tared ? 0 : this.tareOffsetLift;
    const drag = q * area * this.trueCd + offD + gauss() * 0.006;
    const lift = q * area * this.trueCl + offL + gauss() * 0.006;

    // Firmware computes coefficients only when there is enough dynamic pressure.
    const qm = 0.5 * AIR_DENSITY * v * v;
    const hasCoeff = mode === 'FORCE' && v >= 3;
    const Cd = hasCoeff ? drag / (qm * area) : null;
    const Cl = hasCoeff ? lift / (qm * area) : null;

    const ts = Math.round(performance.now() - this.t0);
    const f = (x, d) => (x === null ? '' : x.toFixed(d));
    this.onLine(`${ts},${mode},${f(v, 2)},${f(drag, 3)},${f(lift, 3)},${f(Cd, 3)},${f(Cl, 3)}`);
  }
}
