# Roadmap

Detailed progression and planned work for node-fxplc.

## Implemented
- Frame build/parse (STX/ETX + hex payload + checksum)
- Bit, single value, batch read/write helpers
- Raw byte read/write
- Basic TCP transport (optional delayed start flush, simple auto-reconnect hook via `setReconnect`)
- Basic Serial transport (7E1 settings typical for FX, buffer accumulator)
- Locking to serialize protocol frames
- Timeouts & simple retry wrapper
- Checksum util & unit tests (limited scope)
- Base structures (RegisterDef, NumberType, Commands)
- Custom errors
- Core FXPLCClient (main methods; no advanced serial flush yet)
- Protocol utilities (checksum)
- Basic unit tests (checksum, registerdef, readBit parsing)

## In Progress / Planned
- Harden reconnect / transient error handling
- Real integration tests (physical FX PLC over RS232 / TCP gateway)
- Example CLI
- Detailed API documentation
- Extended number types & block optimizations
- TypeScript typings / JSDoc enrichment (partially done via index.d.ts)
- Logging improvements & metrics hooks
- Advanced serial flushing / line discipline tweaks
- Extensive validation & edge-case coverage

## Hardware / Cabling (Planned Documentation)
Documentation to be added (and moved to a dedicated HARDWARE.md later) covering:

### FX RS422 Mini-DIN (Adapter) to USB RS422 Converter (Typical)
Most FX series (and many clones) expose RS422 differential pairs. A typical 6-pin Mini-DIN breakout (via Mitsubishi programming cable) maps to differential pairs labeled SD+, SD-, RD+, RD-. Consult your specific cable datasheet.

Reference signal roles:
- SD+ / SD- : PLC transmit pair (data PLC -> PC)
- RD+ / RD- : PLC receive pair (data PC -> PLC)
- SG (Signal Ground) : Common reference

Example wiring summary (to a USB RS422 adapter):
| PLC Signal | Adapter Side |
|------------|--------------|
| SD+        | RX+          |
| SD-        | RX-          |
| RD+        | TX+          |
| RD-        | TX-          |
| SG (GND)   | GND          |

Some inexpensive clones merge SD/RD (half‑duplex); if so, a 2-wire (A/B) configuration may appear – this library expects full-duplex timing but usually still works; increase retries if frames are dropped.

### Electrical Notes
- Use a proper isolated converter where possible to avoid ground loops.
- Keep cable length moderate; RS422 supports long distances, but noise can corrupt frames—enable retry logic.
- Maintain 7E1 serial parameters matching PLC config.

### Future Additions
- HARDWARE.md with photos / ASCII diagrams
- Tested converter list
- Troubleshooting table (noise, echo, missing ACK)

If you have confirmed pinouts or schematics for clone units, please open an issue so we can consolidate accurate diagrams.

## Nice-to-Have / Future Ideas
- TypeScript migration or automated d.ts generation with JSDoc + tsc
- Benchmark harness (latency / throughput per transport)
- Optional pooled client factory
- Health check / watchdog utilities
- Higher-level abstractions (bitfield mappers, structured register groups)
- CLI: scan / quick read / batch script runner

## Contribution Notes
Prefer small, focused PRs. Please include:
- Clear description & rationale
- Tests (unit/integration) where feasible
- No breaking changes to existing public API without discussion

## Changelog Policy (future)
Once reaching v0.2.0 a CHANGELOG.md will track user-facing changes.

---
Feedback & hardware test reports are extremely valuable at this pre-release stage.
