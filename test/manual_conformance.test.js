import assert from 'node:assert/strict';
import test from 'node:test';
import { RegisterDef } from '../lib/registers.js';
import { FXPLCClient } from '../lib/FXPLCClient.js';
import { NumberType } from '../lib/number-types.js';
import { BufferAccumulator } from '../lib/transport-buffer.js';
import { TransportTCP } from '../lib/TransportTCP.js';
import { TransportSerial } from '../lib/TransportSerial.js';
import { NoResponseError, NotSupportedCommandError, ResponseMalformedError } from '../lib/errors.js';

// Independent fixtures transcribed from Mitsubishi FX-232AW BT5096-C.
// Page numbers count the cover as PDF page 1. No PLC or serial/TCP I/O.
const bitCases = [
  // Tables 1a and 7a/7b, PDF pp. 18, 26-27.
  ['S0', 0x0000, 0, 0x0000],
  ['S999', 0x007c, 7, 0x03e7],
  ['X100', 0x0088, 0, 0x0440],
  ['X177', 0x008f, 7, 0x047f],
  ['Y23', 0x00a2, 3, 0x0513],
  ['Y100', 0x00a8, 0, 0x0540],
  ['Y177', 0x00af, 7, 0x057f],
  ['T255', 0x00df, 7, 0x06ff],
  ['M1023', 0x017f, 7, 0x0bff],
  ['M8000', 0x01e0, 0, 0x0f00],
  ['M8255', 0x01ff, 7, 0x0fff],
  ['C0', 0x01c0, 0, 0x0e00],
  ['C255', 0x01df, 7, 0x0eff],
];
const dataCases = [
  // Tables 2-6, PDF pp. 20-25.
  ['T0', 0x0800], ['T255', 0x09fe],
  ['C0', 0x0a00], ['C199', 0x0b8e],
  ['C200', 0x0c00], ['C201', 0x0c04], ['C255', 0x0cdc],
  ['D0', 0x1000], ['D123', 0x10f6], ['D511', 0x13fe],
  ['D8000', 0x0e00], ['D8255', 0x0ffe],
];

test('manual contact, FORCE and numeric address tables', () => {
  for (const [name, byte, bit, force] of bitCases) {
    const reg = RegisterDef.parse(name);
    assert.deepEqual(reg.getBitImageAddress(), [byte, bit], name);
    assert.equal(reg.getForceAddress(), force, name);
  }
  for (const [name, address] of dataCases)
    assert.equal(RegisterDef.parse(name).getDataAddress(), address, name);
  assert.equal(RegisterDef.parse('X100').num, 100, 'preserve device label notation');
  assert.equal(RegisterDef.parse('D0010').toString(), 'D10');
});

test('strict device tokens and bounded classic profile prevent area aliasing', () => {
  for (const token of [
    '', 'D', 'd0', 'Z0', 'D1junk', 'D-1', 'D+1', ' D1', 'D1 ', 'D1\n', 'D1.5',
    'X8', 'X80', 'X90', 'X180', 'Y128', 'X200', 'Y200',
    'S1000', 'S1024', 'T256', 'C256', 'M1024', 'M7999', 'M8256',
    'D512', 'D7999', 'D8256', 'D9007199254740992',
  ]) assert.throws(() => RegisterDef.parse(token), undefined, token);
  for (const index of [-1, 1.5, NaN, Infinity, '1'])
    assert.throws(() => new RegisterDef('D', index));
  assert.throws(() => RegisterDef.parse('D9').getBitImageAddress());
  assert.throws(() => RegisterDef.parse('D0').getForceAddress());
  assert.throws(() => RegisterDef.parse('M0').getDataAddress());
});

test('numeric codecs cannot cross a documented address segment', () => {
  for (const name of ['T255', 'C199', 'D511', 'D8255'])
    assert.throws(() => RegisterDef.parse(name).getDataAddress(4), undefined, name);
  assert.equal(RegisterDef.parse('C255').getDataAddress(4), 0x0cdc);
  assert.equal(RegisterDef.parse('C200').getDataAddress(2), 0x0c00, 'explicit low-word access remains possible');
  assert.equal(RegisterDef.parse('D0').getDataAddress(64), 0x1000);
  assert.throws(() => RegisterDef.parse('D0').getDataAddress(65));
});

function dataReply(bytes) {
  const body = Buffer.concat([Buffer.from(bytes.toString('hex').toUpperCase()), Buffer.from([3])]);
  let sum = 0;
  for (const byte of body) sum = (sum + byte) & 255;
  return Buffer.concat([Buffer.from([2]), body, Buffer.from(sum.toString(16).toUpperCase().padStart(2, '0'))]);
}

