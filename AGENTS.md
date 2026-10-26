# Agent steering

- Personal hobby tool: one legacy Kindle, one Linux user. Prefer simple, low-friction
  solutions; no speculative features, privacy policy or multi-user hardening.
  A newer Kindle is plausible, so keep newer-firmware decode paths (fmcache), and
  `archive.json` stays a full decoded history, not just rendered fields.
- Keep meaningful data-integrity checks: corruption detection, overwrite protection
  and interrupted-write recovery. Fail clearly rather than silently dropping data.
- Read [the docs index](docs/README.md), then only the relevant reference.
- `src/main.ts` owns locking/recovery order. Publish vault changes through
  `VaultTransaction`; preserve write-before-rename ordering for backlinks.
- For code changes, run `npm run typecheck` and `npm test`; for lifecycle/bundling
  changes also build and run `test:bundle`. See [development](docs/DEVELOPMENT.md).
- Use synthetic tests. Reading the live cache is fine; ask before writing to it or
  accessing the real vault or device. Don't commit ignored settings, caches or
  personal fixtures. Never refreeze the oracle just to silence a failure; see
  [fixture rules](test/fixtures/README.md).
- No pre-release compatibility layers unless requested. Preserve source-vs-note
  identities. The decoder branched off the Python upstream; change inherited
  behavior when it improves results, not to match or diverge for its own sake.
- Put temporary agent plans in `docs/ai/`; on completion fold useful findings into
  maintained docs and remove the plan. Git history is the archive, not a second
  documentation tree.
