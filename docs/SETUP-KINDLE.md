---
summary: Device connection, settings defaults, storage locations, and practical sync recovery.
---

# Setup and recovery

[Installation and runtime requirements](../README.md#requirements-and-install)
assume a jailbroken Kindle with usbnet/SSH. The measured device was a Paperwhite 2
on FW 5.11.2; see [coverage limits](LIMITATIONS.md).

## Connect the Kindle

Check usbnet connectivity from a terminal:

```sh
ssh root@192.168.15.244
which find tar
tar --help | head -5
```

The computer needs its own address on the Kindle's USB network, usually
`192.168.15.201/24`; without it, traffic to the Kindle goes out the default
route and the connection times out. With NetworkManager, find the Kindle's
device with `nmcli dev` and set the address on the live device only. It is not
saved to a profile, so it lasts until the Kindle is unplugged and the port stays
free for other devices:

```sh
nmcli dev modify <USB device> ipv4.method manual ipv4.addresses 192.168.15.201/24
```

The plugin uses password authentication. Blank host/user settings use
`192.168.15.244:22` and `root`; the preset password is `kindle`. Set your actual
password if different. A custom port can be appended to the host as `:port`.

Leave **Kindle host fingerprint** blank initially. The first successful pull
records the host key; later pulls check it. After a reset/re-jailbreak, check
that you are connecting to the intended Kindle, then clear the setting to trust
its new key. Terminal `known_hosts` is not used by the plugin.

The password is saved in the vault's plugin `data.json`. Notes, cache and
journals are ordinary unencrypted files; no special file permissions are imposed.

## Output settings

| Setting | Default / meaning |
|---|---|
| Target folder | `Kindle` |
| Inactive subfolder | `inactive` under the target; blank gives a flat layout |
| Assets subfolder | `assets` under the target |
| Copy covers | Enabled; differing existing covers are replaced with a warning |
| Base view to embed | Empty; optionally set e.g. `Kindle.base#Detail` for your own Base |
| Raw cache folder | `$XDG_DATA_HOME/kindle-ssh-sync/`, falling back to `~/.local/share/kindle-ssh-sync/` |
| SSH operation timeout | 600 seconds per SSH operation, not a whole-sync deadline |

Note/asset paths are vault-relative. The cache setting is a filesystem path;
a symlink to another disk is supported. The plugin does not generate a `.base`
file. Full defaults are in `src/types.ts`.

Run **Kindle: Sync from device and update vault**, inspect the notes and report,
then try **Kindle: Update vault from cache**. A spare vault is useful for trying
out a layout; back up existing notes before changing their generator. Avoid
running an older Kindle plugin against the same notes at the same time.

Keep personal prose outside generated book notes and custom images outside the
cover folder. See [ownership rules](ARCHITECTURE.md#ownership-and-publication).

## Storage and recovery

The configured cache holds raw objects, snapshot manifests, live device files
and `archive.json`. Each sync that gets the lock appends its outcome, counts,
warnings and any error with stack trace to `sync-log.jsonl`;
`last-sync-report.json` holds the latest one in full. For example,
`jq -c '[.startedAt, .outcome, .stats.created, .stats.updated]' sync-log.jsonl`
shows the history. Nothing automatically prunes raw history; the report warns
at 2 GiB. The default data directory also holds the global `.lock` and per-vault
journals under `vault-transactions/<hash of real vault path>/transaction.json`,
even if the raw cache setting points elsewhere.

After an interrupted sync:

1. Keep the vault, default data directory and configured cache. If you changed
   the cache setting, keep the old cache named by the pending journal too.
2. Retry either sync command. Recovery finishes pending writes; it does not
   roll them back. After a successful vault recovery, wait for Obsidian metadata
   to refresh and run the command again. If the crash happened during a rename,
   check affected backlinks: Obsidian's link updates are outside this journal.
3. If a conflict is reported, preserve the named file and inspect it before
   resolving the conflict. Do not delete the journal to force progress.

Do not edit generated files during sync/recovery. Cancel/unload stops at supported
boundaries, not in the middle of synchronous work. Old pre-release cache formats
are unsupported; use a new empty cache rather than deleting your existing history.

## Troubleshooting

- **Cannot reach the Kindle:** connecting gives up after 15 s. Check cable,
  usbnet and the computer's USB network address (see
  [Connect the Kindle](#connect-the-kindle)), then IP, port and password.
- **Missing SQLite API:** check `require('node:sqlite').DatabaseSync` in the
  Obsidian console, not just in a terminal Node installation.
- **Tar error:** include the exact message and firmware version in a bug report.
  The command requires `cc.db`, `vocab.db`, thumbnails and
  `My Clippings.txt`; any of them missing fails the pull before anything is
  promoted. `fmcache.db` is optional.
- **Lock remains:** remove `defaultCachePath()/.lock` only after confirming no
  sync is running. The lock serializes syncs across Obsidian instances.
- **Missing books:** a first sync cannot recover books with no surviving device
  trace or archive entry. Clippings for unknown titles get their own notes.
