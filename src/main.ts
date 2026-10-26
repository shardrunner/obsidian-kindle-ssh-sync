import { Notice, Plugin, parseYaml } from "obsidian";
import { DEFAULT_SETTINGS, KindleSyncSettings, LibraryJson } from "./types";
import { KindleSyncSettingTab } from "./settings-tab";
import { syncLibraryToVault, validateVaultSettings } from "./vault-writer";
import { VaultTransaction } from "./vault-transaction";
import { SyncReportModal } from "./sync-report-modal";
import { recordSync, SyncLogEntry } from "./sync-log";
import { buildLibrary } from "./decode/build";
import { groupForPresentation, PresentationGroup } from "./decode/archive";
import { hasNodeSqlite, SQLITE_REQUIREMENT } from "./decode/sqlite";
import { formatBytes, pullFromDevice } from "./device/pull";
import { CacheLock, defaultCachePath, recoverCachePromotion, readCacheSizes, SIZE_WARNING_BYTES, resolveCachePath } from "./device/cache";

export default class KindleSyncPlugin extends Plugin {
	settings: KindleSyncSettings = { ...DEFAULT_SETTINGS };
	private unloaded = false;
	private progress: Notice | undefined;
	private isSyncing = false;
	private abortController: AbortController | undefined;

	async onload() {
		await this.loadSettings();
		if (this.unloaded) return;
		this.addCommand({ id: "cancel-kindle-sync", name: "Kindle: Cancel sync", callback: () => this.cancelSync() });
		this.addSettingTab(new KindleSyncSettingTab(this.app, this));

		// Obsidian's version does not guarantee node:sqlite in its plugin runtime.
		// Check the capability at load time rather than relying on minAppVersion.
		if (!hasNodeSqlite()) {
			new Notice(`Kindle SSH Sync could not load.\n\n${SQLITE_REQUIREMENT}`, 0);
			console.error("Kindle SSH Sync:", SQLITE_REQUIREMENT);
			return;
		}

		this.addCommand({
			id: "sync-kindle-device",
			name: "Kindle: Sync from device and update vault",
			callback: async () => {
				await this.runSync({ fromDevice: true });
			},
		});

		this.addCommand({
			id: "sync-kindle-cache",
			name: "Kindle: Update vault from cache",
			callback: async () => {
				await this.runSync({ fromDevice: false });
			},
		});
	}

	onunload() {
		this.unloaded = true;
		this.cancelSync();
		this.progress?.hide();
		this.progress = undefined;
	}

	cancelSync() {
		this.abortController?.abort();
	}

