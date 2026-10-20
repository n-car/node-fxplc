import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FXPLCClient, NumberType, ProgramProfile, inspectProgramImage, compareProgramImages,
} from '../lib/index.js';

import { EXTENDED, PeerTransport, monitorConfig } from './helpers/engine-peer.js';

const reject = (run, code) => assert.rejects(async () => run(),
  code === undefined ? undefined : error => error.code === code);
const callback = run => new Promise((resolve, rejectPromise) => {
  run((error, value) => error ? rejectPromise(error) : resolve(value));
});

test('JavaScript E0 exact anchor, maximum address and callback overload', async () => {
  assert.equal(ProgramProfile.Classic, 0);
  assert.equal(EXTENDED, 1);
  const peer = new PeerTransport();
  const client = peer.client();
  assert.deepEqual(await client.readExtendedBytes(0x18000, 2), Buffer.from([16, 0]));
  assert.deepEqual(peer.frames[0], Buffer.from('02453031383030303032034433', 'hex'));
  peer.memory[0xfffff] = 0xa5;
  assert.deepEqual(await callback(cb => client.readExtendedBytes(0xfffff, cb)), Buffer.from([0xa5]));
  assert.equal(peer.requests.at(-1).count, 1);
  assert.ok(peer.readSizes.every(size => size === 1), 'the engine consumes byte-fragmented responses');
  peer.memory.fill(0x42, 0xfffc0);
  assert.deepEqual(await client.readExtendedBytes(0xfffc0, 64), Buffer.alloc(64, 0x42));
});

test('E0 validation rejects narrowing, type coercion and overflow before I/O', async () => {
  const peer = new PeerTransport();
  const client = peer.client();
  for (const address of [-1, 0x100000, 0x100000000, 0.5, NaN, Infinity, '98304', null, 1n])
    await reject(() => client.readExtendedBytes(address, 1));
  for (const count of [0, 65, -1, 1.5, NaN, Infinity, '2', null, 1n])
    await reject(() => client.readExtendedBytes(0x18000, count));
  await reject(() => client.readExtendedBytes(0xfffff, 2));
  for (const capacity of [2000, 4000, 0, 8000.5, '8000', null, NaN, Infinity])
    await reject(() => client.backup(capacity));
  assert.equal(peer.frames.length, 0);
  assert.equal(peer.closed, false);
  assert.deepEqual(await client.readExtendedBytes(0x18000, 2), Buffer.from([16, 0]));
});

test('extended information validates both CPU register sets and preserves parameters', async () => {
  const peer = new PeerTransport();
  const information = await callback(cb => peer.client().readInformation(cb));
  assert.equal(information.cpu.d8001, 24241);
  assert.equal(information.cpu.d8101, 16241);
  assert.equal(information.cpu.d8102, 8);
  assert.equal(information.cpu.capacitySteps, 8000);
  assert.deepEqual(Buffer.from(information.cpu.extendedRaw), peer.memory.subarray(0xeca, 0xece));
  assert.deepEqual(Buffer.from(information.parameters.raw), peer.memory.subarray(0x18000, 0x1805c));
  assert.deepEqual(peer.requests.map(({ command, address, count }) => [command, address, count]), [
    ['0', 0xe00, 8], ['0', 0xeca, 4], ['E0', 0x18000, 64],
    ['E0', 0x18040, 28], ['0', 0xe00, 8], ['0', 0xeca, 4],
  ]);
});

