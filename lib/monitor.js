// Classic PLC-native monitor, Mitsubishi FX-232AW BT5096-C pp. 29-30.
// The manual's bit-count/table diagram is inconsistent, so callers must supply
// an independently verified layout. No hardware layout is assumed here.
import { RegisterDef } from './registers.js';
import { NumberType } from './number-types.js';

const MAX_NUMBERS = 18;
const MAX_BITS = 152;
const MAX_BYTES = 64;
const NUMBER_COUNT = 0x1800;
const CONTROL = 0x1801;
const NUMBER_TABLE = 0x1802;
const NUMBER_RESULT = 0x1958;
const BIT_RESULT = 0x19a0;
const preparedStates = new WeakSet();

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function register(token, numeric) {
  if (typeof token !== 'string' || !/^[SXYTMDC][0-9]+$/.test(token))
    throw failure('invalid_register', 'Monitor register must be a complete device name');
  let value;
  try {
    value = RegisterDef.parse(token);
  } catch (error) {
    const code = error.message.includes('outside the documented')
      ? 'register_out_of_range' : 'invalid_register';
    throw failure(code, error.message);
  }
  if (numeric ? !['T', 'C', 'D'].includes(value.type) : value.type === 'D')
    throw failure('unsupported_operation', `Unsupported monitor device ${token}`);
  return value;
}

function numberKind(kind) {
  switch (kind) {
    case NumberType.WordSigned: return { size: 2, read: (bytes, offset) => bytes.readInt16LE(offset) };
    case NumberType.WordUnsigned: return { size: 2, read: (bytes, offset) => bytes.readUInt16LE(offset) };
    case NumberType.DoubleWordSigned: return { size: 4, read: (bytes, offset) => bytes.readInt32LE(offset) };
    case NumberType.DoubleWordUnsigned: return { size: 4, read: (bytes, offset) => bytes.readUInt32LE(offset) };
    case NumberType.Float: return { size: 4, read: null };
    default: throw failure('invalid_number_type', 'Expected a NumberType member');
  }
}

/** Validate and snapshot a plain monitor configuration before transport I/O. */
export function prepareMonitor(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw failure('invalid_type', 'Monitor configuration must be an object');
  const { numericRegisters, numberTypes, bitRegisters, bitCountAddress, bitTableAddress } = config;
  for (const list of [numericRegisters, numberTypes, bitRegisters]) {
    if (!Array.isArray(list)) throw failure('invalid_type', 'Monitor points and types must be arrays');
  }
  if (numericRegisters.length !== numberTypes.length)
    throw failure('invalid_range', 'Numeric register/type count differs');
  if (numericRegisters.length > MAX_NUMBERS || bitRegisters.length > MAX_BITS)
    throw failure('too_many_monitor_points', 'Monitor supports at most 18 numeric and 152 bit points');
  if (numericRegisters.length + bitRegisters.length === 0)
    throw failure('empty_monitor_configuration', 'Monitor configuration has no points');
  if (!Number.isInteger(bitCountAddress) || !Number.isInteger(bitTableAddress) ||
      bitCountAddress < NUMBER_TABLE || bitCountAddress >= bitTableAddress ||
      bitTableAddress >= NUMBER_RESULT)
    throw failure('invalid_monitor_layout', 'Monitor layout exceeds the configuration workspace');

  // Array.from visits holes as undefined, so sparse input is rejected as well.
  const numbers = Array.from(numericRegisters, (token, index) => {
    const point = register(token, true);
    const kind = numberKind(numberTypes[index]);
    const width = point.type === 'C' && point.num >= 200 ? 4 : 2;
    if (kind.size !== width || kind.read === null)
      throw failure('monitor_numeric_width', `${token} requires its native ${width}-byte integer type`);
    return { address: point.getDataAddress(width), ...kind };
  });
  const bits = Array.from(bitRegisters, token => {
    const [address, bit] = register(token, false).getBitImageAddress();
    return (address << 3) | bit;
  });
  if (NUMBER_TABLE + numbers.length * 2 > bitCountAddress ||
      bitTableAddress + bits.length * 2 > NUMBER_RESULT)
    throw failure('overlapping_monitor_configuration', 'Monitor tables overlap count/result regions');

  const numberTable = Buffer.alloc(numbers.length * 2);
  numbers.forEach((point, index) => numberTable.writeUInt16LE(point.address, index * 2));
  const bitTable = Buffer.alloc(bits.length * 2);
  bits.forEach((address, index) => bitTable.writeUInt16LE(address, index * 2));
  const regions = [{ address: NUMBER_COUNT, bytes: Buffer.from([numbers.length]) }];
  if (numberTable.length) regions.push({ address: NUMBER_TABLE, bytes: numberTable });
  regions.push({ address: bitCountAddress, bytes: Buffer.from([bits.length]) });
  if (bitTable.length) regions.push({ address: bitTableAddress, bytes: bitTable });
  const state = {
    numbers,
    bitCount: bits.length,
    regions,
    numericLength: numbers.reduce((length, point) => length + point.size, 0),
    bitLength: Math.ceil(bits.length / 8),
  };
  preparedStates.add(state);
  return state;
}

