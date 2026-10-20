# Roadmap

Planned work for node-fxplc after 0.2.0. The [README](./README.md) describes the
current API and supported profiles; the [changelog](./CHANGELOG.md) records
completed changes. Items below are goals, not support commitments.

## Hardware validation

- Validate the bounded classic register profile on the intended FX0N-60MR/RS422
  setup and additional documented FX targets.
- Extend read-only acceptance to other CPU versions, serial converters and TCP
  gateways, recording the model, interface, serial parameters and tested ranges.
- Validate device writes, classic restore and native monitor on suitable test
  equipment before claiming hardware support for those workflows.
- Establish repeatable integration procedures that keep reads separate from
  explicitly authorized mutations.

## Documentation and tooling

- Add a method-by-method API reference covering types, callback overloads,
  error codes and custom transport requirements.
- Add a CLI for information, register reads, backup and comparison, with explicit
  target/profile selection.
- Document verified cabling, converter settings and troubleshooting for tested
  hardware. Pinouts and electrical behavior must be specific to the actual
  device and cable.
- Add a transport benchmark harness and evaluate useful logging/metrics hooks.
- Keep package entrypoint checks and TypeScript declarations aligned with each
  release.

## Future investigation

- Evaluate additional CPU/memory profiles only when supported by protocol
  documentation and repeatable hardware evidence.
- Explore helpers for structured register groups and bitfields without changing
  the documented device maps.
- Evaluate host-managed reconnection helpers that create a fresh client and
  transport after failure, without automatically replaying commands.

## Contributions

Keep changes focused and include the relevant tests or validation evidence.
Hardware reports should identify the PLC model, interface, baud rate, tested
operations and observed errors. Do not include PLC program images, credentials
or other private device data in public reports.
