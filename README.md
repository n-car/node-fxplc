# node-fxplc

[![npm version](https://img.shields.io/npm/v/node-fxplc.svg)](https://www.npmjs.com/package/node-fxplc)
[![npm downloads](https://img.shields.io/npm/dm/node-fxplc.svg)](https://www.npmjs.com/package/node-fxplc)
[![license](https://img.shields.io/npm/l/node-fxplc.svg)](LICENSE)
[![GitHub tag](https://img.shields.io/github/v/tag/n-car/node-fxplc?label=git-tag)](https://github.com/n-car/node-fxplc/releases)

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

## Features (current)
- Low-level MELSEC FX serial frame protocol (hex payload + checksum)
- Read / write single bit & forced coil (ON/OFF)
- Read / write signed word and generic numeric types via converters
- Batch read/write (auto-coalesces consecutive addresses)
- Raw byte read/write access for advanced use
- TCP & Serial transports with buffer accumulation & timeouts
- Simple retry + operation-level timeout
- Event emitter (error / connect / disconnect)

## Protocol Notes
This is NOT the "Non-Protocol Communication" (D8120) mode. It targets the classic hex framed ASCII protocol (FX0N/FX1N style). Serial defaults: 7 data bits, even parity, 1 stop bit (7E1), commonly 9600 baud. Verify your PLC parameters.

Compatibility note: The protocol layer is electrical-transport agnostic; it should also work with many FX-compatible clone PLCs exposing an RS422 port, provided they implement the same framed command set. Use a proper RS422↔USB (or RS422↔RS232) converter and match serial parameters (7E1, baud rate). Timing and response behaviors may vary between clones—enable retries if needed and report any incompatibilities.

## Supported Registers (initial)
- Bit areas (e.g. M, X, Y) via `readBit` / `writeBit`
- Data registers (e.g. D) via numeric read/write helpers
Parsing is handled by `RegisterDef.parse('D100')`. Unsupported / unknown areas will throw until implemented.

## Error Classes
Exposed error types (see `errors.js`):
- `NoResponseError` – timeout or no reply
- `ResponseMalformedError` – bad checksum / frame inconsistency
- `NotSupportedCommandError` – PLC replied NAK
- `NotConnectedError` – transport not open
Use instanceof checks for granular handling.

## Timeouts & Retries
Client option `timeoutMs` controls per-operation timeout. Retry policy via `retry: { count, delayMs }` (default 1 attempt). Example:
```js
const plc = new FXPLCClient(transport, { retry: { count: 3, delayMs: 150 }, timeoutMs: 2500 });
```

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

---
Next focus: transport robustness, CLI, integration tests, richer docs.

Note: Serial transport is functional but minimally tested; use caution in production scenarios.

