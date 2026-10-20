// TypeScript type declarations for node-fxplc
// Auto-generated lightweight definitions (manual). Refine as API evolves.

import { EventEmitter } from 'events';

/** Compatibility option: commands are no longer automatically replayed. */
export interface RetryOptions { count: number; delayMs: number; }

export interface FXPLCClientOptions {
  retry?: RetryOptions;
  debug?: boolean;
  timeoutMs?: number;
  /** Explicit maintenance layout. Defaults to ProgramProfile.Classic. */
  programProfile?: ProgramProfileName;
}

export const ProgramProfile: {
  readonly Classic: 0;
  readonly Fx3uExtended8KReadOnly: 1;
};

export type ProgramProfileName = typeof ProgramProfile[keyof typeof ProgramProfile];
export type ProgramCapacitySteps = 2000 | 4000 | 8000;

export interface CpuInformation {
  /** Raw D8000..D8003, little-endian. */
  raw: Uint8Array;
  d8001: number;
  d8002: number;
  d8003: number;
  /** Raw D8101/D8102; null for the classic profile. */
  extendedRaw: Uint8Array | null;
  d8101: number | null;
  d8102: number | null;
  capacitySteps: ProgramCapacitySteps | null;
  familyCode: number;
  versionRaw: number;
  memoryKind: 'ram_cassette' | 'rom_cassette' | 'eeprom_unprotected' |
    'eeprom_protected' | 'internal_memory' | 'unknown';
}

export interface ProgramParameters {
  raw: Uint8Array;
  memorySettingRaw: number;
  sumDataRaw: number;
  entryCodeRaw: Uint8Array;
  titleRaw: Uint8Array;
  fileRegisterAllocationRaw: Uint8Array;
  commentAllocationRaw: Uint8Array;
  latchRangesRaw: [number, number][];
}

export interface PLCInformation {
  cpu: CpuInformation;
  parameters: ProgramParameters;
}

export interface ChangedRange {
  /** Full byte address; extended ranges are above 0xFFFF. */
  address: number;
  length: number;
}

export interface ImageComparison {
  identical: boolean;
  metadataMatches: boolean;
  profileMatches: boolean;
  capacityMatches: boolean;
  cpuMatches: boolean;
  changedBytes: number;
  rangesTruncated: boolean;
  ranges: ChangedRange[];
}

export interface ProgramImageInspection extends PLCInformation {
  profile: ProgramProfileName;
  parameterAddress: number;
  capacitySteps: ProgramCapacitySteps;
  memory: Uint8Array;
}

export interface RestoreResult {
  changedBytes: number;
  verifiedBytes: number;
}

export interface RestoreOptions {
  /**
   * Persist the captured target image before the first write. Throw/reject to
   * cancel. Runs under the client lock and transaction timeout: do not call
   * other methods on the same client from this hook.
   */
  beforeWrite?: (preRestoreImage: Buffer) => void | Promise<void>;
}

/** Classic native-monitor layout; all addresses require target verification. */
export interface MonitorConfig {
  numericRegisters: string[];
  numberTypes: NumberTypeName[];
  bitRegisters: string[];
  bitCountAddress: number;
  bitTableAddress: number;
}

export interface MonitorSnapshot {
  numbers: Float64Array;
  bits: boolean[];
  numericBytes: Uint8Array;
  bitBytes: Uint8Array;
}

/** Validate and inspect a profile-tagged binary container without PLC I/O. */
export function inspectProgramImage(image: Uint8Array): ProgramImageInspection;
/** Compare validated containers offline, preserving their profile identities. */
export function compareProgramImages(left: Uint8Array, right: Uint8Array): ImageComparison;

export type NumberTypeName = 'WordSigned' | 'DoubleWordSigned' | 'WordUnsigned' | 'DoubleWordUnsigned' | 'Float';

export const NumberType: {
  WordSigned: NumberTypeName;
  DoubleWordSigned: NumberTypeName;
  WordUnsigned: NumberTypeName;
  DoubleWordUnsigned: NumberTypeName;
  Float: NumberTypeName;
};

export interface NumberTypeConverter {
  size: number;
  read(buffer: Buffer, offset?: number): number;
  write(buffer: Buffer, offset: number, value: number): void;
}

export interface TransportLike {
  /** Optional for legacy methods; required by E0 and maintenance methods. */
  readonly availableBytes?: number;
  write(data: Buffer): Promise<void> | void;
  read(size: number): Promise<Buffer>;
  close?(): void;
  on?(event: string, listener: (...args: any[]) => void): any;
}

export class TransportTCP implements TransportLike {
  readonly availableBytes: number;
  constructor(opts: { host: string; port: number; timeout?: number; flushDelay?: number });
  setReconnect(enabled: boolean, delayMs?: number): void;
  connect(): Promise<void>;
  write(data: Buffer): Promise<void>;
  read(size: number): Promise<Buffer>;
  close(): void;
}

export class TransportSerial implements TransportLike {
  readonly availableBytes: number;
  constructor(opts: { path: string; baudRate?: number; timeout?: number });
  write(data: Buffer): Promise<void>;
  read(size: number): Promise<Buffer>;
  close(): void;
}

export class TransportNull implements TransportLike {
  readonly availableBytes: number;
  write(data: Buffer): Promise<void>;
  read(size: number): Promise<Buffer>;
  close(): void;
}

