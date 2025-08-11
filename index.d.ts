// TypeScript type declarations for node-fxplc
// Auto-generated lightweight definitions (manual). Refine as API evolves.

import { EventEmitter } from 'events';

export interface RetryOptions { count: number; delayMs: number; }

export interface FXPLCClientOptions {
  retry?: RetryOptions;
  debug?: boolean;
  timeoutMs?: number;
}

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
  write(data: Buffer): Promise<void> | void;
  read(size: number): Promise<Buffer>;
  close?(): void;
  on?(event: string, listener: (...args: any[]) => void): any;
}

export class TransportTCP implements TransportLike {
  constructor(opts: { host: string; port: number; timeout?: number; flushDelay?: number });
  setReconnect(enabled: boolean, delayMs?: number): void;
  connect(): Promise<void>;
  write(data: Buffer): Promise<void>;
  read(size: number): Promise<Buffer>;
  close(): void;
}

export class TransportSerial implements TransportLike {
  constructor(opts: { path: string; baudRate?: number; timeout?: number });
  write(data: Buffer): Promise<void>;
  read(size: number): Promise<Buffer>;
  close(): void;
}

export class TransportNull implements TransportLike {
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
  readBytes(address: number, count: number, cb: (err: Error | null, value?: Buffer) => void): void;
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
