import { FIELDS, MODES, AIR_DENSITY } from './config.js';

/**
 * Parse one line of serial output from the tunnel.
 *
 * Returns one of:
 *   { type: 'sample', timestamp, mode, airspeed_ms, drag_N, lift_N, Cd, Cl }
 *   { type: 'message', text }   – status text such as "SELF-CHECK PASS"
 *   { type: 'header' }          – the CSV header row
 *   null                        – blank line
 *
 * Telemetry follows SW-04: timestamp,mode,airspeed_ms,drag_N,lift_N,Cd,Cl
 * Lines starting with '#' are treated as human-readable status messages
 * (for example the REQ-012 "tare / self-check in progress" message).
 */
export function parseLine(raw) {
  const line = String(raw).trim();
  if (!line) return null;

  if (line.startsWith('#')) {
    return { type: 'message', text: line.replace(/^#\s*/, '') };
  }

  const parts = line.split(',').map((s) => s.trim());
  if (parts.length < FIELDS.length) return { type: 'message', text: line };

  if (parts[0].toLowerCase() === 'timestamp') return { type: 'header' };

  const num = (i) => {
    if (parts[i] === '' || parts[i] === undefined) return null;
    const v = Number(parts[i]);
    return Number.isFinite(v) ? v : null;
  };

  const timestamp = num(0);
  const mode = parts[1].toUpperCase();
  if (timestamp === null || !MODES.includes(mode)) {
    return { type: 'message', text: line };
  }

  return {
    type: 'sample',
    timestamp,
    mode,
    airspeed_ms: num(2),
    drag_N: num(3),
    lift_N: num(4),
    Cd: num(5),
    Cl: num(6),
  };
}

/** Accumulates arbitrary text chunks and emits whole lines. */
export class LineSplitter {
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = '';
  }
  push(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop();
    // Guard against a device that never sends a newline.
    if (this.buffer.length > 2000) this.buffer = '';
    for (const l of lines) this.onLine(l);
  }
}

/**
 * Aerodynamic coefficient from a force: C = F / (0.5 · rho · v² · A)
 * Returns null when the airspeed is too low to give a meaningful value.
 */
export function coefficient(forceN, airspeedMs, areaM2, minSpeed = 0.5) {
  if (forceN === null || airspeedMs === null || !areaM2) return null;
  if (airspeedMs < minSpeed) return null;
  const q = 0.5 * AIR_DENSITY * airspeedMs * airspeedMs;
  return forceN / (q * areaM2);
}
