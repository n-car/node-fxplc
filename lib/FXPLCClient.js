// ESM source version of FXPLCClient with simplified lazy debug loader
import { Commands, RegisterDef } from './registers.js';
import { EventEmitter } from 'events';
import { NumberType, NumberTypeConverters } from './number-types.js';
import { AsyncLock } from './async-lock.js';
import { calcChecksum } from './protocol-utils.js';
import { NoResponseError, ResponseMalformedError, NotSupportedCommandError } from './errors.js';

const STX = 0x02; const ETX = 0x03; const NAK = 0x15; const ACK = 0x06;
const MAX_DATA_BYTES = 64; // FX-232AW BT5096-C, READ/WRITE, PDF pp. 10-12.

function checkSpan(address, count) {
    if (!Number.isInteger(address) || address < 0 || address > 0xffff ||
        !Number.isInteger(count) || count < 1 || count > MAX_DATA_BYTES ||
        address + count > 0x10000)
        throw new RangeError('Expected a 16-bit address and 1..64 bytes without address overflow');
}

// Validate the entire batch before sending anything. Adjacent device labels
// are not necessarily adjacent values (D words and C200+ have different strides).
function prepareBatch(registers, converter) {
    const entries = registers.map(register => {
        const reg = register instanceof RegisterDef ? register : RegisterDef.parse(register);
        return { reg, address: reg.getDataAddress(converter.size) };
    });
    const groups = [];
    entries.forEach((entry, index) => {
        let group = groups[groups.length - 1];
        if (!group || group.type !== entry.reg.type ||
            group.address + group.count * converter.size !== entry.address ||
            (group.count + 1) * converter.size > MAX_DATA_BYTES) {
            group = { address: entry.address, type: entry.reg.type, start: index, count: 0 };
            groups.push(group);
        }
        group.count++;
    });
    return groups;
}

// Minimal lazy loader: tries require (CJS build) else falls back to no-op.
let _dbgFn = null;
function getDbg() {
    if (_dbgFn) return _dbgFn;
    if (typeof require === 'function') {
        try { _dbgFn = require('debug')('fxplc:client'); return _dbgFn; } catch { /* ignore */ }
    }
    _dbgFn = (..._a) => {};
    return _dbgFn;
}

function bufferToHex(buf){ return buf.toString('hex'); }
/**
 * FXPLCClient - High-level helper for Mitsubishi FX0N / FX1N style framed protocol.
 * Options:
 *  - retry: retained for API compatibility; commands are never replayed.
 *  - debug: boolean (enable frame logging)
 *  - timeoutMs: per-operation timeout (default 2000ms)
 */
