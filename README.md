# Kindle SSH Sync

[![CI](https://github.com/shardrunner/obsidian-kindle-ssh-sync/actions/workflows/ci.yml/badge.svg)](https://github.com/shardrunner/obsidian-kindle-ssh-sync/actions)

Pull metadata, progress, reading stats and highlights from a **jailbroken Kindle
over SSH** into Obsidian, with one Markdown note per book. Linux desktop only;
TypeScript, no Python runtime.

> **Disclaimer:** This project is vibe coded for personal use. Use at your own risk.

A personal hobby project for one legacy Kindle on a single-user computer.
Published as-is, **without warranty or a support commitment**. The aim is easy
access to reading history, not a general-purpose sync platform.

## What it does

- Generates book notes with properties, highlights, vocabulary counts and covers.
- Groups related source records by book identifier and language.
- Keeps raw snapshots and a decoded archive outside the vault for offline rebuilds.
- Recovers interrupted writes by finishing them on the next sync.

[Example generated note](docs/demo/Alex%20Example--The%20Garden%20of%20Small%20Ideas.md)
uses an invented book and highlights. Generated bodies are replaced on sync:
keep personal writing in separate notes. Custom frontmatter and recognized
highlight blocks are retained. Treat the configured cover folder as generated
output too: changed covers are replaced with a warning.

## Requirements and install

- Jailbroken Kindle with usbnet/SSH and device-side `find` / `tar -T`.
- Linux Obsidian whose renderer exposes `require('node:sqlite').DatabaseSync`.
  Check that expression in Obsidian's developer console; the app version alone
  does not establish compatibility.
- For building: Node 22, 24 or 26 and npm (the CI versions).

From a checkout:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

Copy **`main.js` and `manifest.json`** into
`<vault>/.obsidian/plugins/kindle-ssh-sync/`, reload Obsidian and enable the plugin.
No stylesheet is needed. Review the output folders before the first sync;
[setup and recovery](docs/SETUP-KINDLE.md) covers device settings and defaults.

## Commands

- **Kindle: Sync from device and update vault** — pull, decode and write notes.
- **Kindle: Update vault from cache** — rebuild without SSH; updates notes and
  the decoded archive, so it is not a preview.
- **Kindle: Cancel sync** — request cancellation. Synchronous work finishes its
  current step; interrupted writes may need recovery on the next run.

## Documentation

Start at the [documentation index](docs/README.md):
[setup](docs/SETUP-KINDLE.md), [architecture](docs/ARCHITECTURE.md),
[limitations](docs/LIMITATIONS.md), and [development](docs/DEVELOPMENT.md).

Bug reports: include versions, the exact error and steps to reproduce in
[GitHub issues](https://github.com/shardrunner/obsidian-kindle-ssh-sync/issues).
Leave passwords and personal data out of attachments. Feature work is driven by
personal use, not a promised roadmap.

## Credits and licence

Extraction is ported from
[`kindle-reading-dashboard`](https://github.com/zevisvei/kindle-reading-dashboard)
by **zevisvei**. `src/decode/krds.ts` ports `krds.py` by **John Howell**
(© 2019, GPL v3): [KRDS](https://github.com/K-R-D-S/KRDS),
[original discussion](https://www.mobileread.com/forums/showthread.php?t=322172).

Copyright © 2026 Michael Brunner. Licensed under the
[GNU General Public License v3.0](LICENSE) only, as both upstream projects
specify version 3 without a later-version option.
