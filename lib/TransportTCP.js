// TransportTCP.js - one connection lifetime; faults require a new transport.
import net from 'net';
import { NotConnectedError, NoResponseError, ResponseMalformedError } from './errors.js';
import { BufferAccumulator } from './transport-buffer.js';

export class TransportTCP {
  constructor({ host, port, timeout = 1000, flushDelay = 1000 }) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.flushDelay = flushDelay;
    this._socket = null;
    this._connecting = null;
    this._cancelConnect = null;
    this._connectTimer = null;
    this._flushTimer = null;
    this._closed = false;
    this._bufferAcc = new BufferAccumulator();
  }

  get availableBytes() { return this._bufferAcc.availableBytes; }

  /** Compatibility setting only: a closed/faulted stream never reconnects. */
  setReconnect(enabled, delayMs = 1000) {
    this._reconnect = enabled;
    this._reconnectDelay = delayMs;
  }

  // Internal test seam: tests supply inert sockets and never open a network.
  _createSocket() { return net.createConnection({ host: this.host, port: this.port }); }

  _assertUsable() {
    if (this._closed) throw new NotConnectedError('Transport closed; create a new clean transport');
  }

  /** Establish the one connection allowed for this transport instance. */
  async connect() {
    this._assertUsable();
    if (this._connecting) return this._connecting;
    if (this._socket) return;
    let resolveConnect;
    let rejectConnect;
    this._connecting = new Promise((resolve, reject) => { resolveConnect = resolve; rejectConnect = reject; });
    const connecting = this._connecting;
    this._cancelConnect = rejectConnect;
    try {
      const socket = this._createSocket();
      this._socket = socket; // Retain even the pending handle so close destroys it.
      socket.on('error', error => this._invalidate(error));
      socket.on('close', () => this._invalidate(new NotConnectedError('TCP connection closed')));
      socket.once('connect', () => {
        if (this._closed || socket !== this._socket) return;
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
        this._flushTimer = setTimeout(() => {
          this._flushTimer = null;
          if (this._closed || socket !== this._socket) return;
          socket.on('data', data => {
            if (!this._closed && socket === this._socket) this._onData(data);
          });
          this._connecting = null;
          this._cancelConnect = null;
          resolveConnect();
        }, this.flushDelay);
      });
      this._connectTimer = setTimeout(() => this._invalidate(new NoResponseError('Connect timeout')), this.timeout);
    } catch (error) {
      this._invalidate(error);
    }
    return connecting;
  }

  _onData(data) { if (!this._closed) this._bufferAcc.push(data); }

  async _ensure() {
    this._assertUsable();
    if (!this._socket || this._connecting) await this.connect();
    this._assertUsable();
  }

  async write(data) {
    await this._ensure();
    this._assertUsable();
    if (!this._socket) throw new NotConnectedError();
    if (this.availableBytes !== 0) throw new ResponseMalformedError('Unsolicited input before transmission');
    try { this._socket.write(data); } catch (error) { this._invalidate(error); throw error; }
  }

  async read(size) {
    await this._ensure();
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

  _invalidate(error) {
    if (this._closed) return;
    this._closed = true;
    clearTimeout(this._connectTimer);
    clearTimeout(this._flushTimer);
    this._connectTimer = null;
    this._flushTimer = null;
    const cancel = this._cancelConnect;
    this._cancelConnect = null;
    this._connecting = null;
    if (cancel) cancel(error);
    this._bufferAcc.close(error);
    const socket = this._socket;
    this._socket = null;
    // Keep the error listener attached to consume errors emitted by destroy.
    if (socket) { try { socket.destroy(); } catch { /* already unavailable */ } }
  }

  /** Terminal and idempotent; pending connection/read continuations reject. */
  close() { this._invalidate(new NotConnectedError('Transport closed')); }
}
