// TransportSerial.js - one port lifetime; faults require a new transport.
import { NoResponseError, NotConnectedError, ResponseMalformedError } from './errors.js';
import { BufferAccumulator } from './transport-buffer.js';

export class TransportSerial {
  constructor({ path, baudRate = 9600, timeout = 1000 }) {
    this.path = path;
    this.baudRate = baudRate;
    this.timeout = timeout;
    this._opened = false;
    this._closed = false;
    this._port = null;
    this._opening = null;
    this._cancelOpen = null;
    this._openTimer = null;
    this._writeRejectors = new Set();
    this._bufferAcc = new BufferAccumulator();
  }

  get availableBytes() { return this._bufferAcc.availableBytes; }

  // Internal test seam: tests supply a fake module without loading serialport.
  _loadSerialPort() { return import('serialport'); }

  _assertUsable() {
    if (this._closed) throw new NotConnectedError('Transport closed; create a new clean transport');
  }

  async _ensureOpen() {
    this._assertUsable();
    if (this._opened) return;
    if (this._opening) return this._opening;
    let resolveOpen;
    let rejectOpen;
    this._opening = new Promise((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
    const opening = this._opening;
    this._cancelOpen = rejectOpen;
    this._openTimer = setTimeout(() => this._invalidate(new NoResponseError('Serial open timeout')), this.timeout);
    // The asynchronous loader handles its own failures. Closing cancels the
    // shared promise immediately; a late import must never create a port.
    (async () => {
      try {
        const { SerialPort } = await this._loadSerialPort();
        this._assertUsable();
        const port = new SerialPort({
          path: this.path, baudRate: this.baudRate, dataBits: 7,
          stopBits: 1, parity: 'even', autoOpen: false, lock: false,
        });
        this._port = port;
        port.on('data', data => {
          if (!this._closed && port === this._port) this._bufferAcc.push(data);
        });
        port.on('error', error => this._invalidate(error));
        port.on('close', () => this._invalidate(new NotConnectedError('Serial port closed')));
        this._assertUsable();
        port.open(error => {
          // Some native opens cannot be cancelled while in progress. Dispose
          // a handle that opens after cancellation instead of reviving it.
          if (this._closed || port !== this._port) { this._closePort(port); return; }
          if (error) { this._invalidate(error); return; }
          clearTimeout(this._openTimer);
          this._openTimer = null;
          this._opened = true;
          this._opening = null;
          this._cancelOpen = null;
          resolveOpen();
        });
      } catch (error) {
        this._invalidate(error);
      }
    })();
    return opening;
  }

  async write(data) {
    await this._ensureOpen();
    this._assertUsable();
    const port = this._port;
    if (!port) throw new NotConnectedError();
    if (this.availableBytes !== 0) throw new ResponseMalformedError('Unsolicited input before transmission');
    await new Promise((resolve, reject) => {
      this._writeRejectors.add(reject);
      const completed = error => {
        this._writeRejectors.delete(reject);
        if (error) { this._invalidate(error); reject(error); }
        else if (this._closed || port !== this._port) reject(new NotConnectedError('Transport closed'));
        else resolve();
      };
      try { this._assertUsable(); port.write(data, completed); }
      catch (error) { completed(error); }
    });
    this._assertUsable();
  }

  async read(size) {
    await this._ensureOpen();
    this._assertUsable();
    try {
      const result = await this._bufferAcc.read(size, this.timeout);
      this._assertUsable();
      return result;
    } catch (error) {
      const failure = error instanceof NotConnectedError ? error : new NoResponseError();
      this._invalidate(failure);
      throw failure;
    }
  }

  _closePort(port) {
    // A callback consumes close errors, including 'not open' while a native
    // open is still pending. Its late completion invokes this helper again.
    try { port.close(() => {}); } catch { /* already unavailable */ }
  }

  _invalidate(error) {
    if (this._closed) return;
    this._closed = true;
    this._opened = false;
    clearTimeout(this._openTimer);
    this._openTimer = null;
    const cancel = this._cancelOpen;
    this._cancelOpen = null;
    this._opening = null;
    if (cancel) cancel(error);
    for (const reject of this._writeRejectors) reject(error);
    this._writeRejectors.clear();
    this._bufferAcc.close(error);
    const port = this._port;
    this._port = null;
    if (port) this._closePort(port);
  }

  /** Terminal and idempotent, including while import/open/write is pending. */
  close() { this._invalidate(new NotConnectedError('Transport closed')); }
}