class SimulatedPeer {
  constructor(responses) {
    this.responses = responses;
    this.frames = [];
    this.pending = Buffer.alloc(0);
    this.closed = false;
  }
  async write(frame) {
    this.frames.push(Buffer.from(frame));
    this.pending = typeof this.responses === 'function'
      ? this.responses(frame)
      : this.responses.shift() ?? Buffer.alloc(0);
  }
  async read(size) {
    const out = this.pending.subarray(0, size);
    this.pending = this.pending.subarray(size);
    return out;
  }
  close() { this.closed = true; }
}

// Unlike the simple request/response fixture above, this peer never overwrites
// buffered input when a new request is sent. It reproduces TCP accumulation.
class PreservingPeer {
  constructor(responses = []) {
    this.responses = responses;
    this.accumulator = new BufferAccumulator();
    this.frames = [];
    this.closed = false;
  }
  get availableBytes() { return this.accumulator.availableBytes; }
  async write(frame) {
    this.frames.push(Buffer.from(frame));
    this.accumulator.push(this.responses.shift() ?? Buffer.alloc(0));
  }
  async read(size) { return this.accumulator.read(size, 25); }
  close() { this.closed = true; this.accumulator.close(); }
}

function parsedRequest(frame) {
  const ascii = frame.toString('ascii');
  return { command: ascii[1], address: parseInt(ascii.slice(2, 6), 16), count: parseInt(ascii.slice(6, 8), 16) };
}

test('manual READ, WRITE, FORCE and DATA examples match exact wire bytes', async () => {
  const cases = [
    // READ examples, PDF p. 10; WRITE examples, p. 12; FORCE Y23, p. 14.
    [client => client.readBytes(0x00a0, 2), '\x02000A002\x0366', dataReply(Buffer.from([0x35, 0x84]))],
    [client => client.readBytes(0x10f6, 4), '\x02010F604\x0374', Buffer.from('\x023412CDAB\x03D7')],
    [client => client.writeBytes(0x00a0, Buffer.from([0x35, 0x84])), '\x02100A0023584\x033B', Buffer.from([6])],
    [client => client.writeBytes(0x10f6, Buffer.from([0x34, 0x12, 0xcd, 0xab])), '\x02110F6043412CDAB\x0349', Buffer.from([6])],
    [client => client.writeBit('Y23', true), '\x0271305\x0303', Buffer.from([6])],
  ];
  for (const [run, expected, reply] of cases) {
    const peer = new SimulatedPeer([reply]);
    const result = await run(new FXPLCClient(peer));
    assert.deepEqual(peer.frames, [Buffer.from(expected)]);
    if (expected === '\x02010F604\x0374') assert.deepEqual(result, Buffer.from([0x34, 0x12, 0xcd, 0xab]));
  }
});

test('corrected mappings are used by public read and mutation helpers', async () => {
  for (const [name, byte, , force] of bitCases) {
    const readPeer = new SimulatedPeer([dataReply(Buffer.from([0xff]))]);
    assert.equal(await new FXPLCClient(readPeer).readBit(name), true);
    assert.equal(parsedRequest(readPeer.frames[0]).address, byte, name);
    const forcePeer = new SimulatedPeer([Buffer.from([6])]);
    await new FXPLCClient(forcePeer).writeBit(name, false);
    const encoded = forcePeer.frames[0].toString('ascii').slice(2, 6);
    assert.equal(Buffer.from(encoded, 'hex').readUInt16LE(0), force, name);
  }
  for (const [name, address] of dataCases) {
    const peer = new SimulatedPeer([dataReply(Buffer.alloc(2)), Buffer.from([6])]);
    const client = new FXPLCClient(peer);
    await client.readNumber(name);
    await client.writeNumber(name, 123);
    assert.equal(parsedRequest(peer.frames[0]).address, address, name);
    assert.equal(parsedRequest(peer.frames[1]).address, address, name);
  }
});

