import { BAUD_RATE } from './config.js';
import { LineSplitter } from './parser.js';

/**
 * Reads the tunnel's USB serial stream directly in the browser using the
 * Web Serial API (Chrome / Edge on desktop, served over HTTPS or localhost —
 * GitHub Pages satisfies this).
 */
export class SerialSource {
  constructor({ onLine, onClose }) {
    this.onLine = onLine;
    this.onClose = onClose;
    this.port = null;
    this.reader = null;
    this.closedPromise = null;
    this._onDisconnect = (e) => {
      if (e.target === this.port) this._teardown('Device unplugged');
    };
  }

  static isSupported() {
    return 'serial' in navigator;
  }

  async connect() {
    this.port = await navigator.serial.requestPort();
    await this.port.open({ baudRate: BAUD_RATE });
    navigator.serial.addEventListener('disconnect', this._onDisconnect);
    this._readLoop();
  }

  async _readLoop() {
    const splitter = new LineSplitter(this.onLine);
    const decoder = new TextDecoderStream();
    this.closedPromise = this.port.readable.pipeTo(decoder.writable).catch(() => {});
    this.reader = decoder.readable.getReader();
    let reason = 'Disconnected';
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value) splitter.push(value);
      }
    } catch (err) {
      reason = `Serial error: ${err.message}`;
    } finally {
      try { this.reader.releaseLock(); } catch { /* already released */ }
    }
    this._teardown(reason);
  }

  async disconnect() {
    if (!this.port) return;
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { await this.closedPromise; } catch { /* ignore */ }
    this._teardown('Disconnected');
  }

  async _teardown(reason) {
    if (!this.port) return;
    const port = this.port;
    this.port = null;
    navigator.serial.removeEventListener('disconnect', this._onDisconnect);
    try { await this.reader?.cancel(); } catch { /* ignore */ }
    try { await this.closedPromise; } catch { /* ignore */ }
    try { await port.close(); } catch { /* may already be closed */ }
    this.onClose?.(reason);
  }
}
