# node-fxplc

[![npm version](https://img.shields.io/npm/v/node-fxplc.svg)](https://www.npmjs.com/package/node-fxplc)
[![npm downloads](https://img.shields.io/npm/dm/node-fxplc.svg)](https://www.npmjs.com/package/node-fxplc)
[![license](https://img.shields.io/npm/l/node-fxplc.svg)](LICENSE)
[![GitHub tag](https://img.shields.io/github/v/tag/n-car/node-fxplc?label=git-tag)](https://github.com/n-car/node-fxplc/releases)

> See also: [Release Notes](./RELEASE_NOTES.md)

Node.js library for communication with Mitsubishi FX PLCs using low-level MELSEC FX series serial protocol.

**Note:** it is not the same as Non-Protocol Communication (or D8120) as described in FX Series Programmable Controllers manuals.

This is a Node.js port of a Python library.

## Structure
- `lib/` — Library source code
- `test/` — Tests and example scripts

## Project Status
Pre-release. Core client API + TCP/Serial transports work for basic read/write, but advanced resilience and integration testing are still in progress.
See `ROADMAP.md` for detailed progress & planned items. Contributions / hardware test feedback are welcome.

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
- TCP & Serial transports with buffer accumulation & timeouts
- Command timeout with terminal invalidation after ambiguous failures
- Event emitter (error / connect / disconnect)

## Protocol Notes
This is NOT the "Non-Protocol Communication" (D8120) mode. It targets the classic hex framed ASCII protocol (FX0N/FX1N style). Serial defaults: 7 data bits, even parity, 1 stop bit (7E1), commonly 9600 baud. Verify your PLC parameters.

Compatibility note: The protocol layer is electrical-transport agnostic. Use a proper RS422↔USB (or RS422↔RS232) converter and match serial parameters (7E1, baud rate). The address profile below is verified against the classic Mitsubishi manual; individual CPU capabilities, permissions, converter direction control, and clone compatibility require separate validation.

## Supported register profile

The bounded classic profile follows Mitsubishi **FX-232AW BT5096-C**, tables 1–7 (PDF pages 18–27, counting the cover as page 1). It is not a universal FX CPU profile: a particular CPU may implement fewer devices or restrict writes to special registers.

The intended FX0N-60MR setup and RS232-connected clone remain unverified on hardware. These corrections establish the shared classic protocol map; they do not certify either device's full capacity, firmware behavior, or electrical connection.

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

## Error Classes
Exposed error types (see `errors.js`):
- `NoResponseError` – timeout or no reply
- `ResponseMalformedError` – bad checksum / frame inconsistency
- `NotSupportedCommandError` – PLC replied NAK
- `NotConnectedError` – transport not open
Use instanceof checks for granular handling.

## Timeouts & Retries
Client option `timeoutMs` bounds each command after it acquires the transport lock. Commands execute once, including mutations: an absent reply does not prove that a write was not applied. The historical `retry` option remains accepted for API compatibility but no longer causes replay.

A timeout, transport failure, malformed frame, unexpected response kind, or incorrect READ length closes and permanently invalidates the client. Create a **new client with a new clean transport** before continuing. A valid NAK reports rejection and leaves the synchronized client usable. Example:
```js
const plc = new FXPLCClient(transport, { timeoutMs: 2500 });
```

Built-in transports expose a synchronous `availableBytes` getter. The client rejects buffered input before transmission and trailing bytes after a complete reply, including duplicate ACKs; the serial adapter no longer discards unexplained input between commands. Custom transports should expose the same getter and preserve their receive buffer across requests. It is optional for API compatibility, but without it the client cannot detect residual bytes hidden inside a custom transport.

The protocol has no transaction identifier. A delayed duplicate that arrives only after a later command has already been sent can be indistinguishable from that command's real reply; buffered-input checks cannot solve this protocol limitation.

Protocol tests use simulated peers and independently transcribed manual examples; no physical PLC is contacted by `npm test`. Run `npm run build` to regenerate the ESM and CommonJS package outputs.

## Auto Reconnect (TCP)
Enable simple reconnect:
```js
const tcp = new TransportTCP({ host: '127.0.0.1', port: 5000 });
tcp.setReconnect(true, 2000); // every 2s after disconnect
```
Serial transport currently has no auto-reopen loop (planned).


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
Released under the MIT License. See the `LICENSE` file for full text.

---
Next focus: transport robustness, CLI, integration tests, richer docs.

Note: Serial transport is functional but minimally tested; use caution in production scenarios.

