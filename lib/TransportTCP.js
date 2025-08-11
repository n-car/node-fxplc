// TransportTCP.js - TCP transport implementation using BufferAccumulator for framed reads.
import net from 'net';
import { NotConnectedError, NoResponseError } from './errors.js';
import { BufferAccumulator } from './transport-buffer.js';

export class TransportTCP {
  /**
   * @param {object} opts
   * @param {string} opts.host PLC gateway / adapter host
   * @param {number} opts.port TCP port
   * @param {number} [opts.timeout=1000] Per-operation read timeout (ms)
   * @param {number} [opts.flushDelay=1000] Delay after connect before enabling reads (allow device flush)
   */
  constructor({ host, port, timeout = 1000, flushDelay = 1000 }) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.flushDelay = flushDelay;
    this._socket = null;
    this._connecting = null;
    this._reconnect = false;
    this._reconnectDelay = 1000;
    this._bufferAcc = new BufferAccumulator();
  }

  /** Enable / disable simple reconnect loop */
  setReconnect(enabled, delayMs = 1000) { this._reconnect = enabled; this._reconnectDelay = delayMs; }

  /** Establish connection (idempotent) */
  async connect() {
    if (this._socket) return;
    if (this._connecting) return this._connecting;
    this._connecting = new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      let done = false;
      const fail = (e) => { if (done) return; done = true; s.destroy(); this._socket = null; this._connecting = null; reject(e); };
      s.once('error', fail);
      s.setTimeout(this.timeout, () => fail(new NoResponseError('Connect timeout')));
      s.once('connect', () => {
        setTimeout(() => {
          s.setTimeout(0);
            s.off('error', fail);
            s.on('data', d => this._onData(d));
            s.on('close', () => { if (this._reconnect) { this._socket = null; setTimeout(() => this.connect().catch(() => {}), this._reconnectDelay); } });
            this._socket = s;
            this._connecting = null;
            done = true;
            resolve();
        }, this.flushDelay);
      });
    });
    return this._connecting;
  }

  _onData(d) { this._bufferAcc.push(d); }

  async _ensure() { if (!this._socket) await this.connect(); }

  /** Write raw frame bytes */
  async write(data) { await this._ensure(); if (!this._socket) throw new NotConnectedError(); this._socket.write(data); }

  /** Read exact byte count (delegates to accumulator) */
  async read(size) { await this._ensure(); try { return await this._bufferAcc.read(size, this.timeout); } catch { throw new NoResponseError(); } }

  /** Close socket and reject pending reads */
  close() { if (this._socket) { this._socket.destroy(); this._socket = null; } this._bufferAcc.close(); this._connecting = null; }
}