test('extended 8K backup performs two passes and supports file/offline/live comparison', async () => {
  const peer = new PeerTransport();
  const client = peer.client();
  const image = await client.backup(8000);
  assert.ok(Buffer.isBuffer(image));
  assert.equal(image.length, 16136);
  assert.equal(image.readUInt16LE(8), 2);
  assert.equal(image.readUInt16LE(10), 40);
  assert.equal(peer.requests.length, 508);
  const extendedReads = peer.requests.filter(request => request.command === 'E0');
  assert.equal(extendedReads.length, 504);
  assert.deepEqual(extendedReads.slice(0, 252), extendedReads.slice(252));
  assert.deepEqual(extendedReads.at(-1), { command: 'E0', address: 0x1bec0, count: 32, data: Buffer.alloc(0) });
  const details = inspectProgramImage(image);
  assert.equal(details.profile, EXTENDED);
  assert.equal(details.parameterAddress, 0x18000);
  assert.deepEqual(Buffer.from(details.memory), peer.memory.subarray(0x18000, 0x1bee0));
  assert.equal(compareProgramImages(image, image).identical, true);
  const directory = await mkdtemp(join(tmpdir(), 'node-fxplc-engine-'));
  try {
    const filename = join(directory, 'simulated.fxplcbk');
    await writeFile(filename, image);
    const restoredFile = await readFile(filename);
    assert.equal(compareProgramImages(image, restoredFile).identical, true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  peer.memory[0x18060] ^= 1;
  peer.memory[0x1bedf] ^= 1;
  const comparison = await callback(cb => client.compare(image, cb));
  assert.equal(comparison.identical, false);
  assert.equal(comparison.profileMatches, true);
  assert.equal(comparison.changedBytes, 2);
  assert.deepEqual(comparison.ranges, [
    { address: 0x18060, length: 1 }, { address: 0x1bedf, length: 1 },
  ]);
  const damaged = Buffer.from(image);
  damaged[100] ^= 1;
  assert.throws(() => inspectProgramImage(damaged), error => error.code === 'PROGRAM_CHECKSUM');
  assert.throws(() => compareProgramImages(image, damaged));
  const beforeInvalid = peer.requests.length;
  await reject(() => client.compare(damaged));
  assert.equal(peer.requests.length, beforeInvalid);
  assert.equal(peer.closed, false);
});

test('profile boundaries forbid extended mutations and crossing to classic', async () => {
  const peer = new PeerTransport();
  const client = peer.client();
  const image = await client.backup(8000);
  const before = peer.requests.length;
  await reject(() => client.restore(image), 'profile_read_only');
  await reject(() => client.configureMonitor(monitorConfig()), 'profile_read_only');
  await reject(() => client.readMonitor(), 'profile_read_only');
  await reject(() => client.stopMonitor(), 'profile_read_only');
  assert.equal(peer.requests.length, before);
  assert.equal(peer.closed, false);
  const classicPeer = new PeerTransport({ extended: false });
  const classic = classicPeer.client();
  await reject(() => classic.restore(image), 'profile_mismatch');
  await reject(() => classic.compare(image), 'profile_mismatch');
  assert.equal(classicPeer.requests.length, 0);
  assert.equal(classicPeer.closed, false);
});

test('CPU/capacity failures stop before E0 and require a new transport', async () => {
  for (const [d8101, d8102, d8002] of [[17241, 8, 8], [16241, 16, 8], [16241, 0, 8], [16241, 8, 4]]) {
    const peer = new PeerTransport();
    peer.memory.writeUInt16LE(d8101, 0xeca);
    peer.memory.writeUInt16LE(d8102, 0xecc);
    peer.memory.writeUInt16LE(d8002, 0xe04);
    const client = peer.client();
    await reject(() => client.readInformation(), 'PROGRAM_PROFILE_CPU_MISMATCH');
    assert.equal(peer.requests.length, 2);
    assert.ok(peer.requests.every(request => request.command === '0'));
    assert.equal(peer.closed, true);
    await reject(() => client.readBytes(0x1000, 2));
    assert.equal(peer.requests.length, 2);
  }
  const saturated = new PeerTransport();
  await reject(() => saturated.client({ programProfile: ProgramProfile.Classic }).backup(8000), 'capacity_mismatch');
  assert.equal(saturated.requests.length, 1);
  assert.equal(saturated.closed, true);
});

test('extended timeout, NAK and corruption do not retry or fall back', async () => {
  for (const failure of ['timeout', 'nak', 'checksum']) {
    const peer = new PeerTransport();
    peer.afterResponse = (request, response) => {
      if (request.command !== 'E0') return;
      if (failure === 'timeout') return Buffer.alloc(0);
      if (failure === 'nak') return Buffer.from([0x15]);
      const corrupt = Buffer.from(response);
      corrupt[corrupt.length - 1] = corrupt.at(-1) === 0x30 ? 0x31 : 0x30;
      return corrupt;
    };
    const client = peer.client({ timeoutMs: 30, retry: { count: 5, delayMs: 0 } });
    await reject(() => client.readInformation());
    assert.deepEqual(peer.requests.map(request => request.command), ['0', '0', 'E0']);
    assert.equal(peer.closed, true);
    await reject(() => client.readInformation());
    assert.equal(peer.frames.length, 3);
  }
});

test('extended captures reject changing snapshots and final CPU identity changes', async () => {
  const peer = new PeerTransport();
  let passes = 0;
  peer.beforeRequest = request => {
    if (request.command === 'E0' && request.address === 0x18000 && ++passes === 2)
      peer.memory[0x18005] ^= 1;
  };
  await reject(() => peer.client().backup(8000), 'snapshot_changed');
  assert.equal(peer.closed, true);
  for (const address of [0xe02, 0xeca, 0xecc]) {
    const changing = new PeerTransport();
    const requestedAddress = address === 0xe02 ? 0xe00 : 0xeca;
    let reads = 0;
    changing.beforeRequest = request => {
      if (request.address === requestedAddress && ++reads === 2) changing.memory[address] ^= 1;
    };
    await reject(() => changing.client().readInformation(), 'cpu_changed');
    assert.equal(changing.closed, true);
    assert.ok(changing.requests.every(request => request.command !== '1'));
  }
});

test('classic 2K backup and restore retain V1, preimage and verified byte diagnostics', async () => {
  const peer = new PeerTransport({ extended: false });
  const client = peer.client();
  const image = await callback(cb => client.backup(2000, cb));
  assert.ok(Buffer.isBuffer(image));
  assert.equal(image.length, 4128);
  assert.equal(image.readUInt16LE(8), 1);
  assert.equal(inspectProgramImage(image).profile, ProgramProfile.Classic);
  assert.equal(inspectProgramImage(image).cpu.d8102, null);
  peer.memory[0x8060] ^= 1;
  peer.memory[0x8061] ^= 1;
  peer.memory[0x80ff] ^= 1;
  const preimage = Buffer.from(peer.memory.subarray(0x8000, 0x9000));
  const result = await callback(cb => client.restore(image, cb));
  assert.deepEqual(result, { changedBytes: 3, verifiedBytes: 4096 });
  assert.equal(client.acknowledgedWriteBytes, 3);
  assert.ok(Buffer.isBuffer(client.preRestoreImage));
  assert.deepEqual(Buffer.from(inspectProgramImage(client.preRestoreImage).memory), preimage);
  assert.deepEqual(peer.memory.subarray(0x8000, 0x9000), Buffer.from(inspectProgramImage(image).memory));
  const writeCount = peer.requests.filter(request => request.command === '1').length;
  assert.equal(writeCount, 2);
  assert.deepEqual(await client.restore(image), { changedBytes: 0, verifiedBytes: 4096 });
  assert.equal(peer.requests.filter(request => request.command === '1').length, writeCount);
});

test('lost restore ACK is not replayed and preserves pre-restore diagnostics', async () => {
  const peer = new PeerTransport({ extended: false });
  const client = peer.client({ timeoutMs: 30, retry: { count: 5, delayMs: 0 } });
  const image = await client.backup(2000);
  peer.memory[0x8060] ^= 1;
  peer.memory[0x8080] ^= 1;
  const preimage = Buffer.from(peer.memory.subarray(0x8000, 0x9000));
  peer.afterResponse = request => request.command === '1' ? Buffer.alloc(0) : undefined;
  await reject(() => client.restore(image));
  assert.equal(peer.closed, true);
  assert.equal(client.acknowledgedWriteBytes, 0);
  assert.ok(Buffer.isBuffer(client.preRestoreImage));
  assert.deepEqual(Buffer.from(inspectProgramImage(client.preRestoreImage).memory), preimage);
  assert.equal(peer.requests.filter(request => request.command === '1').length, 1);
  assert.equal(peer.memory[0x8060], Buffer.from(inspectProgramImage(image).memory)[96]);
  await reject(() => client.restore(image));
  assert.equal(peer.requests.filter(request => request.command === '1').length, 1);
});

test('restore catches acknowledged writes that fail immediate readback', async () => {
  const peer = new PeerTransport({ extended: false });
  const client = peer.client();
  const image = await client.backup(2000);
  peer.memory[0x8060] ^= 1;
  peer.memory[0x8080] ^= 1;
  peer.afterResponse = request => {
    if (request.command === '1') peer.memory[request.address] ^= 1;
  };
  await reject(() => client.restore(image), 'verify_mismatch');
  assert.equal(client.acknowledgedWriteBytes, 1);
  assert.equal(peer.requests.filter(request => request.command === '1').length, 1);
  assert.equal(peer.closed, true);
});

test('native classic monitor maps numeric types and preserves unrelated control bits', async () => {
  const peer = new PeerTransport({ extended: false });
  peer.memory.writeInt16LE(-2, 0x1000);
  peer.memory.writeUInt32LE(0x92345678, 0xc00);
  peer.memory[0x88] = 1;
  peer.memory[0x100] = 1;
  const client = peer.client();
  assert.equal(await callback(cb => client.configureMonitor(monitorConfig(), cb)), undefined);
  assert.equal(peer.memory[0x1801], 0xa1);
  const sample = await callback(cb => client.readMonitor(cb));
  assert.deepEqual(Array.from(sample.numbers), [-2, 0x92345678]);
  assert.deepEqual(sample.bits, [true, true, false]);
  assert.deepEqual(Array.from(sample.numericBytes), [0xfe, 0xff, 0x78, 0x56, 0x34, 0x92]);
  assert.equal(await callback(cb => client.stopMonitor(cb)), undefined);
  assert.equal(peer.memory[0x1801], 0xa0);
});

test('classic monitor input validation and ownership failure do not emit extra mutations', async () => {
  const peer = new PeerTransport({ extended: false });
  const client = peer.client();
  for (const config of [
    { ...monitorConfig(), numberTypes: [] },
    { ...monitorConfig(), numberTypes: [NumberType.Float, NumberType.DoubleWordUnsigned] },
    { ...monitorConfig(), bitRegisters: ['D0'] },
    { ...monitorConfig(), bitCountAddress: -1 },
  ]) await reject(() => client.configureMonitor(config));
  assert.equal(peer.requests.length, 0);
  await client.configureMonitor(monitorConfig());
  peer.memory[0x1802] ^= 2;
  const writes = peer.requests.filter(request => request.command === '1').length;
  await reject(() => client.readMonitor(), 'monitor_ownership_lost');
  assert.equal(peer.requests.filter(request => request.command === '1').length, writes);
  assert.equal(peer.closed, true);
});

test('maintenance and legacy primitives share an exclusive lock for the entire workflow', async () => {
  const peer = new PeerTransport();
  peer.memory[0x1000] = 0x34;
  peer.memory[0x1001] = 0x12;
  let announceFirst;
  const started = new Promise(resolve => { announceFirst = resolve; });
  let releaseFirst;
  const release = new Promise(resolve => { releaseFirst = resolve; });
  peer.beforeRequest = async (_request, state) => {
    if (state.requests.length === 1) { announceFirst(); await release; }
  };
  const client = peer.client();
  const backup = client.backup(8000);
  await started;
  const read = client.readBytes(0x1000, 2);
  releaseFirst();
  const [image, bytes] = await Promise.all([backup, read]);
  assert.ok(Buffer.isBuffer(image));
  assert.deepEqual(bytes, Buffer.from([0x34, 0x12]));
  assert.equal(peer.requests.length, 509);
  assert.deepEqual(peer.requests.at(-1), { command: '0', address: 0x1000, count: 2, data: Buffer.alloc(0) });
  assert.equal(peer.requests.slice(0, -1).some(request => request.address === 0x1000), false);
  assert.equal(peer.closed, false);
});

test('new engine operations require the strict transport contract before I/O', async () => {
  for (const available of [undefined, -1, 0.5, NaN, Infinity, '0']) {
    const peer = new PeerTransport();
    Object.defineProperty(peer, 'availableBytes', { value: available });
    const client = peer.client();
    await reject(() => client.readExtendedBytes(0x18000, 2), 'transport_contract');
    assert.equal(peer.requests.length, 0);
  }
});

test('standalone E0 NAK is synchronized and permits a later read without retry', async () => {
  const peer = new PeerTransport();
  peer.afterResponse = () => peer.requests.length === 1 ? Buffer.from([0x15]) : undefined;
  const client = peer.client({ retry: { count: 5, delayMs: 0 } });
  await reject(() => client.readExtendedBytes(0x18000, 2), 'nak');
  assert.equal(peer.requests.length, 1);
  assert.equal(peer.closed, false);
  assert.deepEqual(await client.readExtendedBytes(0x18000, 2), Buffer.from([16, 0]));
  assert.equal(peer.requests.length, 2);
});

test('restore awaits the beforeWrite preimage hook before its first mutation', async () => {
  const peer = new PeerTransport({ extended: false });
  const client = peer.client();
  const image = await client.backup(2000);
  peer.memory[0x8060] ^= 1;
  const expected = Buffer.from(peer.memory.subarray(0x8000, 0x9000));
  let hooks = 0;
  let hookCompleted = false;
  peer.beforeRequest = request => {
    if (request.command === '1') assert.equal(hookCompleted, true);
  };
  const result = await callback(cb => client.restore(image, {
    async beforeWrite(preRestoreImage) {
      hooks++;
      assert.ok(Buffer.isBuffer(preRestoreImage));
      assert.deepEqual(Buffer.from(inspectProgramImage(preRestoreImage).memory), expected);
      assert.equal(peer.requests.some(request => request.command === '1'), false);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(peer.requests.some(request => request.command === '1'), false);
      hookCompleted = true;
    },
  }, cb));
  assert.equal(hooks, 1);
  assert.equal(result.changedBytes, 1);
  assert.equal(peer.requests.filter(request => request.command === '1').length, 1);
});

test('rejected or timed-out beforeWrite hooks close the transport without mutations', async () => {
  for (const failure of ['reject', 'timeout']) {
    const peer = new PeerTransport({ extended: false });
    const client = peer.client({ timeoutMs: 40 });
    const image = await client.backup(2000);
    peer.memory[0x8060] ^= 1;
    let hooks = 0;
    await reject(() => client.restore(image, {
      async beforeWrite(preRestoreImage) {
        hooks++;
        assert.ok(Buffer.isBuffer(preRestoreImage));
        if (failure === 'reject') throw new Error('simulated preimage persistence failure');
        return new Promise(() => {});
      },
    }));
    assert.equal(hooks, 1);
    assert.equal(peer.requests.some(request => request.command === '1'), false);
    assert.equal(peer.closed, true);
    assert.equal(client.acknowledgedWriteBytes, 0);
    assert.ok(Buffer.isBuffer(client.preRestoreImage));
    await reject(() => client.readExtendedBytes(0x18000, 2), 'session_poisoned');
  }
});

test('native monitor supports exactly 18 numbers and 152 bits with bounded table writes', async () => {
  const peer = new PeerTransport({ extended: false });
  const client = peer.client();
  const config = {
    numericRegisters: Array.from({ length: 18 }, (_, index) => `D${index}`),
    numberTypes: Array(18).fill(NumberType.WordSigned),
    bitRegisters: Array.from({ length: 152 }, (_, index) => `M${index}`),
    bitCountAddress: 0x1826,
    bitTableAddress: 0x1828,
  };
  await reject(() => client.configureMonitor({
    ...config, numericRegisters: [...config.numericRegisters, 'D18'],
    numberTypes: [...config.numberTypes, NumberType.WordSigned],
  }));
  await reject(() => client.configureMonitor({ ...config, bitRegisters: [...config.bitRegisters, 'M152'] }));
  assert.equal(peer.requests.length, 0);
  for (let index = 0; index < 18; index++) peer.memory.writeInt16LE(100 + index, 0x1000 + index * 2);
  peer.memory.fill(0xa5, 0x100, 0x113);
  await client.configureMonitor(config);
  const sample = await client.readMonitor();
  assert.deepEqual(Array.from(sample.numbers), Array.from({ length: 18 }, (_, index) => 100 + index));
  assert.deepEqual(sample.bits, Array.from({ length: 152 }, (_, index) => Boolean((0xa5 >>> (index % 8)) & 1)));
  assert.ok(peer.requests.some(request => request.command === '1' && request.count === 64));
  assert.ok(peer.requests.every(request => request.count <= 64));
  assert.equal(peer.memory[0x1801], 0xa1);
  await client.stopMonitor();
  assert.equal(peer.memory[0x1801], 0xa0);
});

test('monitor setup failure stops before enable and never retries a rejected table write', async () => {
  const peer = new PeerTransport({ extended: false });
  peer.afterResponse = request => request.command === '1' && request.address === 0x1828
    ? Buffer.from([0x15]) : undefined;
  const client = peer.client({ retry: { count: 5, delayMs: 0 } });
  await reject(() => client.configureMonitor(monitorConfig()), 'nak');
  assert.equal(peer.requests.filter(request => request.command === '1' && request.address === 0x1828).length, 1);
  assert.equal(peer.requests.some(request => request.command === '1' && request.address === 0x1801
    && (request.data[0] & 1)), false);
  assert.equal(peer.memory[0x1801], 0xa0);
  assert.equal(peer.closed, true);
});

test('monitor ownership is checked again after reading sample data', async () => {
  const peer = new PeerTransport({ extended: false });
  const client = peer.client();
  await client.configureMonitor(monitorConfig());
  const writes = peer.requests.filter(request => request.command === '1').length;
  peer.beforeRequest = request => {
    if (request.command === '0' && request.address === 0x1958) peer.memory[0x1802] ^= 2;
  };
  await reject(() => client.readMonitor(), 'monitor_ownership_lost');
  assert.equal(peer.requests.filter(request => request.command === '1').length, writes);
  assert.equal(peer.closed, true);
});

test('unexpected bytes after a valid E0 response poison the transport without advancing', async () => {
  for (const maintenance of [false, true]) {
    const peer = new PeerTransport();
    peer.afterResponse = (request, response) => request.command === 'E0'
      ? Buffer.concat([response, Buffer.from([6])]) : undefined;
    const client = peer.client();
    await reject(() => maintenance ? client.readInformation() : client.readExtendedBytes(0x18000, 2));
    assert.equal(peer.requests.length, maintenance ? 3 : 1);
    assert.equal(peer.closed, true);
    await reject(() => client.readExtendedBytes(0x18000, 2), 'session_poisoned');
    assert.equal(peer.requests.length, maintenance ? 3 : 1);
  }
});

test('closing during a pending transport write prevents late reads and queued requests', async () => {
  const peer = new PeerTransport();
  let announce;
  const started = new Promise(resolve => { announce = resolve; });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  peer.beforeRequest = async () => { announce(); await blocked; };
  const client = peer.client();
  const operation = client.readExtendedBytes(0x18000, 2);
  await started;
  client.close();
  await reject(() => operation);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peer.frames.length, 1);
  assert.equal(peer.readSizes.length, 0);
  await reject(() => client.readExtendedBytes(0x18000, 2), 'session_poisoned');
  assert.equal(peer.frames.length, 1);
});

test('a restore hook completing after close or timeout cannot resume mutations', async () => {
  for (const interruption of ['close', 'timeout']) {
    const peer = new PeerTransport({ extended: false });
    const client = peer.client({ timeoutMs: interruption === 'timeout' ? 40 : 1000 });
    const image = await client.backup(2000);
    peer.memory[0x8060] ^= 1;
    let announce;
    const started = new Promise(resolve => { announce = resolve; });
    let release;
    const blocked = new Promise(resolve => { release = resolve; });
    const operation = client.restore(image, { beforeWrite: async () => { announce(); await blocked; } });
    await started;
    if (interruption === 'close') client.close();
    await reject(() => operation);
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(peer.requests.some(request => request.command === '1'), false);
    assert.equal(client.acknowledgedWriteBytes, 0);
    assert.ok(Buffer.isBuffer(client.preRestoreImage));
    assert.equal(peer.closed, true);
  }
});

test('invalid callbacks are rejected before scheduling new engine I/O', async () => {
  const peer = new PeerTransport();
  const client = peer.client();
  for (const run of [
    () => client.readExtendedBytes(0x18000, 2, 'invalid'),
    () => client.readInformation('invalid'),
    () => client.backup(8000, 'invalid'),
    () => client.compare(Buffer.alloc(0), 'invalid'),
    () => client.restore(Buffer.alloc(0), {}, 'invalid'),
    () => client.configureMonitor(monitorConfig(), 'invalid'),
    () => client.readMonitor('invalid'),
    () => client.stopMonitor('invalid'),
  ]) assert.throws(run);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(peer.frames.length, 0);
  assert.equal(peer.closed, false);
});

test('client close is idempotent for transport closure and disconnect events', () => {
  const peer = new PeerTransport();
  const close = peer.close.bind(peer);
  let closures = 0;
  peer.close = () => { closures++; close(); };
  const client = peer.client();
  let events = 0;
  client.on('disconnect', () => { events++; });
  client.close();
  client.close();
  assert.equal(closures, 1);
  assert.equal(events, 1);
});

test('large valid timeouts do not overflow the Node timer range', async () => {
  const warnings = [];
  const onWarning = warning => warnings.push(warning);
  process.on('warning', onWarning);
  try {
    const peer = new PeerTransport();
    const client = peer.client({ timeoutMs: 0xffffffff });
    assert.deepEqual(await client.readExtendedBytes(0x18000, 2), Buffer.from([16, 0]));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warnings.some(warning => warning.name === 'TimeoutOverflowWarning'), false);
  } finally {
    process.removeListener('warning', onWarning);
  }
});
