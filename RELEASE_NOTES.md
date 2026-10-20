# Release Notes

## v0.2.0 (2026-10-20)

This release adds E0 reads and PLC maintenance workflows while retaining the
classic device read/write API. Install with `npm install node-fxplc@0.2.0`.

### New capabilities

- Explicit 20-bit E0 raw reads through `readExtendedBytes`.
- CPU/parameter information, two-pass binary backup, offline image inspection
  and comparison, and live comparison through the ESM and CommonJS entrypoints.
- An explicitly selected FX3U-compatible 8K read-only maintenance profile with
  CPU/capacity checks and profile-tagged v2 image containers.
- Classic restore with a pre-write backup hook, changed-byte writes, readback
  verification and retained failure diagnostics.
- Classic native monitor access with an explicitly supplied target layout.

See the [maintenance guide](./README.md#maintenance-and-e0-reads) for examples,
profile selection, image compatibility and workflow limits.

### Upgrade guidance

Commands are sent once. The historical `retry` option remains accepted, but
replies are never recovered by replaying a command. Closed or failed TCP/serial
transports must be replaced; `setReconnect` remains accepted for source
compatibility and does not reopen them. Pending connections are cancelled on
close or timeout so that a late connection cannot send a queued write.

Custom transports must expose a valid synchronous `availableBytes` getter to
use E0 or maintenance operations. A timeout, ambiguous reply or maintenance
failure requires a new client and a new clean transport. See
[timeouts and retries](./README.md#timeouts--retries) for the full contract.

Classic v1 images with D8001 family prefix `24` and no D8102 capacity evidence
are rejected. This prevents treating an unknown allocation as a complete 8K
image. Other supported classic v1 images remain readable. The extended
maintenance profile supports only 8K reads; it does not add E1, extended restore,
firmware access or Ladder compilation. Its read-only restriction does not
disable the client's separate classic device-write methods.

### Validation

Simulated protocol tests exercise maintenance workflows, failure handling,
transport lifecycle and both package entrypoints. On 20 October 2026, the built
CommonJS package also completed 1,029 read requests on one FX3U-compatible 48MR/8K
clone, including two-pass backup and live comparison. Writes, restore and native
monitor remain unverified on hardware. See the
[hardware acceptance report](./README.md#read-only-hardware-acceptance) for the
exact scope.

The [changelog](./CHANGELOG.md) records earlier releases and the complete change
history. Planned work is tracked in the [roadmap](./ROADMAP.md).
