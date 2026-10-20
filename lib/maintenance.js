// JavaScript maintenance workflows for explicitly selected program profiles.
// Wire primitives share the client's lock for the entire workflow.
import {
  ProgramProfile, parseCpuInfo, parseParameters, validateProfileCpu,
  sameCpuIdentity, programMemoryLength, parameterAddress, encodeProgramImage,
  decodeProgramImage, compareDecodedImages,
} from './program-image.js';
import { prepareMonitor, configureMonitor, readMonitor, stopMonitor } from './monitor.js';

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code }, details);
}
function copyImage(image) {
  // Bound copies before accepting caller-owned data into an asynchronous job.
  if (!(image instanceof Uint8Array)) throw failure('invalid_type', 'Expected a Uint8Array image');
  if (image.length > 16136) throw failure('invalid_range', 'Program image exceeds maximum size');
  return Buffer.from(image);
}
function equal(a, b) { return Buffer.from(a).equals(Buffer.from(b)); }

export class MaintenanceClient {
  constructor(client, profile = ProgramProfile.Classic) {
    if (profile !== ProgramProfile.Classic && profile !== ProgramProfile.Fx3uExtended8KReadOnly)
      throw failure('invalid_program_profile', 'Expected a ProgramProfile member');
    this.client = client;
    this.profile = profile;
    this.monitor = undefined;
    this.previous = undefined;
    this.acknowledged = 0;
  }

  get preRestoreImage() { return this.previous && Buffer.from(this.previous); }
  get acknowledgedWriteBytes() { return this.acknowledged; }

  _transport() {
    const transport = this.client.transport;
    if (!transport || typeof transport.write !== 'function' || typeof transport.read !== 'function' ||
        !Number.isSafeInteger(transport.availableBytes) || transport.availableBytes < 0)
      throw failure('transport_contract', 'Maintenance and E0 require read/write and a nonnegative integer availableBytes getter');
  }
  _mutable() {
    if (this.profile !== ProgramProfile.Classic)
      throw failure('profile_read_only', 'Extended profile permits information, backup and comparison only');
  }
  _matching(image) {
    if (image.profile !== this.profile) throw failure('profile_mismatch', 'Image and client profiles differ');
  }
  _capacity(steps) {
    const length = programMemoryLength(steps);
    if (this.profile === ProgramProfile.Fx3uExtended8KReadOnly && steps !== 8000)
      throw failure('capacity_mismatch', 'Extended profile supports only the observed 8K window');
    return length;
  }
  _writable(cpu, steps) {
    if (cpu.capacitySteps !== steps) throw failure('capacity_mismatch', 'CPU capacity differs from the image');
    if (!['ram_cassette', 'eeprom_unprotected', 'internal_memory'].includes(cpu.memoryKind))
      throw failure('memory_not_writable', 'Memory is protected, ROM or unknown');
  }

  _run(prepare, execute, raw = false) {
    return this.client._lock.run(async () => {
      if (this.client._faulted) throw failure('session_poisoned', 'Create a new client with a new clean transport');
      this._transport();
      const input = prepare(); // Every preflight failure occurs before I/O.
      let started = false;
      const call = async (method, ...args) => {
        started = true;
        this._transport();
        return this.client[method](...args);
      };
      const io = {
        readBytes: (address, count) => call('_readBytesUnlocked', address, count),
        writeBytes: (address, bytes) => call('_writeBytesUnlocked', address, bytes),
        readExtendedBytes: (address, count) => call('_extendedReadUnlocked', address, count),
      };
      try {
        return await execute(io, input);
      } catch (error) {
        // Only standalone E0 keeps a synchronized NAK usable. A failed
        // maintenance workflow invalidates ownership and requires reconnection.
        if (started && !(raw && error.code === 'nak' && !this.client._faulted)) {
          this.monitor = undefined;
          try { this.client.close(); } catch { this.client._faulted = true; }
        }
        throw error;
      }
    });
  }