function checkedState(state) {
  if (!state || !preparedStates.has(state))
    throw failure('monitor_not_configured', 'Configure this client monitor before reading or stopping it');
  return state;
}

async function read(io, address, count) {
  const bytes = await io.readBytes(address, count);
  if (!(bytes instanceof Uint8Array) || bytes.length !== count)
    throw failure('monitor_result_shape', 'Monitor response length/type differs from its read plan');
  return Buffer.from(bytes);
}

async function readRange(io, address, count) {
  const result = Buffer.alloc(count);
  for (let offset = 0; offset < count; offset += MAX_BYTES) {
    const bytes = await read(io, address + offset, Math.min(MAX_BYTES, count - offset));
    bytes.copy(result, offset);
  }
  return result;
}

async function verifyConfiguration(io, state) {
  for (const { address, bytes } of state.regions) {
    const actual = await readRange(io, address, bytes.length);
    if (!actual.equals(bytes))
      throw failure('monitor_ownership_lost', 'PLC monitor configuration differs from this client');
  }
  if (!((await read(io, CONTROL, 1))[0] & 1))
    throw failure('monitor_ownership_lost', 'PLC native monitor is disabled');
}

/** Caller owns one exclusive workflow lock and handles terminal I/O failures. */
export async function configureMonitor(io, config) {
  const state = preparedStates.has(config) ? config : prepareMonitor(config);
  const control = (await read(io, CONTROL, 1))[0];
  await io.writeBytes(CONTROL, Buffer.from([control & 0xfe]));
  for (const { address, bytes } of state.regions) {
    for (let offset = 0; offset < bytes.length; offset += MAX_BYTES) {
      await io.writeBytes(address + offset, Buffer.from(bytes.subarray(offset, offset + MAX_BYTES)));
    }
  }
  await io.writeBytes(CONTROL, Buffer.from([control | 1]));
  await verifyConfiguration(io, state);
  return state;
}

/** Read existing results; the protocol provides no fresh-sample/scan marker. */
export async function readMonitor(io, state) {
  checkedState(state);
  await verifyConfiguration(io, state);
  const numericBytes = await readRange(io, NUMBER_RESULT, state.numericLength);
  const bitBytes = await readRange(io, BIT_RESULT, state.bitLength);
  await verifyConfiguration(io, state);
  let offset = 0;
  const numbers = Float64Array.from(state.numbers, point => {
    const value = point.read(numericBytes, offset);
    offset += point.size;
    return value;
  });
  const bits = Array.from({ length: state.bitCount }, (_, index) =>
    (bitBytes[index >> 3] & (1 << (index & 7))) !== 0);
  return { numbers, bits, numericBytes: Uint8Array.from(numericBytes), bitBytes: Uint8Array.from(bitBytes) };
}

/** Preserve reserved control bits and stop only the configuration we installed. */
export async function stopMonitor(io, state) {
  checkedState(state);
  await verifyConfiguration(io, state);
  const control = (await read(io, CONTROL, 1))[0];
  await io.writeBytes(CONTROL, Buffer.from([control & 0xfe]));
  if ((await read(io, CONTROL, 1))[0] & 1)
    throw failure('monitor_ownership_lost', 'PLC monitor remained enabled after stop');
}
