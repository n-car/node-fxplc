import assert from 'node:assert/strict';
import test from 'node:test';
import { NumberType } from '../lib/number-types.js';
import { configureMonitor, readMonitor } from '../lib/monitor.js';

// Independent memory peer: the test supplies PLC result bytes explicitly.
// No request encoder, frame parser, physical transport or production decoder
// is reused to manufacture expected results.
function peer() {
  const memory = Buffer.alloc(65536, 0x55);
  memory[0x1801] = 0xa5;
  const trace = [];
  return {
    memory, trace,
    writes: () => trace.filter(operation => operation.kind === 'write'),
    async readBytes(address, count) {
      trace.push({ kind: 'read', address, count });
      return Buffer.from(memory.subarray(address, address + count));
    },
    async writeBytes(address, bytes) {
      trace.push({ kind: 'write', address, bytes: Buffer.from(bytes) });
      bytes.copy(memory, address);
    },
  };
}

function config(overrides = {}) {
  return {
    numericRegisters: ['D0'], numberTypes: [NumberType.WordSigned],
    bitRegisters: ['M1'], bitCountAddress: 0x1826, bitTableAddress: 0x1828,
    ...overrides,
  };
}

test('native monitor decodes signed/unsigned endpoints and preserves reserved bytes', async () => {
  const target = peer();
  const state = await configureMonitor(target, config({
    numericRegisters: ['D0', 'D1', 'D2', 'D511', 'C200', 'C201', 'C202', 'C255'],
    numberTypes: [
      NumberType.WordSigned, NumberType.WordSigned, NumberType.WordUnsigned, NumberType.WordUnsigned,
      NumberType.DoubleWordSigned, NumberType.DoubleWordSigned,
      NumberType.DoubleWordUnsigned, NumberType.DoubleWordUnsigned,
    ],
    bitRegisters: ['M1', 'X100', 'C200'],
  }));
  assert.deepEqual(target.memory.subarray(0x1802, 0x1812), Buffer.from([
    0x00, 0x10, 0x02, 0x10, 0x04, 0x10, 0xfe, 0x13,
    0x00, 0x0c, 0x04, 0x0c, 0x08, 0x0c, 0xdc, 0x0c,
  ]));
  assert.deepEqual(target.memory.subarray(0x1828, 0x182e), Buffer.from([1, 8, 0x40, 4, 0xc8, 14]));
  // Unused table entries, reserved byte 0x1827 and the next bit entry survive.
  assert.equal(target.memory[0x1812], 0x55);
  assert.equal(target.memory[0x1827], 0x55);
  assert.equal(target.memory[0x182e], 0x55);
  assert.equal(target.writes()[0].address, 0x1801);
  assert.deepEqual(target.writes()[0].bytes, Buffer.from([0xa4]));
  assert.deepEqual(target.writes().at(-1).bytes, Buffer.from([0xa5]));

  const numeric = Buffer.from([
    0x00, 0x80, 0xff, 0x7f, 0xff, 0xff, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x80, 0xff, 0xff, 0xff, 0x7f,
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00,
  ]);
  numeric.copy(target.memory, 0x1958);
  target.memory[0x19a0] = 0b101;
  const result = await readMonitor(target, state);
  assert.ok(result.numbers instanceof Float64Array);
  assert.deepEqual([...result.numbers], [-32768, 32767, 65535, 0, -2147483648, 2147483647, 4294967295, 0]);
  assert.deepEqual(result.bits, [true, false, true]);
  assert.deepEqual(Buffer.from(result.numericBytes), numeric);
  assert.deepEqual([...result.bitBytes], [5]);

});

test('18 four-byte counters require separate 64-byte and 8-byte result reads', async () => {
  const target = peer();
  const state = await configureMonitor(target, config({
    numericRegisters: Array(18).fill('C255'),
    numberTypes: Array(18).fill(NumberType.DoubleWordUnsigned),
    bitRegisters: [],
  }));
  assert.equal(target.memory[0x1800], 18);
  assert.equal(target.memory[0x1826], 0);
  for (let index = 0; index < 18; index++)
    target.memory.writeUInt32LE(0xffffffff - index, 0x1958 + index * 4);
  const start = target.trace.length;
  const result = await readMonitor(target, state);
  assert.deepEqual([...result.numbers], Array.from({ length: 18 }, (_, index) => 0xffffffff - index));
  assert.deepEqual(result.bits, []);
  assert.equal(result.bitBytes.length, 0);
  assert.deepEqual(target.trace.slice(start).filter(operation => operation.address >= 0x1958)
    .map(operation => [operation.address, operation.count]), [
    [0x1958, 64], [0x1998, 8],
  ]);
  assert.ok(target.trace.every(operation => {
    const length = operation.kind === 'read' ? operation.count : operation.bytes.length;
    return length >= 1 && length <= 64;
  }));
});
