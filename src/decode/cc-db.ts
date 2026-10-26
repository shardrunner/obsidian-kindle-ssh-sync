/** Kindle content catalogue (`cc.db`) reader. */
import * as fs from "node:fs";
import { str } from "./normalize";
import { queryOptional, SqliteRow, withDatabase } from "./sqlite";

export interface SeriesMembership {
	seriesId: string | null;
	label: string | null;
	pos: number | null;
}

export interface CcDatabase {
	/** Every `Entry:Item` row, verbatim. */
	rows: SqliteRow[];
	/** cdeKey -> series membership, from the Series table. */
	seriesOf: Record<string, SeriesMembership>;
	/** seriesId (asin or cdeGroup) -> container title. */
	seriesName: Record<string, string | null>;
}

export function loadCcDatabase(dbPath: string): CcDatabase {
	if (!fs.existsSync(dbPath)) {
		throw new Error(
			`No cached cc.db at ${dbPath}. Run "Sync from device" first, ` +
				`or point the cache folder setting at an existing cache.`
		);
	}

	return withDatabase(dbPath, (db) => {
		const seriesOf: Record<string, SeriesMembership> = {};
		for (const r of queryOptional(
			db,
			"SELECT d_itemCdeKey, d_seriesId, d_itemPositionLabel, d_itemPosition FROM Series"
		)) {
			const key = str(r["d_itemCdeKey"]);
			if (key === null) continue;
			seriesOf[key] = {
				seriesId: str(r["d_seriesId"]),
				label: str(r["d_itemPositionLabel"]),
				pos: typeof r["d_itemPosition"] === "number" ? r["d_itemPosition"] : null,
			};
		}

		const seriesName: Record<string, string | null> = {};
		for (const r of queryOptional(
			db,
			"SELECT p_cdeKey, p_cdeGroup, p_titles_0_nominal FROM Entries " +
				"WHERE p_type='Entry:Item:Series'"
		)) {
			for (const k of [str(r["p_cdeKey"]), str(r["p_cdeGroup"])]) {
				if (k) seriesName[k] = str(r["p_titles_0_nominal"]);
			}
		}

		const rows = queryOptional(db, "SELECT * FROM Entries WHERE p_type='Entry:Item'");

		return { rows, seriesOf, seriesName };
	});
}

/** `JSON.parse`, returning the fallback on any failure. */
export function jsonLoadOr<T>(s: unknown, fallback: T): T {
	if (!s || typeof s !== "string") return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
}

/**
 * Resolve a row's author, preferring the structured `j_credits` blob and
 * falling back to the flattened column.
 */
export function rowAuthor(row: SqliteRow): string {
	const credits = jsonLoadOr<unknown>(row["j_credits"], []);
	if (Array.isArray(credits) && credits.length > 0) {
		const first = credits[0] as Record<string, unknown> | undefined;
		const nm = first && typeof first === "object" ? first["name"] : undefined;
		if (nm && typeof nm === "object" && !Array.isArray(nm)) {
			const n = nm as Record<string, unknown>;
			return (str(n["display"]) || str(n["collation"]) || "") as string;
		}
		if (typeof nm === "string") return nm;
	}
	return str(row["p_credits_0_name_collation"]) ?? "";
}
