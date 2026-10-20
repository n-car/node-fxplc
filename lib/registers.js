// registers.js
// Classic FX programming-port map: Mitsubishi FX-232AW BT5096-C, tables 1-7.
// This is a bounded address profile, not a declaration of device availability
// or write permission on every FX CPU.

export const RegisterType = Object.freeze({
  State: 'S',
  Input: 'X',
  Output: 'Y',
  Timer: 'T',
  Memory: 'M',
  Data: 'D',
  Counter: 'C'
});

// Ordinary segment bases only. Use RegisterDef methods for octal labels,
// special M/D areas, and 32-bit counters.
export const registersMapBitImages = Object.freeze({
  S: [0x0000, 8],
  X: [0x0080, 8],
  Y: [0x00a0, 8],
  T: [0x00c0, 8],
  M: [0x0100, 8],
  C: [0x01c0, 8]
});

export const registersMapData = Object.freeze({
  T: 0x0800,
  C: 0x0a00,
  D: 0x1000
});

export const registersMapBits = Object.freeze({
  S: [0x0000, 8],
  X: [0x0400, 8],
  Y: [0x0500, 8],
  T: [0x0600, 8],
  M: [0x0800, 8],
  C: [0x0e00, 8]
});

export class RegisterDef {
  /**
   * @param {string} regType Single-letter register type (e.g. 'M','D','X')
   * @param {number} num Device label number; X100 means octal 100.
   */
  constructor(regType, num) {
    if (!Object.values(RegisterType).includes(regType) || !Number.isSafeInteger(num) || num < 0)
      throw new Error('Invalid register definition');
    const octal = regType === 'X' || regType === 'Y';
    if (octal && !/^[0-7]+$/.test(String(num)))
      throw new Error('Invalid octal X/Y register number');
    const valid = octal ? num <= 177
      : regType === 'S' ? num <= 999
      : regType === 'T' || regType === 'C' ? num <= 255
      : regType === 'M' ? num <= 1023 || (num >= 8000 && num <= 8255)
      : num <= 511 || (num >= 8000 && num <= 8255);
    if (!valid) throw new Error('Register outside the documented classic FX address profile');
    this.type = regType;
    this.num = num;
    Object.freeze(this);
  }
  toString() { return `${this.type}${this.num}`; }
  /**
   * Returns tuple [byteAddress, bitIndex] inside the bit image area.
   * D registers do not name bit contacts: use readNumber/readBytes instead.
   */
  getBitImageAddress() {
    const info = registersMapBitImages[this.type];
    if (!info) throw new Error('Unsupported register type for bit image: ' + this.type);
    const special = this.type === 'M' && this.num >= 8000;
    const topAddress = special ? 0x01e0 : info[0];
    const ordinal = special ? this.num - 8000 : this._ordinal();
    const byteAddr = topAddress + Math.floor(ordinal / 8);
    const bit = ordinal % 8;
    return [byteAddr, bit];
  }
  /** Absolute byte address of the current numeric value. */
  getDataAddress(size = 2) {
    let address, end;
    if (this.type === 'T') {
      address = 0x0800 + this.num * 2; end = 0x0a00;
    } else if (this.type === 'C') {
      address = this.num < 200 ? 0x0a00 + this.num * 2 : 0x0c00 + (this.num - 200) * 4;
      end = this.num < 200 ? 0x0b90 : 0x0ce0;
    } else if (this.type === 'D') {
      address = this.num < 8000 ? 0x1000 + this.num * 2 : 0x0e00 + (this.num - 8000) * 2;
      end = this.num < 8000 ? 0x1400 : 0x1000;
    } else {
      throw new Error('Unsupported register type for numeric data: ' + this.type);
    }
    if (!Number.isInteger(size) || size < 1 || size > 64 || address + size > end)
      throw new Error('Numeric span must contain 1..64 bytes within its documented register segment');
    return address;
  }
  /** DEVICE ADDRESS used by FORCE ON/OFF (encoded little-endian on the wire). */
  getForceAddress() {
    if (this.type === 'M' && this.num >= 8000) return 0x0f00 + this.num - 8000;
    const info = registersMapBits[this.type];
    if (!info) throw new Error('Unsupported register type for force: ' + this.type);
    return info[0] + this._ordinal();
  }
  _ordinal() {
    return this.type === 'X' || this.type === 'Y' ? parseInt(String(this.num), 8) : this.num;
  }
  /** Parses a textual definition like 'D100' into a RegisterDef */
  static parse(definition) {
    if (typeof definition !== 'string' || !/^[SXYTMDC][0-9]+$/.test(definition))
      throw new Error('Invalid definition');
    const regType = definition[0];
    const num = parseInt(definition.slice(1), 10);
    return new RegisterDef(regType, num);
  }
}

export const Commands = Object.freeze({
  BYTE_READ: 0,
  BYTE_WRITE: 1,
  FORCE_ON: 7,
  FORCE_OFF: 8
});
