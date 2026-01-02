# Changelog

All notable changes to this project will be documented here.

## [0.1.6] - 2025-08-12
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

---
Future versions will adopt Keep a Changelog style and Semantic Versioning.
