import assert from 'node:assert/strict';
import { FXPLCClient, NumberType, ProgramProfile } from '../../lib/index.js';

// Independent byte-level peer. No serial/TCP transport, production decoder or library
// framing helper is used to construct responses or interpret requests here.
const EXTENDED = ProgramProfile.Fx3uExtended8KReadOnly;
const hex = bytes => Buffer.from(bytes).toString('hex').toUpperCase();
const checksum = bytes => bytes.reduce((sum, byte) => (sum + byte) & 255, 0)
  .toString(16).toUpperCase().padStart(2, '0');
function dataFrame(bytes) {
  const body = Buffer.from(`${hex(bytes)}\x03`, 'ascii');
  return Buffer.concat([Buffer.from([2]), body, Buffer.from(checksum(body), 'ascii')]);
}
function parseRequest(frame) {
  assert.equal(frame[0], 2);
  assert.equal(frame.at(-3), 3);
  assert.equal(frame.subarray(-2).toString('ascii'), checksum(frame.subarray(1, -2)));
  const extended = frame.subarray(1, 3).toString('ascii') === 'E0';
  const command = extended ? 'E0' : frame.subarray(1, 2).toString('ascii');
  assert.ok(['0', '1', 'E0'].includes(command), `unexpected mutation/command ${command}`);
  const start = extended ? 3 : 2;
  const end = extended ? 8 : 6;
  const addressText = frame.subarray(start, end).toString('ascii');
  const countText = frame.subarray(end, end + 2).toString('ascii');
  assert.match(addressText, extended ? /^[0-9A-F]{5}$/ : /^[0-9A-F]{4}$/);
  assert.match(countText, /^[0-9A-F]{2}$/);
  const address = Number.parseInt(addressText, 16);
  const count = Number.parseInt(countText, 16);
  assert.ok(count >= 1 && count <= 64);
  assert.ok(address + count <= (extended ? 0x100000 : 0x10000));
  const payloadText = frame.subarray(end + 2, -3).toString('ascii');
  assert.equal(payloadText.length, command === '1' ? count * 2 : 0);
  const data = Buffer.from(payloadText, 'hex');
  assert.equal(frame.length, (extended ? 13 : 11) + data.length * 2);
  return { command, address, count, data };
}

class PeerTransport {
  constructor({ extended = true, capacity = extended ? 8000 : 2000 } = {}) {
    this.extended = extended;
    this.capacity = capacity;
    this.base = extended ? 0x18000 : 0x8000;
    this.imageLength = 96 + capacity * 2;
    this.memory = Buffer.alloc(0x100000);
    this.memory.writeUInt16LE(200, 0xe00);
    this.memory.writeUInt16LE(extended ? 24241 : 20121, 0xe02);
    this.memory.writeUInt16LE(capacity / 1000, 0xe04);
    this.memory.writeUInt16LE(16, 0xe06);
    this.memory.writeUInt16LE(16241, 0xeca);
    this.memory.writeUInt16LE(capacity / 1000, 0xecc);
    this.memory[this.base] = 16;
    this.memory.fill(0x20, this.base + 8, this.base + 48);
    this.memory.write('SIMULATED NODE PLC', this.base + 16, 'ascii');
    for (let offset = 92; offset < this.imageLength; offset++)
      this.memory[this.base + offset] = (offset * 31 + 9) % 251;
    this.memory[0x1801] = 0xa0;
    this.frames = [];
    this.requests = [];
    this.readSizes = [];
    this.pending = Buffer.alloc(0);
    this.waiting = [];
    this.closed = false;
    this.beforeRequest = undefined;
    this.afterResponse = undefined;
  }
  get availableBytes() { return this.pending.length; }
  refreshMonitor() {
    if (!(this.memory[0x1801] & 1)) return;
    let result = 0x1958;
    for (let index = 0; index < this.memory[0x1800]; index++) {
      const address = this.memory.readUInt16LE(0x1802 + index * 2);
      const width = address >= 0xc00 && address <= 0xcdc ? 4 : 2;
      this.memory.copy(this.memory, result, address, address + width);
      result += width;
    }
    this.memory.fill(0, 0x19a0, 0x19b3);
    for (let index = 0; index < this.memory[0x1826]; index++) {
      const bitAddress = this.memory.readUInt16LE(0x1828 + index * 2);
      const value = (this.memory[bitAddress >>> 3] >>> (bitAddress & 7)) & 1;
      this.memory[0x19a0 + (index >>> 3)] |= value << (index & 7);
    }
  }
  async write(frame) {
    assert.equal(this.closed, false, 'a closed transport must never receive another request');
    assert.equal(this.pending.length, 0, 'a new request cannot discard unconsumed bytes');
    const request = parseRequest(frame);
    this.frames.push(Buffer.from(frame));
    this.requests.push(request);
    await this.beforeRequest?.(request, this);
    let response;
    if (request.command === '1') {
      this.memory.set(request.data, request.address);
      this.refreshMonitor();
      response = Buffer.from([6]);
    } else {
      this.refreshMonitor();
      response = dataFrame(this.memory.subarray(request.address, request.address + request.count));
    }
    const replacement = await this.afterResponse?.(request, response, this);
    if (replacement !== undefined) response = replacement;
    this.pending = Buffer.concat([this.pending, response]);
  }
  async read(size) {
    this.readSizes.push(size);
    if (this.pending.length >= size) {
      const out = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      return out;
    }
    if (this.closed) return Buffer.alloc(0);
    // Silence is a pending transport read, not an immediate malformed frame.
    return new Promise(resolve => this.waiting.push(resolve));
  }
  close() {
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) resolve(Buffer.alloc(0));
  }
  client(options = {}) {
    return new FXPLCClient(this, {
      programProfile: this.extended ? EXTENDED : ProgramProfile.Classic,
      timeoutMs: 1000,
      ...options,
    });
  }
}

const monitorConfig = () => ({
  numericRegisters: ['D0', 'C200'],
  numberTypes: [NumberType.WordSigned, NumberType.DoubleWordUnsigned],
  bitRegisters: ['X100', 'M0', 'M8000'],
  bitCountAddress: 0x1826,
  bitTableAddress: 0x1828,
});

export { EXTENDED, PeerTransport, dataFrame, parseRequest, monitorConfig };
