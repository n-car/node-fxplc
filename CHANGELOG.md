# Changelog

User-facing changes are recorded here. See [README](./README.md) for usage and [release notes](./RELEASE_NOTES.md) for the current upgrade guidance.

## [0.2.0] - 2026-10-20

### Added

- JavaScript `readExtendedBytes` with explicit E0 commands and checked 20-bit addresses.
- Explicit `ProgramProfile` selection, CPU/parameter reads, two-pass binary backup, offline inspection/comparison and live comparison.
- A bounded FX3U-compatible 8K read-only profile with D8101/D8102 validation and profile-tagged v2 image containers; no E1 or extended restore.
- Classic restore with changed-byte writes, readback verification, an optional pre-write persistence hook and retained failure diagnostics.
- Classic native monitor operations with explicit target-specific layout and ownership verification.
- Promise/callback declarations and simulated integration tests through the ESM/CommonJS Node package.

### Changed

- E0/maintenance operations require `transport.availableBytes` and hold the client lock for the whole workflow; errors expose stable codes and ambiguous failures require a new client/transport without replay.
- Classic v1 images for D8001 family prefix 24 are rejected without D8102 capacity evidence; ordinary classic v1 image layout is unchanged.

### Fixed

- Cancel pending TCP/serial opens on timeout or close, preventing a late connection from sending a queued write. Closed or failed transports require replacement; `setReconnect` no longer revives them.
- Reject invalid callbacks before scheduling maintenance, preserve the legacy empty-response error, and handle long command deadlines without Node timer overflow.

### Validated

- On 2026-10-20, the built CommonJS API and production serial transport completed 1,029 read requests on one FX3U-compatible 48MR/8K clone over CH340 at 38400 7E1. CPU/parameters, raw E0, two-pass backup, two-pass live comparison and before/after status polling passed; the port's close event was confirmed.
- Hardware validation covers the bounded 16,096-byte program/parameter window with host-specific serial line control. No writes, restore or native monitor were tested; FX0N-60MR/RS422 and other models remain unverified. See [hardware acceptance](./README.md#read-only-hardware-acceptance) for scope and limitations.

## [0.1.8] - 2026-10-20

### Fixed

- Correct classic Mitsubishi FX addressing for octal X/Y labels, special M/D registers, counter contacts, and 32-bit counters.
- Validate device ranges, numeric spans, and the 1–64-byte transfer limit before transmission.
- Split batch operations using actual contiguous byte addresses and validate every value before writing.
- Reject malformed, oversized, unexpected, and buffered replies without replaying commands.

### Changed

- The legacy `retry` option remains accepted but no longer replays commands. Ambiguous failures permanently invalidate the client and require a new client with a clean transport.

### Added

- Manual-conformance tests and documentation of the supported classic FX register profile and protocol limitations.

## [0.1.7] - 2026-07-30

### Fixed

- Provide dedicated ESM/CommonJS TypeScript entrypoints and explicit module metadata for built packages.
- Complete callback support in the mock client.

## [0.1.6] - 2026-01-02

### Changed

- Refactor FXPLCClient ESM source and simplify lazy debug loader.

## [0.1.5] - 2025-08-12

### Fixed

- Lazy debug loading now works in both ESM and CommonJS.

## [0.1.4] - 2025-08-12

### Added

- ESM and CJS build configs and `dist/` outputs.
- README guidance for ESM and CommonJS usage.

### Changed

- Package exports/main/module now point to `dist/` outputs.

### Removed

- Obsolete `lib/index.cjs` and `lib/index.cjs.js`.

## [0.1.3] - 2025-08-11

### Fixed

- CommonJS `require()` now resolves to `index.cjs` via exports.

### Changed

- Renamed `index.cjs.js` to `index.cjs`.

## [0.1.2] - 2025-08-11

### Added

- CommonJS `require()` entrypoint via `index.cjs.js` and exports mapping.

## [0.1.1] - 2025-08-11

### Added

- `LICENSE` and README license section.
- `RELEASE_NOTES.md` and `CHANGELOG.md`.
- README badges (npm version/downloads/license, git tag).

### Changed

- Package metadata (description, repository, keywords, scripts, exports).

## [0.1.0] - 2025-08-11

### Added

- Initial release: core FXPLCClient with bit / number / batch read & write.
- TCP and Serial transports (basic implementation) + Null transport & Mock client.
- Register parsing, number type converters, checksum util.
- Simple retry logic, timeouts, event emission.
- Type declarations (index.d.ts).
- Documentation (README, ROADMAP) and initial tests.

### Notes

Pre-release; limited hardware validation.
