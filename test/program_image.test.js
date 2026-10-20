import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ProgramProfile, parseCpuInfo, parseParameters, programMemoryLength,
  encodeProgramImage, decodeProgramImage, inspectProgramImage,
  compareProgramImages, compareDecodedImages, sameCpuIdentity,
  validateProfileCpu, programCrc32,
} from '../lib/program-image.js';

const hasCode = code => error => error.code === code;
function cpu(steps = 2000, extended = false) {
  const raw = Buffer.alloc(8);
  raw.writeUInt16LE(extended ? 24241 : 20121, 2);
  raw.writeUInt16LE(steps / 1000, 4);
  raw.writeUInt16LE(16, 6);
  return parseCpuInfo(raw, extended ? Buffer.from([0x71, 0x3f, 8, 0]) : null);
}
function image(steps = 2000, extended = false) {
  return {
    profile: extended ? ProgramProfile.Fx3uExtended8KReadOnly : ProgramProfile.Classic,
    capacitySteps: steps, cpu: cpu(steps, extended),
    memory: Buffer.from(Array.from({ length: programMemoryLength(steps) }, (_, n) => n % 251)),
  };
}
function repairCrc(encoded) {
  const header = encoded.readUInt16LE(10);
  encoded.writeUInt32LE(programCrc32(encoded.subarray(0, header - 4), encoded.subarray(header)), header - 4);
}

test('CPU/parameter codecs preserve raw bytes and apply capacity evidence', () => {
  const original = cpu();
  assert.equal(original.d8001, 20121);
  assert.equal(original.familyCode, 20);
  assert.equal(original.versionRaw, 121);
  assert.equal(original.capacitySteps, 2000);
  assert.equal(original.memoryKind, 'internal_memory');
  for (const [word, expected] of [[0, 'ram_cassette'], [1, 'rom_cassette'], [2, 'eeprom_unprotected'], [10, 'eeprom_protected'], [16, 'internal_memory'], [65535, 'unknown']]) {
    const raw = Buffer.from(original.raw);
    raw.writeUInt16LE(word, 6);
    assert.equal(parseCpuInfo(raw).memoryKind, expected);
  }
  const extended = cpu(8000, true);
  assert.equal(extended.d8101, 16241);
  assert.equal(extended.d8102, 8);
  assert.equal(extended.capacitySteps, 8000);
  assert.equal(parseCpuInfo(extended.raw).capacitySteps, null);
  assert.throws(() => parseCpuInfo(Buffer.alloc(7)), hasCode('PROGRAM_LENGTH'));
  assert.throws(() => parseCpuInfo(original.raw, Buffer.alloc(5)), hasCode('PROGRAM_LENGTH'));
  assert.throws(() => parseCpuInfo([0, 0, 0, 0, 0, 0, 0, 0]), hasCode('invalid_type'));
  assert.throws(() => validateProfileCpu(0, extended), hasCode('PROGRAM_PROFILE_CPU_MISMATCH'));
  assert.throws(() => validateProfileCpu(1, original), hasCode('PROGRAM_PROFILE_CPU_MISMATCH'));

  const bytes = Buffer.from(Array.from({ length: 92 }, (_, n) => n));
  const parameters = parseParameters(bytes);
  assert.equal(parameters.memorySettingRaw, 0x0100);
  assert.equal(parameters.sumDataRaw, 0x0302);
  assert.deepEqual(parameters.entryCodeRaw, bytes.subarray(8, 16));
  assert.deepEqual(parameters.titleRaw, bytes.subarray(16, 48));
  assert.deepEqual(parameters.latchRangesRaw, [[0x3130, 0x3332], [0x3534, 0x3736], [0x3938, 0x3b3a], [0x3d3c, 0x3f3e], [0x4140, 0x4342]]);
  assert.deepEqual(parameters.fileRegisterAllocationRaw, bytes.subarray(72, 76));
  assert.deepEqual(parameters.commentAllocationRaw, bytes.subarray(76, 80));
  bytes.fill(255);
  assert.equal(parameters.raw[0], 0);
  assert.throws(() => parseParameters(Buffer.alloc(91)), hasCode('PROGRAM_LENGTH'));
});

test('classic v1 matches an independently calculated reference header', () => {
  assert.equal(programCrc32(Buffer.from('123456789')), 0xcbf43926);
  // Independently calculated with Python struct.pack and zlib.
  const header = Buffer.from('4658504c43424b0001002000d00700000000994e02001000001000007d754954', 'hex');
  assert.deepEqual(encodeProgramImage(image()).subarray(0, 32), header);
  for (const [steps, memoryLength] of [[2000, 4096], [4000, 8096], [8000, 16096]]) {
    const input = image(steps);
    const encoded = encodeProgramImage(input);
    const decoded = inspectProgramImage(encoded);
    assert.equal(encoded.length, memoryLength + 32);
    assert.equal(decoded.profile, 0);
    assert.equal(decoded.parameterAddress, 0x8000);
    assert.equal(decoded.cpu.extendedRaw, null);
    assert.deepEqual(decoded.memory, input.memory);
    assert.deepEqual(encodeProgramImage(decoded), encoded);
    assert.equal(compareProgramImages(encoded, encoded).identical, true);
  }
});

