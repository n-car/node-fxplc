# Release Notes

## v0.1.6 (2025-08-12)
Internal refactor to clean up ESM source layout and simplify the lazy debug loader. No public API changes expected.

## v0.1.5 (2025-08-12)
Fix for lazy debug loading so it works in both ESM and CommonJS environments.

## v0.1.4 (2025-08-12)
Build packaging update: ESM/CJS outputs are now built into `dist/`, with updated exports and README usage guidance. Obsolete CommonJS entry files were removed from `lib/`.

## v0.1.3 (2025-08-11)
Fix CommonJS `require()` resolution by renaming `index.cjs.js` to `index.cjs` and updating exports.

## v0.1.2 (2025-08-11)
Add CommonJS `require()` compatibility via a dedicated `index.cjs.js` entrypoint and package exports mapping.

## v0.1.1 (2025-08-11)
Docs/metadata update: README badges + license section, new `LICENSE`, `CHANGELOG`, and `RELEASE_NOTES`, plus enriched package metadata.

## v0.1.0 (2025-08-11)
Early pre-release (FX framed protocol client)

### Summary
Initial publication of a Node.js library implementing the low-level framed MELSEC FX (FX0N/FX1N style) protocol. Includes core client, TCP and Serial transports, batch helpers, register parsing and TypeScript typings. Intended for experimentation and hardware feedback; not production-hardened yet.

### Added
- FXPLCClient: bit read/write, word/number read/write, batch operations, raw byte access
- Consecutive register coalescing in batch read/write
- Bit force commands (FORCE ON / OFF)
- TCP transport (flush delay, simple auto-reconnect toggle)
- Serial transport (7E1 settings, buffer accumulator)
- BufferAccumulator for incremental framed reads
- Per-operation timeout + simple retry policy
- Frame builder/parser (STX, ETX, hex payload, checksum)
- Error classes: NoResponseError, ResponseMalformedError, NotSupportedCommandError, NotConnectedError
- Numeric type converters (signed/unsigned word/dword, float)
- Mock client + Null transport
- Type definitions (index.d.ts)
- Initial docs: README, ROADMAP, CHANGELOG
- Basic unit tests (checksum, register parsing, bit read frame)

### Limitations
- Advanced reconnect/backoff not implemented
- Limited real hardware validation
- No CLI yet
- Minimal edge‑case coverage
- Serial path tested only on a small sample
- Lacks extended block optimizations & full API reference

### Quick Example
```js
import { FXPLCClient, TransportSerial } from 'node-fxplc';
const transport = new TransportSerial({ path: 'COM3', baudRate: 9600 });
const plc = new FXPLCClient(transport, { retry: { count: 3, delayMs: 100 } });
const bit = await plc.readBit('M0');
await plc.writeBit('M10', true);
const values = await plc.batchRead(['D100','D101']);
plc.close();
```

### Compatibility
Should also work with many FX‑compatible clone PLCs over RS422 if they implement the same framed command set (7E1). Enable retries if responses are intermittent.

### Roadmap
See ROADMAP.md for upcoming work (reconnect hardening, integration tests, CLI, extended docs).

### Feedback
Please report: PLC model, interface type (RS422/RS232/TCP gateway), baud rate, anomalies (timeouts, unexpected NAK, checksum errors).
