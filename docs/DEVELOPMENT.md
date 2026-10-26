---
summary: Build and test commands, regression expectations, demo generation, and release process.
---

# Development

TypeScript with `ssh2` and built-in `node:sqlite`; no Python runtime.
The [architecture source map](ARCHITECTURE.md#source-map) identifies the entry
points. CI runs Node 22, 24 and 26 on Linux.

## Local checks

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run test:bundle
```

`npm test` is portable: generated SQLite/cache data, mock vaults, parser tests
and loopback SSH. Run it and typecheck for code changes. Build and bundle smoke
are especially important for `main.ts`/bundling changes; the smoke test runs the
actual bundle against mocked Obsidian, not a real vault. `npm run dev` watches
and rebuilds during development.

The real-library suite is separate:

```sh
npm run test:oracle         # skips if private fixtures are absent
npm run test:oracle:strict  # fails if absent
```

See [fixtures](../test/fixtures/README.md) for the frozen baseline and regeneration
rules. A golden refreeze is not a fix for unexplained test failures. Both test
tiers set `TZ=Europe/Berlin`; use it when running one file directly:

```sh
TZ=Europe/Berlin node --import tsx --test test/cache.test.ts
```

Changes to `src/decode/normalize.ts` rounding or title normalization affect
matching and the measured golden output.

## Demo

```sh
TZ=Europe/Berlin node --import tsx scripts/generate-demo.ts
```

This refreshes the [synthetic note](demo/Alex%20Example--The%20Garden%20of%20Small%20Ideas.md).
The demo test checks it against the renderer; it has no Base embed dependency.
For a future plugin-directory listing, the demo can supply note/Properties
screenshots; capture a sync-report example separately. Screenshots are not yet
included.

## Releases

Update `package.json`, `package-lock.json`, `manifest.json` and the
`versions.json` compatibility map together. A `vX.Y.Z` tag triggers
[the release workflow](../.github/workflows/release.yml); its version must match
both package and manifest. The workflow tests, builds and smoke-tests, then
publishes `main.js` and `manifest.json` in a separate job. Workflow presence
alone does not mean a release or Community Plugin listing exists.

Real-device/Obsidian validation is separate from CI; see
[limitations](LIMITATIONS.md) for what has actually been exercised.
