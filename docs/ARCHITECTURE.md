---
summary: Source map, sync lifecycle, record identities, retention rules, and durable publication.
---

# Architecture

See [setup](SETUP-KINDLE.md) for settings/recovery procedures and
[limitations](LIMITATIONS.md) for coverage and known constraints.

## Source map

| Code | Responsibility |
|---|---|
| `src/main.ts`, `settings-tab.ts`, `types.ts` | Commands, settings, lock and recovery orchestration |
| `src/device/{ssh,pull,tar,cache}.ts` | SSH stream, bounded tar parsing, raw cache and promotion journal |
| `src/decode/{build,cc-db,vocab-db,fmcache-db,krds,clippings}.ts` | SQLite, sidecar and clipping decode; archive reconciliation |
| `src/decode/archive.ts`, `src/library.ts` | Presentation grouping, value unions and validation |
| `src/book-note.ts`, `src/note-render.ts` | Fields, filenames, imported-text escaping and highlight retention |
| `src/vault-writer.ts`, `vault-transaction.ts`, `vault-path.ts` | Preflight, backlink-aware publication and journal replay |

## Run order

`main.ts` owns this order for both device sync and offline rebuild:

1. Validate settings and acquire `defaultCachePath()/.lock`, shared across
   vaults, configured caches and Obsidian instances.
2. Recover cache promotion, using the pending vault journal's cache root if
   present. Recover the vault journal next. Successful vault recovery ends the
   invocation; a later sync resumes normal work.
3. Device mode streams databases, sidecars, clippings and thumbnails through one
   SSH `find`/`tar -T` command. `fmcache.db` is included only if present. Nonzero
   remote exit, invalid tar or exceeded limits prevents promotion.
4. Stage accepted bytes in memory; append-merge cached and incoming
   `My Clippings.txt` before writing raw objects, a snapshot and the live view.
   Files absent from subsequent pulls stay in the live cache.
5. Decode the cache synchronously with `buildLibrary()`; both modes require
   `cc.db`. A missing decoded archive is a first run; a damaged archive is an
   error, not an empty library. Group the source records into notes.
6. Serialize the ungrouped archive and group state, preflight/render notes, then
   publish via `VaultTransaction`. Publish `archive.json` last, including for
   archive-only changes. Finally scan cache sizes once for the report.
7. Before releasing the lock, record every attempt that acquired it (success,
   failure, cancellation or recovery) in the configured cache: a line in
   `sync-log.jsonl` and the full entry in `last-sync-report.json`. A failed
   log write is reported but does not change the sync outcome.

The uncompressed tar stream avoids per-file SSH round trips and slow compression
on the Kindle. BusyBox `tar` needs newline-separated `-T` input, not GNU `--null`.
Decode, promotion, grouping, rendering and serialization use the main thread;
manual syncs accept a short UI pause rather than a separate worker system.

## Records and retention

- **Source identity:** `uuid` identifies an ungrouped archive record. Catalogue
  rows match archived rows by UUID, then unambiguous GUID/cdeKey, then normalized
  title with author. A matched record keeps its uuid; when the catalogue has
  reassigned `p_uuid`, the new value is stored as `catalogueUuid` and matched
  first next time. Only the selected archive record is replaced: a current
  row's GUID/cdeKey cannot discard a different source after a UUID match.
  Missing records can be carried forward; vocabulary- and
  clipping-only books can become synthetic records.
- **Note identity:** trimmed `cdeKey` plus canonical primary language forms a
  presentation group. Missing/invalid grouping values stay solo. Group state
  retains `sourceUuids` and a stable `primaryUuid` (`kindle_uuid`); display fields
  may come from another member. Conflicting metadata is reported. The source
  records remain separate in the archive.
- **Raw history:** immutable `raw-objects/<sha256>` plus `snapshots/*.json`
  manifests are not pruned. Every reused object is hash-checked during pulls.
  The live cache is a convenience view, not the only copy of prior bytes.
- **Decoded history:** `archive.json` holds books, groups and vocabulary words.
  Per-book vocabulary uses `unionLookups`, annotations `unionAnnotations`, and
  clippings `unionClippings`, both against the archived record and across
  group members. Pull-time text merging protects cached clippings against
  device pruning. A matched record starts from its archived copy: fields the
  decoder does not produce carry forward, while current device facts win, even
  when absent. No separate `library.json` is written.
- **Full decoded history by design:** the archive keeps every decoded field,
  including ones no note renders today (timer clusters and outliers, series,
  fmcache sessions, the vocabulary word layer). Raw objects could rebuild
  them, but the archive is the history notes and later features read; do not
  trim it to rendered fields.

## Kindle field semantics

Keep these device observations distinct rather than simplifying them into one
"reading progress" value:

- `percentFinished` measures position; `stats.percent_read` estimates text read
  and can exceed 100%. Display progress prefers position, then APNX page fraction,
  then text-read percentage, then a read-state fallback.
- Legacy `p_readState = unread` does not prove the book was never read; a `read`
  mark can still be useful without sidecars. Activity also considers stats,
  progress, annotations, clippings and vocabulary. `buildActiveBook()` combines
  catalogue/fmcache marks and progress for status; `isFinished()` also uses a 93%
  threshold.
- `kindle_last_access` is the catalogue's `p_lastAccess`, not a reading-session
  timestamp. `kindle_last_read` uses sidecar reading-position times.
- Clippings have no book ID: normalized title matching can confuse identically
  named books. Do not use title or cdeKey as a universal source-record identity.

## Ownership and publication

Book notes in the target tree are owned by `meta_generator: kindle_sync` and a
nonempty `kindle_uuid`. Every clipping belongs to exactly one book note: titles
that match nothing become synthetic records, keyed by a hash of the raw title
when the normalized title is empty. Metadata discovers notes; current bytes
supply both preserved frontmatter (parsed with Obsidian's YAML parser) and
overwrite preconditions. Malformed frontmatter, duplicate UUIDs, occupied note destinations and conflicting
edits stop the batch. Binary covers have no ownership marker: equal bytes are
reused, differing files are replaced with a warning, and directory occupants fail.

Existing notes are written at their **original paths before moves**, so staged
content cannot undo Obsidian's backlink updates. Movers park at temporary paths,
then `FileManager.renameFile` moves them to final names. New notes follow once
those destinations are free.

Generated device facts use `kindle_*`; the plugin does not generate
`book_status` or `book_rating`. Those personal catalogue judgements remain
user-owned frontmatter. Custom frontmatter survives where incoming fields are
absent; supplied plugin fields win. A highlight's identity is its type,
position and text; the Kindle re-saves unchanged highlights seconds apart, so
repeats merge into the first and show its date only. Recognized `## Highlights`
blocks the source no longer carries are retained. Other body edits are
replaced. Orphaned owned notes are marked off-device, not deleted.

## Durability and cancellation

Cache promotion validates object hashes before replaying its manifest/live view.
The per-vault journal in the default data directory records operations, a cursor
and the snapshot cache root. Writes accept original-content hashes or exact
already-published output; moves check current UUIDs. A changed archive also stops
replay rather than being overwritten. Completed operations checkpoint the cursor;
the journal is removed after archive publication.

These are **roll-forward journals**, not rollback or atomic multi-file updates.
Checks cannot prevent an external edit between check and write. Cancellation or
unload stops SSH and pauses at pipeline/operation boundaries, not inside
synchronous decode; started I/O settles before lock release. See
[setup](SETUP-KINDLE.md#storage-and-recovery) for recovery steps.
