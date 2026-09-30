# Wind Tunnel Telemetry

A live web dashboard for the **desktop wind tunnel**. It shows drag, lift/downforce, airspeed, C<sub>d</sub> and C<sub>l</sub> on real-time charts, read straight from the tunnel's Arduino over USB. It runs entirely in the browser, so it can be hosted for free on **GitHub Pages**. There's no server or install.

## Features

| Feature | What it does | Traces to |
|---|---|---|
| **Direct USB connection** | Reads the Arduino's serial output at 115200 baud using the browser's Web Serial API | REQ-022, INT-07 |
| **Live readouts** | Mode, airspeed (m/s and km/h), drag, lift/downforce, C<sub>d</sub>, C<sub>l</sub> | REQ-016/017/020/021, F1-12/13 |
| **Real-time charts** | Drag & lift vs time, airspeed vs time (with the 1–3 m/s smoke band, the 4 m/s smoke cut-off and the 80 km/h max marked), and drag vs airspeed | SN-02, ConOps Scenario B |
| **Update-rate check** | Measures how often telemetry arrives and flags whether it meets the ≤ 1 s requirement | REQ-016, REQ-017 |
| **C<sub>d</sub>/C<sub>l</sub> cross-check** | Recomputes the coefficients from force, airspeed and the entered frontal area (ρ = 1.225 kg/m³) and shows the % difference from the tunnel's value (±5 % pass) | REQ-018/019, SW-08/09 |
| **Fault & status display** | Shows the tunnel's status messages (self-check, tare) and a red banner in FAULT mode. Also warns if the link goes quiet or if smoke mode exceeds 4 m/s | REQ-012/014/028, REQ-006 |
| **Test runs** | Record a run per model, then compare peak drag, peak downforce and mean C<sub>d</sub>/C<sub>l</sub>. Overlay up to two runs on the drag-vs-airspeed chart | ConOps Scenario A |
| **CSV export/import** | Export a run or the whole session for analysis or CFD comparison, and import CSVs back in | SN-08, F1-14 |
| **Demo mode** | Built-in simulator that behaves like the tunnel, so the site works with no hardware attached | — |
| Light/dark theme, phone layout, table view, raw serial console | | |

## Serial data format (what the Arduino must send)

The dashboard expects the format in **SW-04**, one record per line at **115200 baud**:

```
timestamp,mode,airspeed_ms,drag_N,lift_N,Cd,Cl
48213,FORCE,15.20,0.312,-0.198,0.557,-0.354
48313,IDLE,0.00,0.001,-0.002,,
```

- `timestamp`: `millis()` from the Arduino
- `mode`: `SMOKE`, `FORCE`, `IDLE` or `FAULT` (Glossary – Coding)
- `airspeed_ms` in m/s, `drag_N` and `lift_N` in newtons (negative lift = downforce)
- `Cd`, `Cl`: leave the fields **empty** when there is no valid value (e.g. airspeed too low)
- A header line is optional and gets ignored.
- **Status messages:** any line starting with `#` is shown to the operator, e.g. `# SELF-CHECK: taring force sensors...` or `# FAULT: lid interlock signal invalid`.
- Send at least once per second. 10 Hz is recommended.

A minimal Arduino sketch showing exactly this output is in [`firmware/serial_output_example`](firmware/serial_output_example/serial_output_example.ino).

## Putting it on GitHub Pages

1. Create a new repository on GitHub (e.g. `wind-tunnel-dashboard`).
2. Upload everything in this folder (keep the folder structure), or:
   ```bash
   git init
   git add .
   git commit -m "Wind tunnel telemetry dashboard"
   git branch -M main
   git remote add origin https://github.com/<your-username>/wind-tunnel-dashboard.git
   git push -u origin main
   ```
3. On GitHub go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, then select **main** and **/ (root)**, and click **Save**.
4. After a minute or so the site will be live at `https://<your-username>.github.io/wind-tunnel-dashboard/`.
   Add `?demo` to the end of the URL to open it with the simulator already running.

## Using it

1. Plug the tunnel into the laptop with a USB cable.
2. Open the site in **Chrome or Edge** on a desktop or laptop. Web Serial isn't supported in Firefox, Safari or on phones, though demo mode and CSV import work everywhere.
3. Click **Connect tunnel (USB)** and pick the Arduino's port (usually "USB Serial" or "Arduino Uno"). Note that opening the port usually resets an Uno, so you'll see the boot and self-check messages come through.
4. Enter the model's **frontal area** in mm². Use the same value that's entered on the tunnel.
5. Type a **model name** and press **Start recording**. Run the test, then press **Stop & save**.
6. Repeat for other models. Tick up to two runs to overlay them on the drag-vs-airspeed chart, or export CSVs.

> The Arduino IDE's Serial Monitor and the dashboard can't use the port at the same time. Close the Serial Monitor first.

Saved runs are kept in that browser's local storage. Export them as CSV if you need to keep them or move them to another computer.

## Running locally

The site uses JavaScript modules, so it has to be served over HTTP rather than opened as a file:

```bash
python -m http.server 8000
# then open http://localhost:8000
```

Web Serial works on `localhost` as well as on HTTPS (which GitHub Pages provides).

## Project structure

```
index.html                 Page layout
css/styles.css             Styles, light & dark theme tokens
js/config.js               Constants from the requirements (field order, baud rate, ranges, limits)
js/parser.js               Serial line parser + coefficient formula
js/serial.js               Web Serial connection
js/simulator.js            Demo-mode tunnel simulator
js/charts.js               Real-time charts (Chart.js)
js/runs.js                 Run recording, statistics, CSV import/export
js/app.js                  Wires it all together
firmware/                  Example Arduino serial output
sample-data/               Example run CSV (demo data) you can import
```

To change a limit or unit (for example once the TBD values in the requirement set are settled), edit `js/config.js`.

## Notes

- Results are indicative, not certified (CON-04). Accuracy is limited by the low-cost sensors (CON-05).
- `sample-data/example_run.csv` is **simulated** data for trying the import and comparison features. It isn't a real measurement.
- Charts use [Chart.js](https://www.chartjs.org/) 4.4.1, loaded from the jsDelivr CDN.
