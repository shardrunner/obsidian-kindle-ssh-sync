/**
 * The single point where `node:sqlite` is required.
 *
 * Obsidian's app version does not guarantee `node:sqlite` in the plugin
 * runtime. Check for `DatabaseSync` at load time rather than using
 * `minAppVersion` as a proxy for the actual capability.
 */

export interface SqliteRow {
	[column: string]: unknown;
}

interface DatabaseSyncLike {
	prepare(sql: string): { all(...params: unknown[]): SqliteRow[] };
	close(): void;
}

interface NodeSqliteModule {
	DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncLike;
}

let cached: NodeSqliteModule | undefined;

export const SQLITE_REQUIREMENT =
	"Kindle SSH Sync needs require('node:sqlite').DatabaseSync in the Obsidian " +
	"plugin runtime. This build does not expose it. Node 22.5 introduced SQLite, " +
	"but version numbers alone do not guarantee availability (early versions " +
	"required a flag). Check the actual Obsidian renderer runtime.";

/** Throws with an actionable message if the runtime cannot provide node:sqlite. */
export function requireNodeSqlite(): NodeSqliteModule {
	if (cached) return cached;

	let mod: NodeSqliteModule;
	try {
		// eslint-disable-next-line @typescript-eslint/no-var-requires
		mod = require("node:sqlite") as NodeSqliteModule;
	} catch (e) {
		throw new Error(`${SQLITE_REQUIREMENT}\n\nUnderlying error: ${String(e)}`);
	}

	if (typeof mod?.DatabaseSync !== "function") {
		throw new Error(SQLITE_REQUIREMENT);
	}

	cached = mod;
	return mod;
}

/** True if this runtime can read Kindle's SQLite stores. For the load-time check. */
export function hasNodeSqlite(): boolean {
	try {
		requireNodeSqlite();
		return true;
	} catch {
		return false;
	}
}

/**
 * Open a Kindle database read-only and hand it to `fn`, always closing after.
 * Read-only matters: these are the user's only copy of the raw record, and a
 * stray write would mutate an immutable archive input.
 */
export function withDatabase<T>(path: string, fn: (db: DatabaseSyncLike) => T): T {
	const { DatabaseSync } = requireNodeSqlite();
	const db = new DatabaseSync(path, { readOnly: true });
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

/**
 * Run a query, returning [] if the table does not exist.
 *
 * The schema differs across firmware, so a missing table or column is
 * tolerated. That tolerance is scoped to *missing schema*: a malformed row
 * still surfaces as a hard failure rather than being silently dropped.
 */
export function queryOptional(db: DatabaseSyncLike, sql: string): SqliteRow[] {
	try {
		return db.prepare(sql).all();
	} catch (e) {
		const msg = String(e);
		if (/no such table|no such column/i.test(msg)) return [];
		throw e;
	}
}
