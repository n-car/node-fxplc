import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { TransportTCP } from '../lib/TransportTCP.js';
import { TransportSerial } from '../lib/TransportSerial.js';
import { NotConnectedError, NoResponseError } from '../lib/errors.js';
import { FXPLCClient } from '../lib/FXPLCClient.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const turn = () => new Promise(resolve => setImmediate(resolve));
const frame = Buffer.from([2, 49, 3]);

class FakeSocket extends EventEmitter {
  constructor() { super(); this.writes = []; this.destroyCalls = 0; }
  write(data) { this.writes.push(Buffer.from(data)); }
  destroy() { this.destroyCalls++; this.emit('close'); }
}
function tcp(options = {}) {
  const sockets = [];
  class FakeTCP extends TransportTCP {
    _createSocket() { const socket = new FakeSocket(); sockets.push(socket); return socket; }
  }
  return { transport: new FakeTCP({ host: 'unused.invalid', port: 1, timeout: 100, flushDelay: 0, ...options }), sockets };
}
async function openTcp(harness) {
  const opening = harness.transport.connect();
  harness.sockets[0].emit('connect');
  await opening;
}
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function serial({ pendingImport = false, timeout = 100 } = {}) {
  const ports = [];
  const load = deferred();
  let loads = 0;
  class FakePort extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.writes = []; this.closeCalls = 0;
      this.isOpen = false; this.holdWrites = false; ports.push(this);
    }
    open(callback) { this.openCallback = callback; }
    finishOpen(error) { this.isOpen = !error; this.openCallback(error); }
    write(data, callback) {
      this.writes.push(Buffer.from(data));
      if (this.holdWrites) this.writeCallback = callback;
      else callback();
    }
    close(callback) {
      this.closeCalls++;
      if (this.isOpen) { this.isOpen = false; this.emit('close'); callback(); }
      else callback(new Error('not open'));
    }
  }
  class FakeSerial extends TransportSerial {
    _loadSerialPort() { loads++; return load.promise; }
  }
  const module = { SerialPort: FakePort };
  if (!pendingImport) load.resolve(module);
  return { transport: new FakeSerial({ path: 'unused', timeout }), ports, load, module, loads: () => loads };
}
async function openSerial(harness) {
  const opening = harness.transport._ensureOpen();
  await turn();
  harness.ports[0].finishOpen();
  await opening;
}
async function terminal(transport) {
  await assert.rejects(transport.write(frame), NotConnectedError);
  await assert.rejects(transport.read(1), NotConnectedError);
  transport.close();
}

test('TCP close during connect rejects pending write and late connect never writes/reopens', async () => {
  const h = tcp();
  h.transport.setReconnect(true, 1);
  const pending = assert.rejects(h.transport.write(frame), NotConnectedError);
  h.transport.close();
  await pending;
  assert.equal(h.sockets[0].destroyCalls, 1);
  h.sockets[0].emit('connect');
  h.sockets[0].emit('error', new Error('late socket error'));
  await delay(5);
  assert.deepEqual(h.sockets[0].writes, []);
  assert.equal(h.transport._connectTimer, null);
  assert.equal(h.transport._flushTimer, null);
  await assert.rejects(h.transport.connect(), NotConnectedError);
  await terminal(h.transport);
  assert.equal(h.sockets.length, 1);
});

test('TCP connect timeout destroys pending socket and ignores later completion', async () => {
  const h = tcp({ timeout: 10 });
  await assert.rejects(h.transport.write(frame), NoResponseError);
  h.sockets[0].emit('connect');
  await turn();
  assert.equal(h.sockets[0].destroyCalls, 1);
  assert.deepEqual(h.sockets[0].writes, []);
  await terminal(h.transport);
});

test('TCP close during flush delay cancels the callback and pending transmission', async () => {
  const h = tcp({ flushDelay: 25 });
  const pending = assert.rejects(h.transport.write(frame), NotConnectedError);
  h.sockets[0].emit('connect');
  h.transport.close();
  await pending;
  await delay(30);
  assert.deepEqual(h.sockets[0].writes, []);
  assert.equal(h.transport._flushTimer, null);
  await terminal(h.transport);
});

test('TCP remote close/error rejects queued reads and cannot auto reconnect', async () => {
  for (const event of ['close', 'error']) {
    const h = tcp();
    h.transport.setReconnect(true, 1);
    await openTcp(h);
    const pending = assert.rejects(h.transport.read(2));
    await turn();
    h.sockets[0].emit(event, new Error('peer ended'));
    await pending;
    h.sockets[0].emit('data', Buffer.from([6]));
    await delay(5);
    assert.equal(h.transport.availableBytes, 0);
    assert.equal(h.transport._bufferAcc._waiters.size, 0);
    await terminal(h.transport);
    assert.equal(h.sockets.length, 1);
  }
});

