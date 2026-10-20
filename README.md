# node-fxplc

[![npm version](https://img.shields.io/npm/v/node-fxplc.svg)](https://www.npmjs.com/package/node-fxplc)
[![npm downloads](https://img.shields.io/npm/dm/node-fxplc.svg)](https://www.npmjs.com/package/node-fxplc)
[![license](https://img.shields.io/npm/l/node-fxplc.svg)](LICENSE)
[![GitHub tag](https://img.shields.io/github/v/tag/n-car/node-fxplc?label=git-tag)](https://github.com/n-car/node-fxplc/releases)

Documentation: [Release notes](./RELEASE_NOTES.md) · [Changelog](./CHANGELOG.md) · [Roadmap](./ROADMAP.md)

Node.js library for communication with Mitsubishi FX PLCs using low-level MELSEC FX series serial protocol.

**Note:** it is not the same as Non-Protocol Communication (or D8120) as described in FX Series Programmable Controllers manuals.

## Project Status

Version **0.2.0** adds explicitly selected E0 reads, CPU/parameter information, binary backup/comparison, and classic maintenance workflows to the existing device read/write API. The package supports ESM, CommonJS and TypeScript consumers on Node.js 16 or later.

This is a pre-1.0 library with limited hardware validation. Simulated tests cover the documented workflows; the built CommonJS API also passed [read-only hardware acceptance](#read-only-hardware-acceptance) on one FX3U-compatible 8K clone. Writes, restore and native monitor remain unverified on hardware. See the [release notes](./RELEASE_NOTES.md) for upgrade guidance and the [roadmap](./ROADMAP.md) for planned work.

## Installation

```bash
npm install node-fxplc
```
Optional (for debug logging):
```bash
npm install debug
```
Enable logs by setting environment variable (PowerShell):
```powershell
$env:DEBUG = "fxplc:*"; node yourscript.mjs
```

## Usage in ESM and CommonJS

This package supports both ESM (`import`) and CommonJS (`require`) consumers. Use the appropriate syntax for your project type:

### ESM (import)

```js
import { FXPLCClient, TransportTCP, TransportSerial } from 'node-fxplc';
// ...your code
```

### CommonJS (require)

```js
const { FXPLCClient, TransportTCP, TransportSerial } = require('node-fxplc');
// ...your code
```

Both entrypoints provide the same API and typings. See below for detailed usage examples.

## Features (current)

- Low-level MELSEC FX serial frame protocol (hex payload + checksum)
- Read / write single bit & forced coil (ON/OFF)
- Read / write signed word and generic numeric types via converters
- Batch read/write (coalesces contiguous byte spans, splitting at 64 bytes)
- Raw byte read/write access for advanced use (1–64 bytes per command)
- Explicit E0 raw reads with 20-bit byte addresses
- CPU/parameter reads and two-pass binary backup with offline/live comparison
- Classic-only restore with pre-write backup hook and readback verification
- Classic native PLC monitor with an explicitly supplied address layout
- TCP & Serial transports with buffer accumulation & timeouts
- Command timeout with terminal invalidation after ambiguous failures
- Event emitter (error / connect / disconnect)

## Protocol Notes

This is NOT the "Non-Protocol Communication" (D8120) mode. It targets the classic hex framed ASCII protocol (FX0N/FX1N style) and the explicitly selected `E0` read extension. Serial defaults: 7 data bits, even parity, 1 stop bit (7E1), commonly 9600 baud. Verify your PLC parameters.

Compatibility note: The protocol layer is electrical-transport agnostic. Use a proper RS422↔USB (or RS422↔RS232) converter and match serial parameters (7E1, baud rate). The address profile below is verified against the classic Mitsubishi manual; individual CPU capabilities, permissions, converter direction control, and clone compatibility require separate validation.

## Supported register profile

The bounded classic profile follows Mitsubishi **FX-232AW BT5096-C**, tables 1–7 (PDF pages 18–27, counting the cover as page 1). It is not a universal FX CPU profile: a particular CPU may implement fewer devices or restrict writes to special registers.

The intended FX0N-60MR/RS422 setup remains unverified on hardware. Classic CPU/status reads and the bounded E0 maintenance window passed a bench test on one RS232-connected FX3U-compatible clone; this does not certify the full register map, writes, firmware behavior or other electrical connections.

| Devices | Bit contacts / FORCE | Numeric values |
| --- | --- | --- |
| S0–S999 | Yes | No |
| X0–X177, Y0–Y177 (octal labels) | Yes | No |
| T0–T255 | Yes | 16-bit slots |
| M0–M1023, M8000–M8255 | Yes | No |
| C0–C199 | Yes | 16-bit slots |
| C200–C255 | Yes | 32-bit slots, starting at `0x0C00` |
| D0–D511, D8000–D8255 | No | 16-bit slots |

Parsing is strict: `RegisterDef.parse('X100')` means octal X100 (ordinal 64); `X80`, trailing text, and devices outside this profile are rejected. `new RegisterDef('X', 100)` uses the same device-label convention. `getBitImageAddress()`, `getForceAddress()`, and `getDataAddress(size = 2)` expose the checked maps, including the separate M8000/D8000 regions.

The selected numeric converter determines the number of bytes read or written. A 32-bit D value occupies two word slots; `C200` already has a four-byte stride. Selecting a 16-bit converter for C200–C255 accesses its low word. Numeric operations cannot cross the end of a documented segment. The Float converter provides IEEE-754 byte conversion; it does not establish that a particular CPU/program stores floats in that register.

`readBit('D9')` is rejected rather than interpreting it as bit 9 of D0. Read a numeric D value and mask the intended bit explicitly. Separate T/C OUT and RST coil images are not exposed by these contact helpers.

READ and WRITE accept **1–64 bytes** (manual PDF pages 10–12). Batch operations validate all registers and values before transmission, coalesce only contiguous byte spans, and split requests at 64 bytes. For example, 32-bit `D0` and `D1` overlap and therefore produce separate requests; 32-bit `C200` and `C201` are contiguous. Batches stop at the first failed request and are not atomic: already acknowledged writes remain applied.

## Maintenance and E0 reads

Maintenance operations include CPU/parameter information, binary image backup/comparison, classic restore and native monitor access. Existing classic register methods retain their API and address profile.

Choose the program-memory profile explicitly when constructing the client:

| `ProgramProfile` | Program-memory command/base | Supported workflows |
| --- | --- | --- |
| `Classic` (default, `0`) | `0`, `0x8000` | Information, 2K/4K/8K backup/comparison, restore and native monitor |
| `Fx3uExtended8KReadOnly` (`1`) | `E0`, `0x18000` | Information and 8K backup/comparison only |

Profiles are not detected from a timeout, model string or a PLC configuration flag. No command is retried or changed to another protocol automatically. Selecting the extended profile does not change the existing device-register map or disable the separate classic device-write methods; its read-only restriction applies to the extended maintenance workflows.

The extended profile first reads D8000–D8003 and D8101–D8102 using classic READ. It requires D8101's decimal family prefix to be `16`, D8002 to be `8`, and D8102 to be `8` before reading program memory. These checks constrain the selected layout; they do not prove E0 capability on every matching PLC. Larger/unknown memories are rejected. There is no E1 support or extended restore.

```js
import { writeFile } from 'node:fs/promises';
import {
  FXPLCClient, TransportSerial, ProgramProfile,
  inspectProgramImage, compareProgramImages,
} from 'node-fxplc';

const transport = new TransportSerial({ path: 'COM3', baudRate: 38400 });
const plc = new FXPLCClient(transport, {
  programProfile: ProgramProfile.Fx3uExtended8KReadOnly,
  timeoutMs: 2500,
});
try {
  const information = await plc.readInformation();
  console.log(information.cpu.d8101, information.cpu.d8102);
  const image = await plc.backup(8000);
  await writeFile('plc-backup.fxplcbk', image);
  console.log(inspectProgramImage(image).parameterAddress); // 0x18000
  console.log(compareProgramImages(image, image).identical); // offline
  console.log((await plc.compare(image)).identical); // captures the PLC again
} finally {
  plc.close();
}
```

Use a port and serial configuration appropriate to your own hardware. These asynchronous client methods also accept Node-style callbacks, for example `plc.readInformation((error, information) => { ... })`. `backup` and `readExtendedBytes` return Node `Buffer` values, as does the `preRestoreImage` getter when an image is available; nested raw fields are `Uint8Array`, monitor numbers are `Float64Array`, and monitor bits are `boolean[]`.

`readExtendedBytes(address, count = 1)` explicitly issues a raw E0 read independently of the maintenance profile. It accepts byte addresses `0x00000`–`0xFFFFF`, 1–64 bytes, and rejects an address span crossing `0xFFFFF`. A successful raw read does not establish a memory map or whole-device backup capability.

### Backup format and limits

`backup(capacitySteps)` takes an explicit capacity of `2000`, `4000` or `8000` steps; only `8000` is accepted by the extended profile. The engine reads the allocation twice, rejects differing bytes, and rechecks CPU identity. This detects observed changes but is not an atomic PLC snapshot.

The verified extended window is **16,096 bytes at `0x18000`–`0x1BEDF`**: 92 bytes interpreted using the existing parameter offsets, 16,000 program bytes and four trailing bytes. Unknown parameter encodings remain raw. This is an opaque program/parameter window, not MCU firmware, a decoded Ladder project, or a certified complete Mitsubishi/GX Developer backup. The integrated Node hardware acceptance below validates reads within this bounded window on one target.

Classic images keep the v1 `FXPLCBK` container with a 32-byte header. Extended images use v2 with a 40-byte header containing the profile, base address and D8101/D8102. Both include a CRC to detect file corruption. `inspectProgramImage(image)` validates the container; `compareProgramImages(left, right)` reports `profileMatches` and bounded changed ranges with full byte addresses. Live comparison/restore rejects a container from another profile before I/O.

There is one deliberate compatibility restriction: old v1 images with D8001 family prefix `24` and no D8102 evidence are rejected with `PROGRAM_CPU_CAPACITY`, even if their CRC is valid. D8002 alone cannot distinguish an 8K FX3U allocation from larger memories. The same restriction prevents a new classic backup from silently recording a partial allocation for that family. Ordinary classic v1 images remain supported.

### Read-only hardware acceptance

On 20 October 2026, the built CommonJS package and production `TransportSerial`
completed a read-only bench run on one FX3U-compatible 48MR/8K clone through a
CH340 adapter on Windows at **38400 7E1**. A local host wrapper configured serial
locking and line control before opening the port; these settings are not public
`TransportSerial` options.

The run completed **1,029 reads: 18 classic `0` and 1,011 `E0`**. It exercised
CPU/parameter information, a raw E0 read, ordinary status polling before and
after capture, an 8K backup with two equal passes, and live comparison with two
further equal passes. Comparison reported identical memory and metadata, and
the port's close event was confirmed. The resulting v2 container contains
16,136 bytes, including the 16,096-byte memory window.

This acceptance covers that single clone and bounded read-only window. No
WRITE, FORCE, RUN/STOP, restore, native monitor configuration, firmware access
or electrical I/O test was performed. Other CPU versions, larger memories and
FX0N-60MR/RS422 remain unverified; matching repeated reads do not establish an
atomic snapshot or a complete vendor backup.

### Classic restore

`restore(image, options?)` is available only with `ProgramProfile.Classic`. Keep the PLC physically in STOP and exclude other programming clients for the whole operation. The client checks the CPU, capacity, memory permissions, parameter layout and STOP status; it captures the current target, writes changed bytes, then checks readback. It does not issue a RUN/STOP command, compile Ladder or calculate undocumented PLC program checksums. Matching readback proves transferred bytes, not program validity.

The optional `beforeWrite` hook lets the host persist the captured target image before the first mutation:

```js
const outcome = await classicPlc.restore(sourceImage, {
  beforeWrite: image => writeFile('before-restore.fxplcbk', image),
});
console.log(outcome.changedBytes, outcome.verifiedBytes);
```

Throwing or rejecting from the hook cancels the workflow before a write is sent and invalidates the client. The hook runs under the workflow lock and transaction timeout; use it for persistence and do not call another method on the same client from it. After failure or close, `preRestoreImage` and `acknowledgedWriteBytes` retain available diagnostics. An unacknowledged timed-out write may still have been applied; no retry or automatic rollback occurs.

### Native PLC monitor

The classic profile exposes `configureMonitor(config)`, `readMonitor()` and `stopMonitor()`. Configuration accepts `numericRegisters`, matching `numberTypes` from `NumberType`, `bitRegisters`, `bitCountAddress` and `bitTableAddress`. The latter two addresses must come from a layout verified for the target; there is no assumed default. Configuration and stop write the PLC's monitor tables/control, so they are rejected for the extended read-only profile.

This is the PLC's native monitor table, not repeated ordinary device reads. The engine verifies monitor ownership before and after sampling, and before stopping. It accepts up to 18 numeric and 152 bit entries; numeric types must match 16-bit word devices or 32-bit C200–C255 slots. Monitor results contain decoded `numbers` and `bits` plus their raw `numericBytes` and `bitBytes`. The protocol has no sample sequence number: a successful read does not establish freshness or a shared PLC scan across separate result frames.

## Error Classes

Exposed error types (see `errors.js`):

- `NoResponseError` – timeout or no reply
- `ResponseMalformedError` – bad checksum / frame inconsistency
- `NotSupportedCommandError` – PLC replied NAK
- `NotConnectedError` – transport not open

Use instanceof checks for granular handling.

E0 and maintenance APIs expose machine-readable `error.code` values, including `profile_mismatch`, `profile_read_only`, `capacity_mismatch`, `PROGRAM_PROFILE_CPU_MISMATCH`, `cpu_changed`, `snapshot_changed` and `timeout`. Host contract failures use `transport_contract`. Code-based handling is appropriate for these APIs; the legacy error classes remain available for existing methods.

## Timeouts & Retries

Client option `timeoutMs` bounds each command after it acquires the transport lock. Commands execute once, including mutations: an absent reply does not prove that a write was not applied. The historical `retry` option remains accepted for API compatibility but no longer causes replay.

A timeout, transport failure, malformed frame, unexpected response kind, or incorrect READ length closes and permanently invalidates the client. Create a **new client with a new clean transport** before continuing. For primitive operations, a valid NAK reports rejection and leaves the synchronized client usable. A maintenance workflow treats NAK as terminal and closes the client. Example:
```js
const plc = new FXPLCClient(transport, { timeoutMs: 2500 });
```

Built-in transports expose a synchronous `availableBytes` getter. The client rejects buffered input before transmission and trailing bytes after a complete reply, including duplicate ACKs; the serial adapter no longer discards unexplained input between commands. Custom transports should expose the same getter and preserve their receive buffer across requests. It is optional for API compatibility, but without it the client cannot detect residual bytes hidden inside a custom transport.

For `readExtendedBytes` and all maintenance methods, `availableBytes` is required and must be a nonnegative safe integer; a missing/invalid getter is rejected before I/O. One transport lock covers each entire maintenance workflow, preventing classic requests on the same client from interleaving its frames. Other clients/processes must not share that transport. The engine does not reset a faulted stream: create a new client and a new clean transport after timeout, abort or corruption.

Calling `close()` is terminal for the built-in TCP/serial transport object, including an open still in progress. Create a new transport object to reconnect; reusing the old client or transport is not supported. Custom transports must also cancel pending opens/reads/writes on close and prevent a delayed open from sending a request after cancellation.

The protocol has no transaction identifier. A delayed duplicate that arrives only after a later command has already been sent can be indistinguishable from that command's real reply; buffered-input checks cannot solve this protocol limitation.

Protocol tests use simulated peers and independently transcribed manual examples; no physical PLC is contacted by `npm test`. The separate package check executes E0/maintenance through both built ESM and CommonJS entrypoints.
`FXPLCClientMock` covers the legacy primitive APIs; maintenance tests use an independent simulated protocol peer.

## Building from source

From a source checkout, install dependencies and regenerate the ESM/CommonJS outputs. Source files are in `lib/`; tests and development examples are in `test/`.

```bash
npm install --ignore-scripts
npm run build
npm test
npm run test:package
```

No hardware tests, publishing or firmware updates are performed by these commands.

## Reconnecting

`setReconnect(enabled, delayMs)` remains accepted for source compatibility,
but it does not revive a closed or failed transport. After disconnection,
create a new transport and client explicitly. No programming command or
mutation is replayed automatically.

## Usage Examples

### Promise style (TCP)

```js
import { FXPLCClient, TransportTCP } from 'node-fxplc';
const transport = new TransportTCP({ host: '127.0.0.1', port: 5000 });
await transport.connect();
const plc = new FXPLCClient(transport);
const bit = await plc.readBit('M0');
console.log('Bit M0:', bit);
const vals = await plc.batchRead(['D100','D101']);
await plc.writeBit('M10', true);
plc.close();
```

### Callback style

```js
plc.readBit('M0', (err, bit) => {
	if (err) return console.error('Error:', err);
	console.log('Bit M0:', bit);
});
plc.batchRead(['D100','D101'], (err, vals) => {
	if (!err) console.log('Values:', vals);
});
```

### Events (error, connect, disconnect)

```js
plc.on('error', err => console.error('PLC Error:', err));
plc.on('connect', () => console.log('Connected!'));
plc.on('disconnect', () => console.log('Disconnected!'));
```

### Input error handling

```js
try {
	await plc.readBit('Z999'); // invalid register
} catch(e) {
	console.error('Input error:', e.message);
}
```

### Batch write

```js
await plc.batchWrite(['D100','D101'], [123,456]);
```

### Serial usage example

```js
import { FXPLCClient, TransportSerial } from 'node-fxplc';
const transport = new TransportSerial({ path: 'COM3', baudRate: 9600, timeout: 1500 });
const plc = new FXPLCClient(transport, { debug: true });
const bit = await plc.readBit('M0');
console.log('M0 =', bit);
plc.close();
```

### Enabling debug logs

Install `debug` and set `DEBUG=fxplc:*` env variable. Logs show TX/RX hex frames.

## License

Released under the [MIT License](./LICENSE).
