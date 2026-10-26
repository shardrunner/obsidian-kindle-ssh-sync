---
summary: Device evidence, unsupported inputs, runtime constraints, and remaining validation gaps.
---

# Limitations

## Compatibility evidence

A historical Paperwhite 2 / FW 5.11.2 pull on 2026-08-23 yielded 1,242 files and
a 685-source-record decode matching the then-frozen baseline. It predates later
changes and is not current live validation. The
[oracle fixtures](../test/fixtures/README.md) are one library, not a firmware
compatibility matrix.

- The measured device had no `fmcache` directory, and a Paperwhite 2 cannot
  reach the 5.16+ firmware that writes it. The fmcache decoder stays anyway
  because moving to a newer Kindle is plausible; its read states/sessions and
  populated series metadata have only synthetic coverage until then.
- KRDS raw fallback/trailing-field behavior has synthetic tests; the measured
  real-library decode did not exercise those paths.
- The tar oracle uses a generated GNU archive, not the separately captured live
  BusyBox stream. Real Obsidian/device checks remain separate from CI and the
  mocked bundle smoke test.

## Input and output boundaries

- Linux desktop only, with renderer `node:sqlite`; no mobile, USB mass-storage
  or cloud import. Password SSH only; connection details are in [setup](SETUP-KINDLE.md).
- The decoder handles catalogue/vocabulary databases, optional fmcache read
  states/sessions, selected KRDS sidecars and clippings. It does not decode X-Ray,
  popular highlights, end actions or aggregate telemetry. Raw files may still
  be retained.
- Clipping title matching is ambiguous for identically named books; unrecognized
  header/date formats may lack metadata. Rendering escapes imported text, but
  retained Markdown and user-configured Base embeds remain active.
- No generated `.base` file, template engine, configurable filename pattern,
  dry-run preview or multi-device conflict UI.
- No pre-release cache/archive/journal migration. A first sync cannot recreate
  history absent from both the device and an existing archive.
- Reading-speed statistics are device-derived estimates: `kindle_wpm` can be
  implausibly high. On the measured firmware, `samples_recorded` can be zero
  despite populated `speed_samples`: raw sample arrays and the reading-cluster
  count are separate fields, not interchangeable measures of reading activity.
- KRDS naive-local timestamps depend on the host timezone; changing it can alter
  rendered times.

## Operational limits

Decode and publication preparation are synchronous; large libraries can pause
Obsidian and increase memory use. Pull staging is bounded (currently 256 MiB,
100,000 entries, at most 64 MiB per member); raw history grows without automatic
pruning. Journals finish partial writes rather than undoing them, and concurrent
external edits can still race with checks. See [recovery](SETUP-KINDLE.md#storage-and-recovery)
for practical steps and [architecture](ARCHITECTURE.md) for the implementation.
