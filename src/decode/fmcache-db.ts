/**
 * Kindle fast-metrics cache (`fmcache.db`): modern read-state marks and
 * reading sessions.
 *
 * Scope is deliberately read-state + sessions only. X-Ray, popular
 * highlights, end actions and the aggregate telemetry blob are backed up as raw
 * files but never decoded.
 *
 * UNVERIFIED ON THIS DEVICE. `/mnt/us/system/fmcache/` was measured absent,
 * and the pull lists `fmcache.db` only when it exists. Kept deliberately: the
 * Paperwhite 2 cannot reach 5.16+, but moving to a newer Kindle is plausible. A missing or 0-byte
 * file decodes to no marks; the decode paths are exercised only by synthetic
 * fixtures.
 */
import * as fs from "node:fs";
import { localIsoFromMillis } from "./krds";
import { num, roundHalfEven, str } from "./normalize";
import { queryOptional, withDatabase } from "./sqlite";

export interface ReadingSession {
	start: string | null;
	end: string | null;
	minutes: number | null;
	startLoc: unknown;
	endLoc: unknown;
	complete: unknown;
}

export interface FmcacheData {
	/** ASIN -> 'READ' | 'UNREAD' | whatever the device recorded. */
	read_state: Record<string, string | null>;
	/** ASIN -> reading sessions, in insertion order. */
	sessions: Record<string, ReadingSession[]>;
	warnings: string[];
}

export function emptyFmcache(): FmcacheData {
	return { read_state: {}, sessions: {}, warnings: [] };
}

function parseJsonOrNull(s: unknown): Record<string, unknown> | null {
	if (typeof s !== "string" || !s) return null;
	try {
		const v = JSON.parse(s);
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export function loadFmcache(dbPath: string | null | undefined): FmcacheData {
	if (!dbPath || !fs.existsSync(dbPath)) return emptyFmcache();
	// A zero-byte file is not a database; treat it as present-but-empty rather
	// than letting sqlite decide.
	if (fs.statSync(dbPath).size === 0) return emptyFmcache();

	const out = emptyFmcache();

	try {
		withDatabase(dbPath, (db) => {
			// 1. Read-state updates: keep the newest mark per ASIN.
			const latestTs: Record<string, number> = {};
			for (const r of queryOptional(
				db,
				"SELECT record, created_timestamp FROM records " +
					"WHERE schema_name='mar_content_readstate_update_success'"
			)) {
				const d = parseJsonOrNull(r["record"]);
				const ts = num(r["created_timestamp"]);
				if (!d || ts === null) continue;
				const asin = str(d["updated_asin"]);
				if (!asin) continue;
				if (ts >= (latestTs[asin] ?? -1)) {
					latestTs[asin] = ts;
					out.read_state[asin] = str(d["read_state"]);
				}
			}

			// 2. Reading sessions.
			for (const r of queryOptional(db, "SELECT session FROM reading_sessions")) {
				const parsed = parseJsonOrNull(r["session"]);
				const p = parsed && typeof parsed["payload"] === "object" && parsed["payload"] !== null
					? (parsed["payload"] as Record<string, unknown>)
					: null;
				if (!p) continue;
				const asin = str(p["asin"]);
				if (!asin) continue;

				const st = num(p["start_timestamp"]);
				const en = num(p["end_timestamp"]);
				(out.sessions[asin] ??= []).push({
					// A 0 epoch is a missing timestamp, not 1970.
					start: st ? localIsoFromMillis(st) : null,
					end: en ? localIsoFromMillis(en) : null,
					minutes: st && en ? roundHalfEven((en - st) / 60000.0, 1) : null,
					startLoc: p["start_reading_location"] ?? null,
					endLoc: p["end_reading_location"] ?? null,
					complete: p["is_complete"] ?? null,
				});
			}
		});
	} catch (e) {
		// The whole fmcache path is best-effort: it is an optional enrichment,
		// and its absence must never fail a sync. It is surfaced, not swallowed.
		out.warnings.push(`fmcache.db could not be read (${String(e)}); read-state marks skipped.`);
	}

	return out;
}

/** Sessions for one ASIN, ordered by start time. */
export function sessionsFor(fm: FmcacheData, cdeKey: string | null | undefined): ReadingSession[] {
	if (!cdeKey) return [];
	const list = fm.sessions[cdeKey] ?? [];
	// Plain codepoint order, not localeCompare: a locale-aware collation could
	// reorder ISO timestamps under some locales. The sort is stable.
	return [...list].sort((a, b) => {
		const x = a.start ?? "";
		const y = b.start ?? "";
		return x < y ? -1 : x > y ? 1 : 0;
	});
}
