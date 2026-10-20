// Execute both built entrypoints, or an unpacked npm archive supplied as argv[2].
// Runtime imports come from that package; this peer uses no sockets or devices.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { PeerTransport, monitorConfig } from './helpers/engine-peer.js';

const root = resolve(process.argv[2] ?? fileURLToPath(new URL('..', import.meta.url)));
const require = createRequire(import.meta.url);
const apis = [
  ['CommonJS', require(root)],
  ['ESM', await import(pathToFileURL(join(root, 'dist/esm/index.js')))],
];
for (const [name, api] of apis) {
  const peer = new PeerTransport();
  const client = new api.FXPLCClient(peer, { programProfile: api.ProgramProfile.Fx3uExtended8KReadOnly });
  assert.deepEqual(await client.readExtendedBytes(0x18000, 2), Buffer.from([16, 0]));
  assert.equal(peer.frames[0].toString('hex'), '02453031383030303032034433');
  assert.equal((await client.readInformation()).cpu.d8102, 8);
  const image = await client.backup(8000);
  assert.equal(api.inspectProgramImage(image).profile, api.ProgramProfile.Fx3uExtended8KReadOnly);
  assert.equal(api.compareProgramImages(image, image).identical, true);
  assert.equal((await client.compare(image)).identical, true);
  await assert.rejects(client.restore(image), error => error.code === 'profile_read_only');
  client.close();

  const classicPeer = new PeerTransport({ extended: false });
  const classic = new api.FXPLCClient(classicPeer);
  const original = await classic.backup(2000);
  classicPeer.memory[0x8060] ^= 1;
  assert.deepEqual(await classic.restore(original), { changedBytes: 1, verifiedBytes: 4096 });
  assert.equal(classic.acknowledgedWriteBytes, 1);
  await classic.configureMonitor(monitorConfig());
  assert.equal((await classic.readMonitor()).bits.length, 3);
  await classic.stopMonitor();
  classic.close();
  console.log(`PASS ${name} package: E0, CPU, V2 capture/comparison, V1 restore and monitor`);
}

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(filename));
    else result.push(filename);
  }
  return result;
}
const shipped = await files(join(root, 'dist'));
assert.ok(shipped.every(filename => /\.(?:js|json)$/.test(filename)), 'runtime files must be JavaScript or package metadata');
for (const filename of shipped.filter(filename => filename.endsWith('.js'))) {
  const source = await readFile(filename, 'utf8');
  assert.doesNotMatch(source, /WebAssembly\.(?:Module|Instance|instantiate)/);
}
const license = await readFile(join(root, 'LICENSE'), 'utf8');
assert.ok(license.includes('MIT License'));
assert.ok(license.includes('Copyright (c) 2025 n-car'));
console.log('PASS JavaScript package contents and MIT license');