test('TCP read timeout is terminal and discards late data callbacks', async () => {
  const h = tcp({ timeout: 10 });
  await openTcp(h);
  await assert.rejects(h.transport.read(1), NoResponseError);
  h.sockets[0].emit('data', Buffer.from([6]));
  assert.equal(h.transport.availableBytes, 0);
  await terminal(h.transport);
});

test('serial close/timeout during import prevents port creation after late resolution', async () => {
  for (const mode of ['close', 'timeout']) {
    const h = serial({ pendingImport: true, timeout: mode === 'timeout' ? 10 : 100 });
    const pending = assert.rejects(h.transport.write(frame), mode === 'close' ? NotConnectedError : NoResponseError);
    if (mode === 'close') h.transport.close();
    await pending;
    h.load.resolve(h.module);
    await turn();
    assert.equal(h.ports.length, 0);
    assert.equal(h.transport._openTimer, null);
    await terminal(h.transport);
    assert.equal(h.loads(), 1);
  }
});

test('serial close/timeout during native open closes a late-opened handle without writing', async () => {
  for (const mode of ['close', 'timeout']) {
    const h = serial({ timeout: mode === 'timeout' ? 15 : 100 });
    const pending = assert.rejects(h.transport.write(frame), mode === 'close' ? NotConnectedError : NoResponseError);
    await turn();
    assert.equal(h.ports.length, 1);
    assert.equal(h.ports[0].options.autoOpen, false);
    if (mode === 'close') h.transport.close();
    await pending;
    h.ports[0].finishOpen();
    assert.equal(h.ports[0].isOpen, false);
    assert.equal(h.ports[0].closeCalls, 2);
    assert.deepEqual(h.ports[0].writes, []);
    h.ports[0].emit('error', new Error('late native error'));
    await terminal(h.transport);
  }
});

test('serial concurrent users share one open and close rejects pending read/write callbacks', async () => {
  const h = serial();
  const first = h.transport._ensureOpen();
  const second = h.transport._ensureOpen();
  await turn();
  assert.equal(h.loads(), 1);
  assert.equal(h.ports.length, 1);
  h.ports[0].finishOpen();
  await Promise.all([first, second]);
  h.ports[0].holdWrites = true;
  const write = assert.rejects(h.transport.write(frame), NotConnectedError);
  const read = assert.rejects(h.transport.read(1), NotConnectedError);
  await turn();
  h.transport.close();
  await Promise.all([write, read]);
  h.ports[0].writeCallback();
  h.ports[0].emit('data', Buffer.from([6]));
  assert.equal(h.transport.availableBytes, 0);
  assert.equal(h.transport._bufferAcc._waiters.size, 0);
  assert.equal(h.transport._writeRejectors.size, 0);
  assert.equal(h.ports[0].writes.length, 1);
  await terminal(h.transport);
  assert.equal(h.loads(), 1);
});

test('serial remote close/error/read timeout terminally reject further operations', async () => {
  for (const event of ['close', 'error', 'timeout']) {
    const h = serial({ timeout: 10 });
    await openSerial(h);
    const pending = assert.rejects(h.transport.read(1));
    await turn();
    if (event !== 'timeout') h.ports[0].emit(event, new Error('serial disconnected'));
    await pending;
    await terminal(h.transport);
    assert.equal(h.loads(), 1);
  }
});

test('import/open failure is terminal and late loader rejection is handled', async () => {
  const h = serial({ pendingImport: true });
  const pending = assert.rejects(h.transport.write(frame), NotConnectedError);
  h.transport.close();
  await pending;
  h.load.reject(new Error('late import failure'));
  await turn();
  await terminal(h.transport);
  const failing = serial();
  const opening = assert.rejects(failing.transport.write(frame), /open failed/);
  await turn();
  failing.ports[0].finishOpen(new Error('open failed'));
  await opening;
  await terminal(failing.transport);
});

test('client deadline cancels pending transport setup before a mutation can be sent', async () => {
  for (const mode of ['tcp-connect', 'tcp-flush', 'serial-import', 'serial-open']) {
    const h = mode.startsWith('tcp') ? tcp({ flushDelay: 35 })
      : serial({ pendingImport: mode === 'serial-import' });
    const client = new FXPLCClient(h.transport, { timeoutMs: 10 });
    const pending = assert.rejects(client.writeBytes(0x1000, Buffer.from([1])), NoResponseError);
    await turn();
    if (mode === 'tcp-flush') h.sockets[0].emit('connect');
    await pending;
    if (mode === 'tcp-connect') h.sockets[0].emit('connect');
    if (mode === 'serial-import') h.load.resolve(h.module);
    if (mode === 'serial-open') h.ports[0].finishOpen();
    await delay(40);
    const handles = h.sockets || h.ports;
    assert.ok(handles.every(handle => handle.writes.length === 0), mode);
    if (mode === 'serial-import') assert.equal(h.ports.length, 0);
    if (mode === 'serial-open') assert.equal(h.ports[0].isOpen, false);
    await terminal(h.transport);
  }
});
