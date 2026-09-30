/*
 * Serial output example for the Wind Tunnel Telemetry dashboard.
 *
 * This is NOT the full tunnel firmware. It shows the exact serial format the
 * dashboard expects, so the firmware team can copy the output section.
 *
 *   - 115200 baud (REQ-022)
 *   - One CSV record per line, fields in this order (SW-04):
 *       timestamp,mode,airspeed_ms,drag_N,lift_N,Cd,Cl
 *     timestamp  = millis()
 *     mode       = SMOKE | FORCE | IDLE | FAULT
 *     Cd / Cl    = leave the field empty when not valid (e.g. airspeed too low)
 *   - Any line starting with '#' is shown to the operator as a status message
 *     (e.g. "# SELF-CHECK: taring force sensors..." for REQ-012, or
 *     "# FAULT: lid interlock signal invalid" for REQ-028).
 *   - Send at least once per second (REQ-016/017). 10 Hz works well.
 *
 * Replace the read*() stubs with your HX711 / airspeed sensor code.
 */

const float AIR_DENSITY = 1.225;          // kg/m^3 (SW-08)
float frontalAreaM2 = 0.004;              // operator-entered (SW-09)
const float MIN_SPEED_FOR_COEFF = 3.0;    // m/s

enum Mode { MODE_IDLE, MODE_SMOKE, MODE_FORCE, MODE_FAULT };
Mode mode = MODE_IDLE;

const unsigned long SEND_INTERVAL_MS = 100;  // 10 Hz
unsigned long lastSend = 0;

// ---- Replace these stubs with real sensor reads ---------------------------
float readAirspeedMs() { return 0.0; }
float readDragN()      { return 0.0; }
float readLiftN()      { return 0.0; }
// ---------------------------------------------------------------------------

const char* modeName(Mode m) {
  switch (m) {
    case MODE_SMOKE: return "SMOKE";
    case MODE_FORCE: return "FORCE";
    case MODE_FAULT: return "FAULT";
    default:         return "IDLE";
  }
}

void sendStatus(const char* msg) {
  Serial.print(F("# "));
  Serial.println(msg);
}

void setup() {
  Serial.begin(115200);
  sendStatus("BOOT: wind tunnel firmware v1.0");
  sendStatus("SELF-CHECK: taring force sensors, please wait...");
  // ... tare load cells and check each channel here (REQ-011, REQ-013) ...
  sendStatus("SELF-CHECK PASS");
  Serial.println(F("timestamp,mode,airspeed_ms,drag_N,lift_N,Cd,Cl"));
}

void loop() {
  unsigned long now = millis();
  if (now - lastSend < SEND_INTERVAL_MS) return;
  lastSend = now;

  float v    = readAirspeedMs();
  float drag = readDragN();
  float lift = readLiftN();

  Serial.print(now);            Serial.print(',');
  Serial.print(modeName(mode)); Serial.print(',');
  Serial.print(v, 2);           Serial.print(',');
  Serial.print(drag, 3);        Serial.print(',');
  Serial.print(lift, 3);        Serial.print(',');

  if (mode == MODE_FORCE && v >= MIN_SPEED_FOR_COEFF) {
    float q = 0.5 * AIR_DENSITY * v * v;
    Serial.print(drag / (q * frontalAreaM2), 3); Serial.print(',');
    Serial.println(lift / (q * frontalAreaM2), 3);
  } else {
    Serial.println(',');         // empty Cd and Cl fields
  }
}