test('raw byte counts and address spans are checked before any command is sent', async () => {
  const peer = new SimulatedPeer([]);
  const client = new FXPLCClient(peer);
  for (const count of [0, 65, 255, -1, 1.5]) {
    await assert.rejects(client.readBytes(0, count));
    if (Number.isInteger(count) && count >= 0) await assert.rejects(client.writeBytes(0, Buffer.alloc(count)));
  }
  await assert.rejects(client.readBytes(0xffff, 2));
  await assert.rejects(client.writeBytes(0xffff, Buffer.alloc(2)));
  await assert.rejects(client.readBytes(-1, 1));
  await assert.rejects(client.writeBytes(0, [1]));
  await assert.rejects(client.readBit('D9'));
  await assert.rejects(client.writeBit('D9', true));
  assert.equal(peer.frames.length, 0);

  const limitPeer = new SimulatedPeer([dataReply(Buffer.alloc(64)), Buffer.from([6])]);
  const bounded = new FXPLCClient(limitPeer);
  assert.equal((await bounded.readBytes(0, 64)).length, 64);
  await bounded.writeBytes(0, Buffer.alloc(64));
  assert.equal(limitPeer.frames[1].length, 139);
});

test('batches split at 64 bytes and use actual numeric byte addresses', async () => {
  const peer = new SimulatedPeer(frame => {
    const request = parsedRequest(frame);
    return request.command === '0' ? dataReply(Buffer.alloc(request.count)) : Buffer.from([6]);
  });
  const client = new FXPLCClient(peer);
  const registers = Array.from({ length: 40 }, (_, i) => `D${i}`);
  assert.equal((await client.batchRead(registers)).length, 40);
  await client.batchWrite(registers, Array(40).fill(123));
  assert.deepEqual(peer.frames.map(parsedRequest), [
    { command: '0', address: 0x1000, count: 64 }, { command: '0', address: 0x1040, count: 16 },
    { command: '1', address: 0x1000, count: 64 }, { command: '1', address: 0x1040, count: 16 },
  ]);
  peer.frames.length = 0;
  await client.batchRead(['C200', 'C201'], NumberType.DoubleWordSigned);
  await client.batchWrite(['D0', 'D1'], [1, 2], NumberType.DoubleWordSigned);
  assert.deepEqual(peer.frames.map(parsedRequest), [
    { command: '0', address: 0x0c00, count: 8 },
    { command: '1', address: 0x1000, count: 4 },
    { command: '1', address: 0x1002, count: 4 },
  ]);
});

test('batch validation completes before mutations, including later invalid values', async () => {
  const peer = new SimulatedPeer([]);
  const client = new FXPLCClient(peer);
  await assert.rejects(client.batchWrite(['D0', 'D511'], [1, 2], NumberType.DoubleWordSigned));
  await assert.rejects(client.batchWrite(['D0', 'D2'], [1, 40000]));
  await assert.rejects(client.batchWrite(['D0', 'D512'], [1, 2]));
  assert.equal(peer.frames.length, 0);
});

test('readBytes callback overload uses the default count', async () => {
  const peer = new SimulatedPeer([dataReply(Buffer.from([42]))]);
  const value = await new Promise((resolve, reject) => {
    new FXPLCClient(peer).readBytes(0, (error, bytes) => error ? reject(error) : resolve(bytes));
  });
  assert.deepEqual(value, Buffer.from([42]));
  assert.equal(parsedRequest(peer.frames[0]).count, 1);
});

test('malformed, oversized and wrong-kind replies terminate the client without retries', async () => {
  const badReplies = [
    Buffer.from([6]), // ACK is not a READ response.
    Buffer.from('\x0210\x0300'), // Wrong checksum.
    Buffer.from('\x02GG\x0391'), // Nonhex payload, even with a valid checksum.
    dataReply(Buffer.alloc(65)),
    dataReply(Buffer.alloc(2)), // A one-byte READ cannot accept two bytes.
  ];
  for (const reply of badReplies) {
    const peer = new SimulatedPeer([reply]);
    const client = new FXPLCClient(peer, { retry: { count: 3, delayMs: 0 } });
    await assert.rejects(client.readBytes(0, 1), ResponseMalformedError);
    await assert.rejects(client.readBytes(0, 1), NoResponseError);
    assert.equal(peer.frames.length, 1);
    assert.equal(peer.closed, true);
  }
  const writePeer = new SimulatedPeer([dataReply(Buffer.from([1]))]);
  await assert.rejects(new FXPLCClient(writePeer).writeBit('S0', true), ResponseMalformedError);
});

test('ambiguous mutation timeout is never replayed and requires a new clean transport', async () => {
  const peer = new SimulatedPeer([]);
  peer.read = () => new Promise(() => {});
  const client = new FXPLCClient(peer, { timeoutMs: 10, retry: { count: 3, delayMs: 0 } });
  await assert.rejects(client.writeBit('M8000', true), NoResponseError);
  await assert.rejects(client.writeBit('M8000', false), NoResponseError);
  assert.equal(peer.frames.length, 1);
  assert.equal(peer.closed, true);
});