export class FXPLCClient extends EventEmitter {
    constructor(transport, opts = {}) {
                super();
                this.transport = transport;
                this._lock = new AsyncLock();
                this._retry = opts.retry || { count: 1, delayMs: 100 };
                this._debug = opts.debug || false;
                this._timeoutMs = opts.timeoutMs || 2000;
                this._faulted = false;
                if (transport && typeof transport.on === 'function') {
                    transport.on('connect', (...a)=>this.emit('connect', ...a));
                    transport.on('disconnect', (...a)=>this.emit('disconnect', ...a));
                    transport.on('error', (e)=>this.emit('error', e));
                }
    }
    /** Close underlying transport (if it supports close) and emit disconnect */
    close(){
        this._faulted = true;
        if (this.transport && this.transport.setReconnect) this.transport.setReconnect(false);
        if (this.transport && this.transport.close) this.transport.close();
        this.emit('disconnect');
    }
    /** Batch read registers; coalesces consecutive addresses where possible */
    batchRead(registers, numberType = NumberType.WordSigned, cb) {
        if (typeof numberType === 'function') {
            cb = numberType;
        numberType = NumberType.WordSigned;
        }
        const prom = (async () => {
            if (!Array.isArray(registers) || registers.length === 0)
                return [];
        if (!NumberTypeConverters[numberType])
                throw new Error('batchRead: numberType non supportato');
            const conv = NumberTypeConverters[numberType];
            const groups = prepareBatch(registers, conv);
            const out = [];
            for (const group of groups) {
                const data = await this.readBytes(group.address, conv.size * group.count);
                for (let i = 0; i < group.count; ++i) out.push(conv.read(data, i * conv.size));
            }
            return out;
        })();
        if (cb)
            prom.then(r => cb(null, r)).catch(e => cb(e));
        else
            return prom;
    }
    /** Batch write registers; packs consecutive region into single write */
    batchWrite(registers, values, numberType = NumberType.WordSigned, cb) {
        if (typeof numberType === 'function') {
            cb = numberType;
        numberType = NumberType.WordSigned;
        }
        const prom = (async () => {
            if (!Array.isArray(registers) || registers.length === 0)
                return;
            if (!Array.isArray(values) || values.length !== registers.length)
                throw new Error('batchWrite: valori non corrispondenti ai registri');
        if (!NumberTypeConverters[numberType])
                throw new Error('batchWrite: numberType non supportato');
            const conv = NumberTypeConverters[numberType];
            const groups = prepareBatch(registers, conv).map(group => {
                const buf = Buffer.alloc(conv.size * group.count);
                for (let i = 0; i < group.count; ++i) conv.write(buf, i * conv.size, values[group.start + i]);
                return { address: group.address, buf };
            });
            for (const group of groups) await this.writeBytes(group.address, group.buf);
        })();
        if (cb)
            prom.then(() => cb(null)).catch(e => cb(e));
        else
            return prom;
    }
    /** Read a single bit (e.g. 'M10') */
    readBit(register, cb) {
        const prom = (async () => {
            if (!register)
                throw new Error('readBit: registro mancante');
            let reg;
            try {
                reg = register instanceof RegisterDef ? register : RegisterDef.parse(register);
            }
            catch {
                throw new Error('readBit: registro non valido: ' + register);
            }
            return await this._withRetry(async () => {
                const [addr, bit] = reg.getBitImageAddress();
                const bytes = await this.readBytes(addr, 1);
                if (bytes.length !== 1) throw new ResponseMalformedError();
                return (bytes[0] & (1 << bit)) !== 0;
            }, 'readBit');
        })();
        if (cb)
            prom.then(r => cb(null, r)).catch(e => cb(e));
        else
            return prom;
    }
    /** Force a single bit ON/OFF (e.g. 'M10', true) */
    writeBit(register, value, cb) {
        const prom = (async () => {
            if (!register)
                throw new Error('writeBit: registro mancante');
            let reg;
            try {
                reg = register instanceof RegisterDef ? register : RegisterDef.parse(register);
            }
            catch {
                throw new Error('writeBit: registro non valido: ' + register);
            }
            return await this._withRetry(async () => {
                const addr = reg.getForceAddress();
                const buf = Buffer.alloc(2);
                buf.writeUInt16LE(addr, 0);
                await this._sendCommand(value ? Commands.FORCE_ON : Commands.FORCE_OFF, buf);
            }, 'writeBit');
        })();
        if (cb)
            prom.then(() => cb(null)).catch(e => cb(e));
        else
            return prom;
    }
    /** Convenience: read signed word */
    readInt(register, cb){ if (cb) this.readNumber(register, NumberType.WordSigned).then(r=>cb(null,r)).catch(e=>cb(e)); else return this.readNumber(register, NumberType.WordSigned); }
    /** Read a numeric value using a given NumberType */
    readNumber(register, numberType = NumberType.WordSigned, cb) {
        if (typeof numberType === 'function') {
            cb = numberType;
            numberType = NumberType.WordSigned;
        }
        const prom = (async () => {
            if (!register)
                throw new Error('readNumber: registro mancante');
            if (!NumberTypeConverters[numberType])
                throw new Error('readNumber: numberType non supportato');
            let reg;
            try {
                reg = register instanceof RegisterDef ? register : RegisterDef.parse(register);
            }
            catch {
                throw new Error('readNumber: registro non valido: ' + register);
            }
            return await this._withRetry(async () => {
                const conv = NumberTypeConverters[numberType];
                const addr = reg.getDataAddress(conv.size);
                const data = await this.readBytes(addr, conv.size);
                if (data.length !== conv.size) throw new ResponseMalformedError();
                return conv.read(data, 0);
            }, 'readNumber');
        })();
        if (cb)
            prom.then(r => cb(null, r)).catch(e => cb(e));
        else
            return prom;
    }
    /** Write a numeric value using a given NumberType */
    writeNumber(register, value, numberType = NumberType.WordSigned, cb) {
        if (typeof numberType === 'function') {
            cb = numberType;
            numberType = NumberType.WordSigned;
        }
        const prom = (async () => {
            if (!register)
                throw new Error('writeNumber: registro mancante');
            if (!NumberTypeConverters[numberType])
                throw new Error('writeNumber: numberType non supportato');
            let reg;
            try {
                reg = register instanceof RegisterDef ? register : RegisterDef.parse(register);
            }
            catch {
                throw new Error('writeNumber: registro non valido: ' + register);
            }
            return await this._withRetry(async () => {
                const conv = NumberTypeConverters[numberType];
                const addr = reg.getDataAddress(conv.size);
                const buf = Buffer.alloc(conv.size);
                conv.write(buf, 0, value);
                await this.writeBytes(addr, buf);
            }, 'writeNumber');
        })();
        if (cb)
            prom.then(() => cb(null)).catch(e => cb(e));
        else
            return prom;
    }
    /** Read raw bytes from absolute PLC address */
    readBytes(addr, count = 1, cb) {
        if (typeof count === 'function') {
            cb = count;
            count = 1;
        }
        const prom = this._withRetry(async () => {
            checkSpan(addr, count);
            const req = Buffer.alloc(3); // struct ">HB" big endian: H=2 bytes, B=1
            req.writeUInt16BE(addr, 0);
            req.writeUInt8(count, 2);
            const data = await this._sendCommand(Commands.BYTE_READ, req);
            if (data.length !== count) throw new ResponseMalformedError('Unexpected READ response length');
            return data;
        }, 'readBytes');
        if (cb)
            prom.then(r => cb(null, r)).catch(e => cb(e));
        else
            return prom;
    }
    /** Write raw bytes to absolute PLC address */
    writeBytes(addr, values, cb) {
        const prom = this._withRetry(async () => {
            if (!Buffer.isBuffer(values)) throw new TypeError('writeBytes expects a Buffer');
            checkSpan(addr, values.length);
            const req = Buffer.alloc(3 + values.length);
            req.writeUInt16BE(addr, 0);
            req.writeUInt8(values.length, 2);
            values.copy(req, 3);
            await this._sendCommand(Commands.BYTE_WRITE, req);
        }, 'writeBytes');
        if (typeof values === 'function') {
            cb = values;
            values = null;
        }
        if (cb)
            prom.then(() => cb(null)).catch(e => cb(e));
        else
            return prom;
    }
    /** Convenience: write signed word */
    writeInt(register, value, cb){ if (cb) this.writeNumber(register, value, NumberType.WordSigned).then(()=>cb(null)).catch(e=>cb(e)); else return this.writeNumber(register, value, NumberType.WordSigned); }
    // --- Internals ---
    async _withRetry(fn, opname){
        // A timeout/corrupt stream cannot safely be retried: FX has no
        // transaction IDs, and a late ACK could belong to the first write.
        // Keep this internal hook for compatibility, but execute exactly once.
        return await fn();
    }
    async _withTimeout(fn, timeoutMs){
        let timer;
        try {
            return await Promise.race([
                fn(),
                new Promise((_, reject) => {
                    timer = setTimeout(() => reject(new NoResponseError('Operation timeout')), timeoutMs);
                })
            ]);
        } finally {
            clearTimeout(timer);
        }
    }
    _assertNoBufferedData() {
        // Optional for legacy custom transports. Built-in transports expose
        // their accumulator count, allowing duplicate/trailing bytes to fault
        // the current command instead of acknowledging a later mutation.
        const available = this.transport.availableBytes;
        if (available !== undefined && (!Number.isSafeInteger(available) || available !== 0))
            throw new ResponseMalformedError('Unexpected buffered input outside a response');
    }
    async _sendCommand(cmd, data){
        return this._lock.run(async () => {
            if (this._faulted) throw new NoResponseError('A new client and clean transport are required');
            const cmdAscii = Buffer.from([(0x30) + cmd]);
            const payloadHex = data.toString('hex').toUpperCase();
            const payload = Buffer.concat([cmdAscii, Buffer.from(payloadHex,'ascii')]);
            const frameNoChecksum = Buffer.concat([Buffer.from([STX]), payload, Buffer.from([ETX])]);
            const checksum = calcChecksum(Buffer.concat([payload, Buffer.from([ETX])]));
            const frame = Buffer.concat([frameNoChecksum, checksum]);
            if (this._debug) getDbg()('TX', bufferToHex(frame));
            try {
                return await this._withTimeout(async () => {
                    this._assertNoBufferedData();
                    await this.transport.write(frame);
                    if (this._faulted) throw new NoResponseError('Transport is no longer usable');
                    const response = await this._readResponse();
                    this._assertNoBufferedData();
                    if (cmd === Commands.BYTE_READ ? response.length !== data[2] : response.length !== 0)
                        throw new ResponseMalformedError('Unexpected response kind or length');
                    return response;
                }, this._timeoutMs);
            } catch (error) {
                if (!(error instanceof NotSupportedCommandError)) {
                    // Closing also aborts accumulator reads. A caller must create
                    // a fresh client/transport; changing transport on this object
                    // does not clear the fault.
                    try { this.close(); } catch { this._faulted = true; }
                }
                if (this._debug) console.warn('[FXPLCClient] command failed:', error);
                if (this.listenerCount('error') > 0) this.emit('error', error);
                throw error;
            }
        });
    }
    async _readResponse(){
        const first = await this.transport.read(1);
        if (first.length === 0) throw new NoResponseError();
        const code = first[0];
        if (code === STX) {
            const hexParts = [];
            while (true) {
                const b = await this.transport.read(1);
                if (b.length === 0) throw new ResponseMalformedError();
                if (b[0] === ETX) break;
                if (hexParts.length >= MAX_DATA_BYTES * 2 ||
                    !((b[0] >= 0x30 && b[0] <= 0x39) || (b[0] >= 0x41 && b[0] <= 0x46) || (b[0] >= 0x61 && b[0] <= 0x66)))
                    throw new ResponseMalformedError('Invalid or oversized hexadecimal response');
                hexParts.push(b);
            }
            const hexBuf = Buffer.concat(hexParts);
            const checksum = await this.transport.read(2);
            if (checksum.length !== 2) throw new ResponseMalformedError();
            if (!calcChecksum(Buffer.concat([hexBuf, Buffer.from([ETX])])).equals(checksum)) throw new ResponseMalformedError('Wrong checksum');
            if (hexBuf.length === 0 || hexBuf.length % 2 !== 0)
                throw new ResponseMalformedError('Expected a nonempty whole-byte DATA response');
            const out = Buffer.from(hexBuf.toString('ascii'), 'hex');
            if (this._debug) getDbg()('RX', hexBuf.toString('ascii'), out.toString('hex'));
            return out;
        }
        else if (code === NAK) {
            this._assertNoBufferedData();
            throw new NotSupportedCommandError();
        }
        else if (code === ACK) {
            if (this._debug) getDbg()('RX ACK');
            return Buffer.alloc(0);
        }
        else {
            throw new ResponseMalformedError('Unknown response control byte');
        }
    }
}
// end class
