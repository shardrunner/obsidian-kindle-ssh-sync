# Test fixtures

`npm test` uses synthetic data and needs no personal cache.
`npm run test:oracle` compares against this plugin's frozen decode of a real
library; it skips when `cache/` or `golden.json` is absent.
`npm run test:oracle:strict` fails instead. This is a regression baseline,
not an independent proof of decoder correctness.

## Fixture layout

```text
test/fixtures/
  cache/           live cache view: cc.db, vocab.db, optional fmcache.db,
                   archive.json, documents/, thumbnails/
  golden.json      frozen decoder output
  pull.tar         GNU-format tar in device path layout
  ssh/host_ed25519  committed test-only SSH key for the loopback server
```

Personal caches, golden data and tar captures are git-ignored. Keep them local;
the committed SSH key is only for tests, not a real device credential.

## Regeneration

Only after an intended decoder change, review the differences and refreeze:

```sh
npm run fixtures:golden
```

Never regenerate simply to make an unexplained failure pass. To replace the
entire fixture set from an existing cache:

```sh
scripts/build-fixtures.sh [plugin-cache-dir]
```

This **replaces `test/fixtures/cache/`, `pull.tar` and `golden.json`**. The default
source is `$XDG_DATA_HOME/kindle-ssh-sync/` (fallback
`~/.local/share/kindle-ssh-sync/`). It copies the live view, not raw objects or
snapshots; a different library requires re-measuring the assertions below.

`pull.tar` is generated with `tar --format=gnu` to exercise GNU LongName entries
for paths too long for ustar. It is not the separately captured live BusyBox
stream. A live-stream structural regression test could supplement it; do not
replace the paired cache/golden fixture with a different device snapshot.

## Measured baseline

These are snapshot counts (live cache of 2026-09-27), not product requirements.
Re-measure on a deliberate fixture replacement rather than weakening assertions.

| Measurement | Value |
|---|---|
| Source records | 690 (534 on device; 156 off device: 154 synthetic, 2 deleted books kept by the archive) |
| Grouped notes | 634, from 55 collision groups (54 pairs, one triple) |
| KRDS containers | 442, of which 249 pair with a golden tree |
| Clipping records | 2987 |
| `cc.db` `Entry:Item` | 534 rows; 468 distinct cdeKeys across 524 populated rows |
| `vocab.db` | 2096 words, 2860 lookups |
| Generated `pull.tar` | 1221 files, 335 directories, 880 long paths |

The 156 off-device records are absent from `cc.db`. With `archive.json`, all of
them are carried forward. Without it, the 154 that still have vocabulary or
clipping traces are reconstructed with the same UUIDs; the 2 books deleted from
the device are lost (`test/oracle/idempotence.test.ts`). Reconstruction does not
guarantee identical metadata or complete reading history, so the archive is not
disposable.

Both test tiers pin `TZ=Europe/Berlin`, matching the golden's naive-local KRDS
timestamps. Direct test invocations need the same timezone. See
[development](../../docs/DEVELOPMENT.md) for commands.
