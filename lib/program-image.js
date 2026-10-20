// FXPLCBK binary format and CPU/parameter interpretation.
// This module is JavaScript only and performs no transport or filesystem I/O.
import { FXPLCError } from './errors.js';

export const ProgramProfile = Object.freeze({ Classic: 0, Fx3uExtended8KReadOnly: 1 });
export const PARAMETER_BYTES = 92;
export const MAX_PROGRAM_IMAGE_BYTES = 16_096;
export const MAX_PROGRAM_CONTAINER_BYTES = MAX_PROGRAM_IMAGE_BYTES + 40;
export const MAX_CHANGED_RANGES = 128;
const MAGIC = Buffer.from('FXPLCBK\0', 'ascii');

function fail(code, message) {
  const error = new FXPLCError(message);
  error.code = code;
  throw error;
}

function bytes(value) {
  if (!(value instanceof Uint8Array)) fail('invalid_type', 'bytes must be a Uint8Array');
  // A view avoids copying an unchecked host buffer; bounded copies happen only
  // after structural validation. Preserve the caller's byte offset and length.
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function length(value, expected, field) {
  if (value.length !== expected) {
    fail('PROGRAM_LENGTH', `${field} requires exactly ${expected} bytes, received ${value.length}`);
  }
}

function profileValue(profile) {
  if (profile !== ProgramProfile.Classic && profile !== ProgramProfile.Fx3uExtended8KReadOnly) {
    fail('invalid_program_profile', 'expected a ProgramProfile member');
  }
  return profile;
}

export function parameterAddress(profile) {
  return profileValue(profile) === ProgramProfile.Classic ? 0x8000 : 0x18000;
}

export function programMemoryLength(steps) {
  if (typeof steps !== 'number' || ![2000, 4000, 8000].includes(steps)) {
    fail('PROGRAM_CAPACITY', 'unsupported classic program capacity; expected 2000, 4000 or 8000 steps');
  }
  return PARAMETER_BYTES + steps * 2 + 4;
}

export function parseCpuInfo(rawValue, extendedValue = null) {
  const source = bytes(rawValue);
  length(source, 8, 'CPU information');
  const raw = Buffer.from(source);
  let extendedRaw = null;
  if (extendedValue !== null) {
    const extended = bytes(extendedValue);
    length(extended, 4, 'extended CPU information');
    extendedRaw = Buffer.from(extended);
  }
  const d8001 = raw.readUInt16LE(2);
  const d8002 = raw.readUInt16LE(4);
  const d8003 = raw.readUInt16LE(6);
  const familyCode = Math.floor(d8001 / 1000);
  const d8101 = extendedRaw === null ? null : extendedRaw.readUInt16LE(0);
  const d8102 = extendedRaw === null ? null : extendedRaw.readUInt16LE(2);
  let capacityCode = d8002;
  if (d8102 !== null) {
    if (d8102 !== d8002) capacityCode = null;
    else capacityCode = d8102;
  } else if (familyCode === 24) capacityCode = null;
  const capacitySteps = [2, 4, 8].includes(capacityCode) ? capacityCode * 1000 : null;
  const memoryKind = new Map([
    [0, 'ram_cassette'], [1, 'rom_cassette'], [2, 'eeprom_unprotected'],
    [10, 'eeprom_protected'], [16, 'internal_memory'],
  ]).get(d8003) || 'unknown';
  return {
    raw, d8001, d8002, d8003, extendedRaw, d8101, d8102, capacitySteps,
    familyCode, versionRaw: d8001 % 1000, memoryKind,
  };
}

function canonicalCpu(cpu) {
  if (!cpu || typeof cpu !== 'object') fail('invalid_type', 'CPU information must contain raw bytes');
  return parseCpuInfo(cpu.raw, cpu.extendedRaw ?? null);
}

export function validateProfileCpu(profile, value) {
  profileValue(profile);
  const cpu = canonicalCpu(value);
  const valid = profile === ProgramProfile.Classic
    ? cpu.extendedRaw === null
    : cpu.d8101 !== null && Math.floor(cpu.d8101 / 1000) === 16
      && cpu.d8002 === 8 && cpu.d8102 === 8;
  if (!valid) fail('PROGRAM_PROFILE_CPU_MISMATCH', 'CPU identification does not match the program-image profile');
  return cpu;
}

export function sameCpuIdentity(left, right) {
  const a = canonicalCpu(left);
  const b = canonicalCpu(right);
  return a.raw.subarray(2).equals(b.raw.subarray(2))
    && (a.extendedRaw === null ? b.extendedRaw === null
      : b.extendedRaw !== null && a.extendedRaw.equals(b.extendedRaw));
}

export function parseParameters(value) {
  const source = bytes(value);
  length(source, PARAMETER_BYTES, 'parameters');
  const raw = Buffer.from(source);
  const latchRangesRaw = Array.from({ length: 5 }, (_, index) => {
    const start = 0x30 + index * 4;
    return [raw.readUInt16LE(start), raw.readUInt16LE(start + 2)];
  });
  return {
    raw,
    memorySettingRaw: raw.readUInt16LE(0),
    sumDataRaw: raw.readUInt16LE(2),
    entryCodeRaw: Buffer.from(raw.subarray(8, 16)),
    titleRaw: Buffer.from(raw.subarray(16, 48)),
    latchRangesRaw,
    fileRegisterAllocationRaw: Buffer.from(raw.subarray(72, 76)),
    commentAllocationRaw: Buffer.from(raw.subarray(76, 80)),
  };
}

function validateMetadata(profile, capacitySteps, value) {
  programMemoryLength(capacitySteps);
  const cpu = validateProfileCpu(profile, value);
  if (cpu.capacitySteps === null) {
    fail('PROGRAM_CPU_CAPACITY', `unsupported CPU memory-capacity code in D8002: ${cpu.d8002}`);
  }
  if (cpu.capacitySteps !== capacitySteps) {
    fail('PROGRAM_CAPACITY_MISMATCH', `requested ${capacitySteps} steps but CPU reports ${cpu.capacitySteps} steps`);
  }
  return cpu;
}

/** CRC32/ISO-HDLC detects container corruption, not PLC program validity. */
export function programCrc32(...parts) {
  let crc = 0xffffffff;
  for (const part of parts) {
    for (const byte of part) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function encodeProgramImage({ profile = ProgramProfile.Classic, capacitySteps, cpu: value, memory: memoryValue }) {
  const cpu = validateMetadata(profile, capacitySteps, value);
  const input = bytes(memoryValue);
  length(input, programMemoryLength(capacitySteps), 'program memory');
  const memory = Buffer.from(input);
  const headerLength = profile === ProgramProfile.Classic ? 32 : 40;
  const output = Buffer.alloc(headerLength + memory.length);
  MAGIC.copy(output);
  output.writeUInt16LE(profile === ProgramProfile.Classic ? 1 : 2, 8);
  output.writeUInt16LE(headerLength, 10);
  output.writeUInt16LE(capacitySteps, 12);
  output.writeUInt16LE(profile, 14);
  cpu.raw.copy(output, 16);
  output.writeUInt32LE(memory.length, 24);
  if (profile === ProgramProfile.Fx3uExtended8KReadOnly) {
    cpu.extendedRaw.copy(output, 28);
    output.writeUInt32LE(parameterAddress(profile), 32);
  }
  const checksumOffset = headerLength - 4;
  output.writeUInt32LE(programCrc32(output.subarray(0, checksumOffset), memory), checksumOffset);
  memory.copy(output, headerLength);
  return output;
}

export function decodeProgramImage(value) {
  const input = bytes(value);
  if (input.length > MAX_PROGRAM_CONTAINER_BYTES) {
    fail('PROGRAM_LENGTH', `program image exceeds ${MAX_PROGRAM_CONTAINER_BYTES} bytes`);
  }
  // Snapshot even SharedArrayBuffer-backed inputs before validating their CRC.
  // The fixed maximum is checked before this copy.
  const encoded = Buffer.from(input);
  if (encoded.length < 32) {
    fail('PROGRAM_LENGTH', `image header requires exactly 32 bytes, received ${encoded.length}`);
  }
  if (!encoded.subarray(0, 8).equals(MAGIC)) fail('PROGRAM_MAGIC', 'invalid FX program-image magic');
  const version = encoded.readUInt16LE(8);
  if (version !== 1 && version !== 2) fail('PROGRAM_VERSION', `unsupported program-image version: ${version}`);
  const headerLength = version === 1 ? 32 : 40;
  if (encoded.readUInt16LE(10) !== headerLength) {
    fail('PROGRAM_HEADER', `unsupported program-image header length: ${encoded.readUInt16LE(10)}`);
  }
  if (encoded.length < headerLength) {
    fail('PROGRAM_LENGTH', `image header requires exactly ${headerLength} bytes, received ${encoded.length}`);
  }
  const capacitySteps = encoded.readUInt16LE(12);
  const memoryLength = programMemoryLength(capacitySteps);
  const profile = encoded.readUInt16LE(14);
  if (version === 1 && profile !== ProgramProfile.Classic) {
    fail('PROGRAM_FLAGS', `unsupported program-image flags: 0x${profile.toString(16).padStart(4, '0')}`);
  }
  if (version === 2 && profile !== ProgramProfile.Fx3uExtended8KReadOnly) {
    fail('PROGRAM_PROFILE', `unsupported program-image profile: ${profile}`);
  }
  const declaredLength = encoded.readUInt32LE(24);
  if (declaredLength !== memoryLength) {
    fail('PROGRAM_LENGTH', `declared payload requires exactly ${memoryLength} bytes, received ${declaredLength}`);
  }
  length(encoded, headerLength + memoryLength, 'image');
  const payload = encoded.subarray(headerLength);
  const checksumOffset = headerLength - 4;
  if (programCrc32(encoded.subarray(0, checksumOffset), payload) !== encoded.readUInt32LE(checksumOffset)) {
    fail('PROGRAM_CHECKSUM', 'program-image CRC32 mismatch');
  }
  if (version === 2 && encoded.readUInt32LE(32) !== parameterAddress(profile)) {
    fail('PROGRAM_PROFILE_MISMATCH', 'program-image address does not match its profile');
  }
  const cpu = validateMetadata(profile, capacitySteps,
    parseCpuInfo(encoded.subarray(16, 24), version === 2 ? encoded.subarray(28, 32) : null));
  // All input lengths and provenance are now bounded and validated.
  return {
    profile, parameterAddress: parameterAddress(profile), capacitySteps, cpu,
    memory: Buffer.from(payload), parameters: parseParameters(payload.subarray(0, PARAMETER_BYTES)),
  };
}

/** Inspect a validated binary container offline; returned bytes are copies. */
export function inspectProgramImage(encoded) {
  return decodeProgramImage(encoded);
}

/** Internal workflow helper: compare already decoded/captured image objects. */
export function compareDecodedImages(left, right) {
  const a = bytes(left.memory);
  const b = bytes(right.memory);
  length(a, programMemoryLength(left.capacitySteps), 'left program memory');
  length(b, programMemoryLength(right.capacitySteps), 'right program memory');
  const base = parameterAddress(left.profile);
  const profileMatches = left.profile === profileValue(right.profile);
  const capacityMatches = left.capacitySteps === right.capacitySteps;
  const cpuMatches = sameCpuIdentity(left.cpu, right.cpu);
  const metadataMatches = profileMatches && capacityMatches && cpuMatches;
  let changedBytes = 0;
  let start = null;
  let rangesTruncated = false;
  const ranges = [];
  const maxLength = Math.max(a.length, b.length);
  for (let offset = 0; offset <= maxLength; offset++) {
    if (offset < maxLength && a[offset] !== b[offset]) {
      changedBytes++;
      if (start === null) start = offset;
    } else if (start !== null) {
      if (ranges.length < MAX_CHANGED_RANGES) ranges.push({ address: base + start, length: offset - start });
      else rangesTruncated = true;
      start = null;
    }
  }
  return {
    identical: metadataMatches && changedBytes === 0, metadataMatches,
    profileMatches, capacityMatches, cpuMatches, changedBytes, rangesTruncated, ranges,
  };
}

export function compareProgramImages(left, right) {
  return compareDecodedImages(decodeProgramImage(left), decodeProgramImage(right));
}