test('extended v2 preserves profile, CPU extension and full address', () => {
  const input = image(8000, true);
  const encoded = encodeProgramImage(input);
  assert.equal(encoded.length, 16136);
  assert.equal(encoded.readUInt16LE(8), 2);
  assert.equal(encoded.readUInt16LE(10), 40);
  assert.equal(encoded.readUInt16LE(14), 1);
  assert.deepEqual(encoded.subarray(28, 32), Buffer.from([0x71, 0x3f, 8, 0]));
  assert.equal(encoded.readUInt32LE(32), 0x18000);
  const padded = Buffer.concat([Buffer.alloc(7), encoded, Buffer.alloc(9)]);
  const decoded = decodeProgramImage(padded.subarray(7, padded.length - 9));
  assert.equal(decoded.parameterAddress + decoded.memory.length - 1, 0x1bedf);
  assert.deepEqual(encodeProgramImage(decoded), encoded);
  encoded.fill(0);
  assert.deepEqual(decoded.memory, input.memory);
});

test('decoder rejects corrupt classic fields and truncated/oversized input', () => {
  const encoded = encodeProgramImage(image());
  for (const [offset, code] of [[0, 'PROGRAM_MAGIC'], [8, 'PROGRAM_VERSION'], [10, 'PROGRAM_HEADER'], [12, 'PROGRAM_CAPACITY'], [14, 'PROGRAM_FLAGS'], [16, 'PROGRAM_CHECKSUM'], [24, 'PROGRAM_LENGTH'], [28, 'PROGRAM_CHECKSUM'], [32, 'PROGRAM_CHECKSUM'], [encoded.length - 1, 'PROGRAM_CHECKSUM']]) {
    const bad = Buffer.from(encoded);
    bad[offset] ^= 1;
    assert.throws(() => decodeProgramImage(bad), hasCode(code));
  }
  for (const size of [0, 7, 31, 32, encoded.length - 1]) {
    assert.throws(() => decodeProgramImage(encoded.subarray(0, size)), hasCode('PROGRAM_LENGTH'));
  }
  assert.throws(() => decodeProgramImage(Buffer.concat([encoded, Buffer.alloc(1)])), hasCode('PROGRAM_LENGTH'));
  assert.throws(() => decodeProgramImage(Buffer.alloc(16137)), hasCode('PROGRAM_LENGTH'));
  const huge = Buffer.from(encoded);
  huge.writeUInt32LE(0xffffffff, 24);
  assert.throws(() => decodeProgramImage(huge), hasCode('PROGRAM_LENGTH'));
});

test('valid checksums cannot forge extended profile, capacity or provenance', () => {
  const encoded = encodeProgramImage(image(8000, true));
  for (const [offset, bytes, code] of [
    [14, [0, 0], 'PROGRAM_PROFILE'], [14, [2, 0], 'PROGRAM_PROFILE'],
    [28, [0, 0], 'PROGRAM_PROFILE_CPU_MISMATCH'],
    [30, [16, 0], 'PROGRAM_PROFILE_CPU_MISMATCH'],
    [20, [4, 0], 'PROGRAM_PROFILE_CPU_MISMATCH'],
    [32, [0, 0x80, 0, 0], 'PROGRAM_PROFILE_MISMATCH'],
    [32, [0, 0x80, 0x11, 0], 'PROGRAM_PROFILE_MISMATCH'],
  ]) {
    const forged = Buffer.from(encoded);
    forged.set(bytes, offset);
    repairCrc(forged);
    assert.throws(() => decodeProgramImage(forged), hasCode(code));
  }
  const legacy = encodeProgramImage(image(8000));
  legacy.writeUInt16LE(24241, 18);
  repairCrc(legacy);
  assert.throws(() => decodeProgramImage(legacy), hasCode('PROGRAM_CPU_CAPACITY'));
  for (const steps of ['2000', 2000n, NaN, Infinity, 2000.5, 16000, null]) {
    assert.throws(() => programMemoryLength(steps), hasCode('PROGRAM_CAPACITY'));
  }
  assert.throws(() => encodeProgramImage({ ...image(), capacitySteps: 4000 }), hasCode('PROGRAM_CAPACITY_MISMATCH'));
  assert.throws(() => encodeProgramImage({ ...image(8000, true), profile: 0 }), hasCode('PROGRAM_PROFILE_CPU_MISMATCH'));
});

test('comparison includes profile, bounds ranges and preserves 20-bit addresses', () => {
  const original = image(8000, true);
  const changed = image(8000, true);
  changed.memory[0] ^= 1;
  changed.memory[92] ^= 1;
  changed.memory[16095] ^= 1;
  const comparison = compareDecodedImages(original, changed);
  assert.equal(comparison.changedBytes, 3);
  assert.equal(comparison.metadataMatches, true);
  assert.deepEqual(comparison.ranges, [{ address: 0x18000, length: 1 }, { address: 0x1805c, length: 1 }, { address: 0x1bedf, length: 1 }]);
  const classic = image(8000);
  assert.equal(compareDecodedImages(classic, original).profileMatches, false);
  assert.equal(compareDecodedImages(classic, original).changedBytes, 0);
  assert.equal(compareDecodedImages(classic, changed).ranges[0].address, 0x8000);
  const alternating = image();
  for (let n = 0; n < alternating.memory.length; n += 2) alternating.memory[n] ^= 1;
  const bounded = compareDecodedImages(image(), alternating);
  assert.equal(bounded.changedBytes, 2048);
  assert.equal(bounded.ranges.length, 128);
  assert.equal(bounded.rangesTruncated, true);
  const larger = compareDecodedImages(image(), image(4000));
  assert.equal(larger.changedBytes, 4000);
  assert.deepEqual(larger.ranges, [{ address: 0x9000, length: 4000 }]);
  const otherCpu = cpu();
  otherCpu.raw[0] ^= 1;
  assert.equal(sameCpuIdentity(cpu(), otherCpu), true);
  otherCpu.raw[2] ^= 1;
  assert.equal(sameCpuIdentity(cpu(), otherCpu), false);
});
