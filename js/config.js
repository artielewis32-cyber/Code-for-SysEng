// Central configuration — values traced to the Systems Engineering Workbook.
// Change them here rather than in the rest of the code.

// SW-04: CSV field order streamed by the firmware over USB serial.
export const FIELDS = ['timestamp', 'mode', 'airspeed_ms', 'drag_N', 'lift_N', 'Cd', 'Cl'];

// REQ-022: USB serial baud rate.
export const BAUD_RATE = 115200;

// SW-08: fixed air density used in the Cd / Cl calculation (kg/m^3).
export const AIR_DENSITY = 1.225;

// Glossary – Coding: operating modes (enum).
export const MODES = ['SMOKE', 'FORCE', 'IDLE', 'FAULT'];

// Glossary – Coding / Performance Specs: measurement ranges.
export const RANGES = {
  airspeed_ms: [0, 25],
  drag_N: [0, 2],
  lift_N: [-2, 2],
};

// REQ-002: Smoke Mode airflow band (m/s).
export const SMOKE_BAND_MS = [1.0, 3.0];

// REQ-006: smoke injection must be disabled above this airspeed (m/s).
export const SMOKE_CUTOFF_MS = 4.0;

// REQ-003: Force Mode maximum airspeed, 80 km/h expressed in m/s.
export const FORCE_MAX_MS = 80 / 3.6;

// REQ-016 / REQ-017: displayed telemetry must update at 1 s or faster.
export const UPDATE_LIMIT_MS = 1000;

// No data for this long => the link is flagged as stale.
export const STALE_AFTER_MS = 2000;

// REQ-018 / REQ-019: Cd/Cl must match a reference calculation within ±5 %.
export const COEFF_TOLERANCE = 0.05;

// Below this airspeed the dynamic pressure is too small for a meaningful
// coefficient, so the web-side cross-check is not computed.
export const MIN_SPEED_FOR_COEFF_MS = 3.0;

// Default model frontal area (mm^2). SW-09 requires an operator-entered value.
export const DEFAULT_FRONTAL_AREA_MM2 = 4000;

// Session memory cap: 1 hour at 10 Hz.
export const MAX_SESSION_SAMPLES = 36000;