  readExtendedBytes(address, count) {
    return this._run(() => {
      if (!Number.isInteger(address) || address < 0 || address > 0xfffff ||
          !Number.isInteger(count) || count < 1 || count > 64 || address + count > 0x100000)
        throw failure('invalid_range', 'E0 requires a 20-bit address and a complete span of 1..64 bytes');
    }, io => io.readExtendedBytes(address, count), true);
  }
  async _cpu(io, steps, restoring = false) {
    const raw = await io.readBytes(0x0e00, 8);
    const extended = this.profile === ProgramProfile.Fx3uExtended8KReadOnly
      ? await io.readBytes(0x0eca, 4) : null;
    const cpu = parseCpuInfo(raw, extended);
    validateProfileCpu(this.profile, cpu);
    if (steps !== undefined && cpu.capacitySteps !== steps)
      throw failure('capacity_mismatch', 'CPU capacity is unsupported or differs from requested capacity');
    if (restoring) this._writable(cpu, steps);
    return cpu;
  }
  async _verifyCpu(io, cpu) {
    const current = parseCpuInfo(await io.readBytes(0x0e00, 8), cpu.extendedRaw);
    if (!sameCpuIdentity(cpu, current)) throw failure('cpu_changed', 'CPU identity, capacity or memory type changed');
    if (cpu.extendedRaw !== null && !equal(cpu.extendedRaw, await io.readBytes(0x0eca, 4)))
      throw failure('cpu_changed', 'Extended CPU identity or capacity changed');
  }
  _readMemory(io, address, count) {
    return this.profile === ProgramProfile.Classic
      ? io.readBytes(address, count) : io.readExtendedBytes(address, count);
  }
  async _stopped(io) {
    if ((await io.readBytes(0x01e0, 1))[0] & 1)
      throw failure('plc_running', 'Restore requires M8000 OFF and the PLC held physically in STOP');
  }
  async _capture(io, steps, restoring = false) {
    const cpu = await this._cpu(io, steps, restoring);
    if (restoring) await this._stopped(io);
    const memory = Buffer.alloc(programMemoryLength(steps));
    const base = parameterAddress(this.profile);
    for (let pass = 0; pass < 2; pass++) {
      for (let offset = 0; offset < memory.length; offset += 64) {
        const bytes = await this._readMemory(io, base + offset, Math.min(64, memory.length - offset));
        if (pass === 0) bytes.copy(memory, offset);
        else {
          const mismatch = bytes.findIndex((byte, i) => byte !== memory[offset + i]);
          if (mismatch !== -1) throw failure('snapshot_changed', 'Memory changed between capture passes', { address: base + offset + mismatch });
        }
      }
    }
    await this._verifyCpu(io, cpu);
    if (restoring) await this._stopped(io);
    return { profile: this.profile, parameterAddress: base, capacitySteps: steps, cpu, memory, parameters: parseParameters(memory.subarray(0, 92)) };
  }