	async loadSettings() {
		const persisted = await this.loadData();
		this.settings = { ...DEFAULT_SETTINGS, ...persisted };
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private async runSync(options: { fromDevice: boolean }) {
		if (this.unloaded) return;
		// The filesystem lock excludes every other writer; this only gives a
		// repeated command in this instance a friendlier message.
		if (this.isSyncing) {
			new Notice("Kindle Sync: A sync operation is already in progress.");
			return;
		}

		this.isSyncing = true;
		const settings = { ...this.settings };
		this.abortController = new AbortController();
		const signal = this.abortController.signal;
		const startedAt = Date.now();
		const warnings: string[] = [];
		const cacheRoot = resolveCachePath(settings);
		let lock: CacheLock | undefined;
		let result: Pick<SyncLogEntry, "outcome" | "warnings" | "stats" | "cacheSummary" | "error"> = { outcome: "failed", warnings };
		const progress = (message: string) => {
			if (this.unloaded || signal.aborted) return;
			if (this.progress) this.progress.setMessage(`Kindle Sync: ${message}`);
			else this.progress = new Notice(`Kindle Sync: ${message}`, 0);
		};

		try {
			signal.throwIfAborted();
			validateVaultSettings(settings);
			const transaction = new VaultTransaction(this.app, settings, signal);
			// One lock for every sync on this machine: all caches, archives and
			// vault journals, whatever the vault or configured cache.
			lock = CacheLock.acquire(defaultCachePath());
			const pendingRoot = await transaction.pendingCacheRoot();
			signal.throwIfAborted();
			// A pending journal may name the cache from before a settings change.
			recoverCachePromotion(pendingRoot ?? cacheRoot);
			const recovered = await transaction.recover();
			signal.throwIfAborted();
			if (recovered) {
				result = { outcome: "recovered", warnings };
				if (!this.unloaded) new Notice("Kindle Sync: recovered interrupted writes. Wait for metadata to refresh, then sync again.", 12000);
				return;
			}

			if (options.fromDevice) {
				const pull = await pullFromDevice({
					cacheRoot,
					settings,
					signal,
					onProgress: progress,
				});
				if (pull.trustedHostKey) {
					this.settings.kindleHostFingerprint = pull.trustedHostKey;
					await this.saveSettings();
					warnings.push(`Trusted the Kindle's SSH host key ${pull.trustedHostKey} on first connection.`);
				}
				signal.throwIfAborted();
				warnings.push(...pull.warnings);
				progress(
					`Pulled ${pull.fileCount} files ` +
						`(${formatBytes(pull.bytesPulled)}, ${pull.newObjects} new` +
						`${pull.excluded > 0 ? `, ${pull.excluded} skipped` : ""}).`
				);
			} else {
				progress("Rebuilding from the cache...");
			}

			signal.throwIfAborted();
			progress("Decoding the cache...");
			// Synchronous: about 0.2 s for a 700-book library, so no worker.
			const built = buildLibrary(cacheRoot);
			signal.throwIfAborted();
			warnings.push(...built.warnings);

			// Group source records into notes, carrying the stable group state
			// forward so an existing note keeps its kindle_uuid.
			const grouped = groupForPresentation(built.library.books, built.archiveGroups);
			for (const c of grouped.conflicts) {
				warnings.push(
					`Merged records disagree on ${c.field}: ${c.values.join(" vs ")} (${c.uuids.join(", ")})`
				);
			}

			const library: LibraryJson = { ...built.library, books: grouped.books };

			signal.throwIfAborted();
			progress(`Writing ${library.books.length} notes...`);
			const stats = await syncLibraryToVault(this.app, library, settings, transaction, parseYaml, serializeArchive(built.library, grouped.groups));
			signal.throwIfAborted();
			stats.warnings.unshift(...warnings);

			const cacheSummary = await summarizeCache(cacheRoot, stats.warnings);
			signal.throwIfAborted();
			const { warnings: reported, ...counts } = stats;
			result = { outcome: "success", warnings: reported, stats: counts, cacheSummary };
			if (this.unloaded) return;

			new SyncReportModal(this.app, {
				stats,
				cacheSummary,
				fromDevice: options.fromDevice,
				durationMs: Date.now() - startedAt,
			}).open();
		} catch (err: unknown) {
			result = signal.aborted
				? { outcome: "cancelled", warnings }
				: { outcome: "failed", warnings, error: err instanceof Error ? err.stack ?? err.message : String(err) };
			if (this.unloaded) return;
			if (signal.aborted) {
				new Notice("Kindle Sync cancelled. Retry sync to recover any interrupted writes.", 6000);
				return;
			}
			console.error("Kindle Sync error:", err);
			const message = err instanceof Error ? err.message : String(err);
			new Notice(`Kindle Sync failed:\n${message}`, 12000);
		} finally {
			// Log only under the lock: a locked-out attempt must not touch the cache.
			if (lock) {
				try {
					recordSync(cacheRoot, {
						startedAt: new Date(startedAt).toISOString(),
						durationMs: Date.now() - startedAt,
						source: options.fromDevice ? "device" : "cache",
						...result,
					});
				} catch (err: unknown) {
					console.error("Kindle Sync log error:", err);
					const message = err instanceof Error ? err.message : String(err);
					if (!this.unloaded) new Notice(`Kindle Sync could not write its log:\n${message}`, 12000);
				}
			}
			// Never release on abort itself: awaited work must settle first.
			lock?.release();
			this.progress?.hide();
			this.progress = undefined;
			this.abortController = undefined;
			this.isSyncing = false;
		}
	}
}

/**
 * The archive is the authoritative decoded record for an offline rebuild:
 * ungrouped source records, the stable group state, and the top-level
 * vocabulary word layer that per-book lookups do not carry.
 *
 * No separate library file is written: the notes and this archive are the
 * only outputs.
 */
function serializeArchive(
	library: Required<LibraryJson>,
	groups: PresentationGroup[]
): string {
	const payload = {
		books: library.books,
		groups,
		vocabulary: library.vocabulary,
	};
	return JSON.stringify(payload, null, 1);
}

async function summarizeCache(cacheRoot: string, warnings: string[]): Promise<string> {
	const sizes = await readCacheSizes(cacheRoot);
	if (sizes.objectStoreBytes + sizes.manifestBytes + sizes.archiveBytes >= SIZE_WARNING_BYTES) {
		warnings.push(`Cache exceeds ${formatBytes(SIZE_WARNING_BYTES)}. Check available disk space and move the cache to a larger disk if needed; nothing is automatically pruned.`);
	}
	return (
		`Raw archive: ${formatBytes(sizes.objectStoreBytes)} in ${sizes.objectCount} objects, ` +
			`${formatBytes(sizes.manifestBytes)} of manifests, ` +
			`${formatBytes(sizes.archiveBytes)} archive.json. Nothing is ever pruned.`
	);
}
