// TransportSerial.js - Serial transport implementation using BufferAccumulator.
import { NoResponseError, NotConnectedError, ResponseMalformedError } from './errors.js';
import { BufferAccumulator } from './transport-buffer.js';

export class TransportSerial {
  /**
   * @param {object} opts
   * @param {string} opts.path Serial device path (e.g. COM3, /dev/ttyUSB0)
   * @param {number} [opts.baudRate=9600] Baud rate
   * @param {number} [opts.timeout=1000] Read timeout in ms
   */
  constructor({ path, baudRate = 9600, timeout = 1000 }) {
    this.path = path;
    this.baudRate = baudRate;
    this.timeout = timeout;
    this._opened = false;
    this._port = null;
    this._bufferAcc = new BufferAccumulator();
  }

  /** Buffered input available to the protocol client without consuming it. */
  get availableBytes() { return this._bufferAcc.availableBytes; }

  /** Lazily open the serial port */
  async _ensureOpen() {
    if (this._opened) return;
    let SerialPort;
    try { ({ SerialPort } = await import('serialport')); } catch { throw new Error("Dipendenza 'serialport' non installata o non disponibile"); }
    await new Promise((resolve, reject) => {
      const port = new SerialPort({
        path: this.path,
        baudRate: this.baudRate,
        dataBits: 7,
        stopBits: 1,
        parity: 'even',
        autoOpen: true,
        lock: false,
      }, err => { if (err) return reject(err); resolve(); });
      this._port = port;
      port.on('data', d => this._bufferAcc.push(d));
      port.on('error', () => this.close());
      port.on('close', () => this._bufferAcc.close());
    });
    this._opened = true;
  }

  /** Write a frame only when there is no unexplained buffered input. */
  async write(data) {
    await this._ensureOpen();
    if (!this._port) throw new NotConnectedError();
    if (this.availableBytes !== 0) throw new ResponseMalformedError('Unsolicited input before transmission');
    await new Promise((resolve, reject) => this._port.write(data, err => err ? reject(err) : resolve()));
  }

  /** Read bytes from buffer accumulator */
  async read(size) {
    await this._ensureOpen();
    if (!this._port) throw new NotConnectedError();
    try { return await this._bufferAcc.read(size, this.timeout); } catch { throw new NoResponseError(); }
  }

  /** Close port (idempotent) */
  close() {
    if (this._port) { try { this._port.close(); } catch { /*noop*/ } this._port = null; }
    this._opened = false;
    this._bufferAcc.close();
  }
}