export type RegisterTypeName = 'S' | 'X' | 'Y' | 'T' | 'M' | 'D' | 'C';

export class RegisterDef {
  readonly type: RegisterTypeName;
  readonly num: number;
  constructor(type: RegisterTypeName, num: number);
  toString(): string;
  getBitImageAddress(): [number, number];
  getDataAddress(size?: number): number;
  getForceAddress(): number;
  static parse(definition: string): RegisterDef;
}

export const Commands: {
  BYTE_READ: number;
  BYTE_WRITE: number;
  FORCE_ON: number;
  FORCE_OFF: number;
};

export class FXPLCClient extends EventEmitter {
  constructor(transport: TransportLike, opts?: FXPLCClientOptions);
  /** Target image captured before classic restore writes; retained on failure. */
  readonly preRestoreImage: Buffer | undefined;
  /** Acknowledged bytes only; a timed-out write may also have been applied. */
  readonly acknowledgedWriteBytes: number;
  close(): void;
  batchRead(registers: (string | RegisterDef)[], numberType?: NumberTypeName): Promise<number[]>;
  batchRead(registers: (string | RegisterDef)[], cb: (err: Error | null, values?: number[]) => void): void;
  batchRead(registers: (string | RegisterDef)[], numberType: NumberTypeName, cb: (err: Error | null, values?: number[]) => void): void;
  batchWrite(registers: (string | RegisterDef)[], values: number[], numberType?: NumberTypeName): Promise<void>;
  batchWrite(registers: (string | RegisterDef)[], values: number[], cb: (err: Error | null) => void): void;
  batchWrite(registers: (string | RegisterDef)[], values: number[], numberType: NumberTypeName, cb: (err: Error | null) => void): void;
  readBit(register: string | RegisterDef): Promise<boolean>;
  readBit(register: string | RegisterDef, cb: (err: Error | null, value?: boolean) => void): void;
  writeBit(register: string | RegisterDef, value: boolean): Promise<void>;
  writeBit(register: string | RegisterDef, value: boolean, cb: (err: Error | null) => void): void;
  readInt(register: string | RegisterDef): Promise<number>;
  readInt(register: string | RegisterDef, cb: (err: Error | null, value?: number) => void): void;
  readNumber(register: string | RegisterDef, numberType?: NumberTypeName): Promise<number>;
  readNumber(register: string | RegisterDef, cb: (err: Error | null, value?: number) => void): void;
  readNumber(register: string | RegisterDef, numberType: NumberTypeName, cb: (err: Error | null, value?: number) => void): void;
  writeNumber(register: string | RegisterDef, value: number, numberType?: NumberTypeName): Promise<void>;
  writeNumber(register: string | RegisterDef, value: number, cb: (err: Error | null) => void): void;
  writeNumber(register: string | RegisterDef, value: number, numberType: NumberTypeName, cb: (err: Error | null) => void): void;
  readBytes(address: number, count?: number): Promise<Buffer>;
  readBytes(address: number, cb: (err: Error | null, value?: Buffer) => void): void;
  readBytes(address: number, count: number, cb: (err: Error | null, value?: Buffer) => void): void;
  /** Explicit E0 raw read: 20-bit byte address, count 1..64. No fallback. */
  readExtendedBytes(address: number, count?: number): Promise<Buffer>;
  readExtendedBytes(address: number, cb: (err: Error | null, value?: Buffer) => void): void;
  readExtendedBytes(address: number, count: number, cb: (err: Error | null, value?: Buffer) => void): void;
  readInformation(): Promise<PLCInformation>;
  readInformation(cb: (err: Error | null, value?: PLCInformation) => void): void;
  backup(capacitySteps: ProgramCapacitySteps): Promise<Buffer>;
  backup(capacitySteps: ProgramCapacitySteps, cb: (err: Error | null, value?: Buffer) => void): void;
  compare(image: Uint8Array): Promise<ImageComparison>;
  compare(image: Uint8Array, cb: (err: Error | null, value?: ImageComparison) => void): void;
  /** Classic profile only. Keep the target stopped and exclude other programmers. */
  restore(image: Uint8Array, options?: RestoreOptions): Promise<RestoreResult>;
  restore(image: Uint8Array, cb: (err: Error | null, value?: RestoreResult) => void): void;
  restore(image: Uint8Array, options: RestoreOptions | undefined, cb: (err: Error | null, value?: RestoreResult) => void): void;
  configureMonitor(config: MonitorConfig): Promise<void>;
  configureMonitor(config: MonitorConfig, cb: (err: Error | null) => void): void;
  readMonitor(): Promise<MonitorSnapshot>;
  readMonitor(cb: (err: Error | null, value?: MonitorSnapshot) => void): void;
  stopMonitor(): Promise<void>;
  stopMonitor(cb: (err: Error | null) => void): void;
  writeBytes(address: number, data: Buffer): Promise<void>;
  writeBytes(address: number, data: Buffer, cb: (err: Error | null) => void): void;
  writeInt(register: string | RegisterDef, value: number): Promise<void>;
  writeInt(register: string | RegisterDef, value: number, cb: (err: Error | null) => void): void;
}

export class FXPLCClientMock extends FXPLCClient {}

// Errors
export class FXPLCError extends Error {}
export class NotSupportedCommandError extends FXPLCError {}
export class NoResponseError extends FXPLCError {}
export class ResponseMalformedError extends FXPLCError {}
export class NotConnectedError extends FXPLCError {}