test('NAK is returned once and leaves the synchronized transport available', async () => {
  const peer = new SimulatedPeer([Buffer.from([0x15]), Buffer.from([6])]);
  const client = new FXPLCClient(peer, { retry: { count: 3, delayMs: 0 } });
  await assert.rejects(client.writeBit('S0', true), NotSupportedCommandError);
  assert.equal(peer.frames.length, 1);
  assert.equal(peer.closed, false);
  await client.writeBit('S0', false);
  assert.equal(peer.frames.length, 2);
});

test('queued mutations and remaining batch chunks stop after an ambiguous failure', async () => {
  const peer = new SimulatedPeer([Buffer.alloc(0)]);
  const client = new FXPLCClient(peer);
  const results = await Promise.allSettled([
    client.writeBit('S0', true), client.writeBit('S1', true),
  ]);
  assert.equal(results.every(result => result.status === 'rejected'), true);
  assert.equal(peer.frames.length, 1);

  const batchPeer = new SimulatedPeer([Buffer.alloc(0)]);
  const registers = Array.from({ length: 40 }, (_, i) => `D${i}`);
  await assert.rejects(new FXPLCClient(batchPeer).batchWrite(registers, Array(40).fill(0)), NoResponseError);
  assert.equal(batchPeer.frames.length, 1);
});

test('preserved duplicate ACK or NAK bytes cannot acknowledge a subsequent mutation', async () => {
  for (const response of [Buffer.from([6, 6]), Buffer.from([0x15, 6])]) {
    const peer = new PreservingPeer([response]);
    const client = new FXPLCClient(peer);
    await assert.rejects(client.writeBit('M0', true), ResponseMalformedError);
    await assert.rejects(client.writeBit('M1', true), NoResponseError);
    assert.equal(peer.frames.length, 1);
    assert.equal(peer.closed, true);
  }
});

test('preserved DATA trailing bytes and wrong READ lengths invalidate the client', async () => {
  for (const response of [
    Buffer.concat([dataReply(Buffer.from([42])), Buffer.from([6])]),
    Buffer.concat([dataReply(Buffer.from([42])), dataReply(Buffer.from([43]))]),
    dataReply(Buffer.from([42, 43])),
  ]) {
    const peer = new PreservingPeer([response]);
    const client = new FXPLCClient(peer);
    await assert.rejects(client.readBytes(0, 1), ResponseMalformedError);
    await assert.rejects(client.writeBit('M0', true), NoResponseError);
    assert.equal(peer.frames.length, 1);
    assert.equal(peer.closed, true);
  }
});

test('unsolicited buffered input before or between commands prevents the next transmission', async () => {
  const peer = new PreservingPeer();
  peer.accumulator.push(Buffer.from([6]));
  await assert.rejects(new FXPLCClient(peer).writeBit('M0', true), ResponseMalformedError);
  assert.equal(peer.frames.length, 0);
  assert.equal(peer.closed, true);

  const between = new PreservingPeer([Buffer.from([6])]);
  const client = new FXPLCClient(between);
  await client.writeBit('M0', true);
  between.accumulator.push(Buffer.from([6]));
  await assert.rejects(client.writeBit('M1', true), ResponseMalformedError);
  assert.equal(between.frames.length, 1);
  assert.equal(between.closed, true);
});

test('built-in transports expose buffered byte counts and preserve unexpected input', async () => {
  const accumulator = new BufferAccumulator();
  accumulator.push(Buffer.from([6, 6]));
  assert.equal(accumulator.availableBytes, 2);
  await accumulator.read(1);
  assert.equal(accumulator.availableBytes, 1);

  // Inject inert handles; neither adapter opens a port or socket.
  const tcp = new TransportTCP({ host: 'unused.invalid', port: 1 });
  tcp._socket = { write: () => assert.fail('must not transmit with stale input') };
  const serial = new TransportSerial({ path: 'unused' });
  serial._opened = true;
  serial._port = { write: () => assert.fail('must not transmit with stale input') };
  for (const transport of [tcp, serial]) {
    assert.equal(transport.availableBytes, 0);
    transport._bufferAcc.push(Buffer.from([6]));
    assert.equal(transport.availableBytes, 1);
    await assert.rejects(transport.write(Buffer.from([2])), ResponseMalformedError);
    assert.equal(transport.availableBytes, 1);
  }
});
