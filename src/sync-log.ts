import * as fs from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./device/cache";
import { SyncStats } from "./types";

export interface SyncLogEntry {
	startedAt: string;
	durationMs: number;
	source: "device" | "cache";
	outcome: "success" | "failed" | "cancelled" | "recovered";
	/** Collected so far on failure or cancellation; the full list on success. */
	warnings: string[];
	/** Present only on success. */
	stats?: Omit<SyncStats, "warnings">;
	cacheSummary?: string;
	/** Stack trace when available. */
	error?: string;
}

/**
 * Keep a diagnostic trail in the cache: one line per sync attempt in
 * `sync-log.jsonl`, and the latest attempt in full in `last-sync-report.json`.
 * Call while holding the sync lock.
 */
export function recordSync(cacheRoot: string, entry: SyncLogEntry): void {
	// The atomic write also creates the cache directory for the append.
	writeFileAtomic(path.join(cacheRoot, "last-sync-report.json"), Buffer.from(JSON.stringify(entry, null, 1) + "\n"));
	fs.appendFileSync(path.join(cacheRoot, "sync-log.jsonl"), JSON.stringify(entry) + "\n");
}