  readInformation() {
    return this._run(() => {}, async io => {
      const cpu = await this._cpu(io);
      const base = parameterAddress(this.profile);
      const raw = Buffer.concat([await this._readMemory(io, base, 64), await this._readMemory(io, base + 64, 28)]);
      await this._verifyCpu(io, cpu);
      return { cpu, parameters: parseParameters(raw) };
    });
  }
  backup(steps) {
    return this._run(() => this._capacity(steps), async io => encodeProgramImage(await this._capture(io, steps)));
  }
  async compare(encoded) {
    const bytes = copyImage(encoded);
    return this._run(() => {
      const image = decodeProgramImage(bytes);
      this._matching(image);
      this._capacity(image.capacitySteps);
      return image;
    }, async (io, image) => compareDecodedImages(image, await this._capture(io, image.capacitySteps)));
  }
  async restore(encoded, options) {
    const bytes = copyImage(encoded);
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw failure('invalid_type', 'Restore options must be an object');
    const beforeWrite = options.beforeWrite;
    if (beforeWrite !== undefined && typeof beforeWrite !== 'function')
      throw failure('invalid_type', 'beforeWrite must be a function');
    return this._run(() => {
      const image = decodeProgramImage(bytes);
      this._matching(image);
      this._mutable();
      this._writable(image.cpu, image.capacitySteps);
      return image;
    }, async (io, image) => {
      this.previous = undefined;
      this.acknowledged = 0;
      const previous = await this._capture(io, image.capacitySteps, true);
      this.previous = encodeProgramImage(previous);
      if (!sameCpuIdentity(image.cpu, previous.cpu)) throw failure('cpu_changed', 'Source and target CPU metadata differ');
      this._writable(previous.cpu, image.capacitySteps);
      if (image.parameters.memorySettingRaw !== previous.parameters.memorySettingRaw)
        throw failure('parameter_layout_mismatch', 'Source and target memory settings differ');
      if (!equal(image.parameters.entryCodeRaw, previous.parameters.entryCodeRaw))
        throw failure('entry_code_mismatch', 'Source and target entry-code fields differ');
      const comparison = compareDecodedImages(image, previous);
      if (comparison.changedBytes && beforeWrite) {
        await this.client._withTimeout(async check => {
          check();
          await beforeWrite(this.preRestoreImage);
          check();
        }, this.client._timeoutMs);
      }
      // Program first, parameters next, memory setting then original sum data.
      for (const [start, end] of [[92, image.memory.length], [4, 92], [0, 2], [2, 4]]) {
        for (let offset = start; offset < end;) {
          if (image.memory[offset] === previous.memory[offset]) { offset++; continue; }
          const begin = offset;
          while (offset < end && offset - begin < 64 && image.memory[offset] !== previous.memory[offset]) offset++;
          const address = 0x8000 + begin;
          const expected = image.memory.subarray(begin, offset);
          await this._stopped(io);
          await io.writeBytes(address, expected);
          this.acknowledged += expected.length;
          await this._verifyBytes(io, address, expected);
        }
      }
      await this._stopped(io);
      for (let offset = 0; offset < image.memory.length; offset += 64)
        await this._verifyBytes(io, 0x8000 + offset, image.memory.subarray(offset, offset + 64));
      await this._verifyCpu(io, previous.cpu);
      await this._stopped(io);
      return { changedBytes: comparison.changedBytes, verifiedBytes: image.memory.length };
    });
  }
  async _verifyBytes(io, address, expected) {
    const actual = await io.readBytes(address, expected.length);
    const offset = actual.findIndex((byte, i) => byte !== expected[i]);
    if (offset !== -1) throw failure('verify_mismatch', 'Restore readback differs from requested bytes', { address: address + offset });
  }
  async configureMonitor(config) {
    // Copy input arrays before queuing so caller edits cannot alter a job.
    const saved = config && {
      ...config,
      numericRegisters: Array.isArray(config.numericRegisters) ? config.numericRegisters.slice() : config.numericRegisters,
      numberTypes: Array.isArray(config.numberTypes) ? config.numberTypes.slice() : config.numberTypes,
      bitRegisters: Array.isArray(config.bitRegisters) ? config.bitRegisters.slice() : config.bitRegisters,
    };
    return this._run(() => { this._mutable(); prepareMonitor(saved); return saved; }, async (io, input) => {
      this.monitor = await configureMonitor(io, input);
    });
  }
  readMonitor() {
    return this._run(() => {
      this._mutable();
      if (!this.monitor) throw failure('monitor_not_configured', 'Configure the monitor on this client first');
      return this.monitor;
    }, (io, state) => readMonitor(io, state));
  }
  stopMonitor() {
    return this._run(() => {
      this._mutable();
      if (!this.monitor) throw failure('monitor_not_configured', 'Configure the monitor on this client first');
      return this.monitor;
    }, async (io, state) => { await stopMonitor(io, state); this.monitor = undefined; });
  }
}
