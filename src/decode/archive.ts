/**
 * The source-record archive and the presentation layer built on top of it.
 *
 * Two identities, deliberately distinct:
 *
 *   - A source `uuid` identifies an immutable raw record. `cdeKey` is NOT an
 *     identity for source data -- 54 values cover 109 records in the measured
 *     snapshot -- and raw provenance is never collapsed.
 *   - A *presentation group* is a derived identity, required to turn several
 *     source records into one stable generated note. Its `primaryUuid` is
 *     chosen once, when the group first appears, and never reselected, which
 *     is what makes the note stable when a downloaded/cloud row changes roles.
 *
 * Every collision group measured on this device is one book listed twice: once
 * as a downloaded copy and once as a cloud/archive entry. The canonical case is
 * `Mistborn: 1` (KFX, on device) and `The Final Empire: Mistborn Book One`
 * (MOBI, archived) -- where the on-device row's *file path* is the archived
 * row's *title*.
 */
import { RawBook, RawClipping } from "../types";
import { unionLookups, VocabLookup } from "./vocab-db";

export interface PresentationGroup {
	/** cdeKey and canonical language, joined -- the group's derived identity. */
	key: string;
	cdeKey: string;
	language: string;
	/** Set once, on first appearance. Never reselected. This is kindle_uuid. */
	primaryUuid: string;
	/** Every source record in the group, ascending, for provenance. */
	sourceUuids: string[];
}

export interface GroupingConflict {
	key: string;
	field: "title" | "author" | "language";
	values: string[];
	uuids: string[];
}

export interface GroupingResult {
	/** One merged record per note. */
	books: RawBook[];
	groups: PresentationGroup[];
	/** Surfaced in the sync report, never silenced. */
	conflicts: GroupingConflict[];
}

/**
 * The non-empty, trimmed, lowercase BCP-47 primary subtag.
 *
 * A `cdeKey` alone is not proof that two records are the same book. This
 * snapshot happens to contain no German/English collision, but neither Amazon
 * nor a future snapshot can guarantee that. A missing or malformed language is
 * therefore not mergeable at all.
 *
 * This coalesces `DE`/`de` and `de-de`/`de` -- the four current metadata-only
 * variants -- while a same-cdeKey `de`/`en` pair necessarily yields two notes.
 */
export function canonicalPrimaryLanguage(language: string | null | undefined): string | null {
	if (!language) return null;
	const primary = String(language).trim().split(/[-_]/)[0].toLowerCase();
	// Reject anything that is not a plain alphabetic subtag.
	return /^[a-z]{2,8}$/.test(primary) ? primary : null;
}

/** True when the record is resident on the device's own storage. */
function isHardwareResident(book: RawBook): boolean {
	return typeof book.location === "string" && book.location.startsWith("/mnt/us/documents/");
}

/**
 * Whether a record carries anything worth reading. Used only to break display
 * ties -- never to decide reconciliation identity.
 */
function hasReadingData(book: RawBook): boolean {
	return (
		(book.stats?.minutes ?? 0) > 0 ||
		(book.annotations?.length ?? 0) > 0 ||
		(book.clippings?.length ?? 0) > 0 ||
		(book.vocabulary?.length ?? 0) > 0
	);
}

/**
 * The presentation-group key. NUL separates the parts because it is the one
 * byte a cdeKey or a language subtag can never contain, so no cdeKey/language
 * pair can be mistaken for another.
 */
export function presentationKey(cdeKey: string, language: string): string {
	return `${cdeKey}\u0000${language}`;
}

/** The key for a record that cannot be grouped and stands alone. */
export function soloKey(uuid: string): string {
	return `uuid\u0000${uuid}`;
}

/**
 * The group key, or null when the record is unmergeable and must stand alone.
 * Note the deliberate asymmetry: the *overloaded* `on_device` flag
 * plays no part here.
 */
export function groupKeyFor(book: RawBook): { cdeKey: string; language: string } | null {
	const cde = book.cdeKey ? String(book.cdeKey).trim() : "";
	if (!cde) return null;
	const lang = canonicalPrimaryLanguage(book.language);
	if (!lang) return null;
	return { cdeKey: cde, language: lang };
}

// --- value unions ----------------------------------------------------------
// Union retained and incoming values so device-side pruning does not discard history.

/** Clippings have no id, so the full parsed tuple is the key. */
export function unionClippings(lists: RawClipping[][]): RawClipping[] {
	const out: RawClipping[] = [];
	const seen = new Set<string>();
	for (const list of lists) {
		for (const c of list) {
			const key = JSON.stringify([
				c.title,
				c.author ?? null,
				c.type,
				c.page ?? null,
				c.location ?? null,
				c.added_at ?? null,
				c.text ?? null,
			]);
			if (seen.has(key)) continue;
			seen.add(key);
			out.push(c);
		}
	}
	return out;
}

/**
 * Annotations have no id either. Identify by
 * `(type, startPosition, endPosition, creationTime)` and retain the newest
 * `lastModificationTime`, so an edited note replaces its older self rather
 * than being discarded or duplicated.
 */
export function unionAnnotations(lists: unknown[][]): unknown[] {
	const chosen = new Map<string, Record<string, unknown>>();

	for (const list of lists) {
		for (const raw of list) {
			const a = (raw ?? {}) as Record<string, unknown>;
			const identified =
				a.type !== undefined || a.startPosition !== undefined || a.creationTime !== undefined;
			// Firmware extensions without span identity: only an identical record is a repeat.
			const key = identified
				? JSON.stringify([a.type ?? null, a.startPosition ?? null, a.endPosition ?? null, a.creationTime ?? null])
				: `anon:${JSON.stringify(Object.entries(a).sort(([x], [y]) => x.localeCompare(y)))}`;

			const prev = chosen.get(key);
			if (!prev) {
				chosen.set(key, a);
				continue;
			}
			const prevMod = String(prev.lastModificationTime ?? "");
			const thisMod = String(a.lastModificationTime ?? "");
			if (thisMod > prevMod) chosen.set(key, a);
		}
	}

	return [...chosen.values()];
}

// --- grouping --------------------------------------------------------------

/** The record with the lowest uuid, by code point. */
function lowestUuid(books: RawBook[]): RawBook {
	return books.reduce((low, b) => (b.uuid < low.uuid ? b : low));
}

function pickDisplayPrimary(members: RawBook[], primaryUuid: string): RawBook {
	const resident = members.filter(isHardwareResident);
	if (resident.length === 1) return resident[0];
	if (resident.length > 1) {
		const withData = resident.filter(hasReadingData);
		return lowestUuid(withData.length ? withData : resident);
	}

	// Archive-only group: prefer retained reading data, then the stable primary.
	const withData = members.filter(hasReadingData);
	if (withData.length === 1) return withData[0];
	if (withData.length > 1) {
		return withData.find((m) => m.uuid === primaryUuid) ?? lowestUuid(withData);
	}
	return members.find((m) => m.uuid === primaryUuid) ?? members[0];
}

function collectConflicts(key: string, members: RawBook[]): GroupingConflict[] {
	const out: GroupingConflict[] = [];
	const check = (field: "title" | "author" | "language", get: (b: RawBook) => string) => {
		const values = [...new Set(members.map(get).filter((v) => v !== ""))];
		if (values.length > 1) {
			out.push({ key, field, values, uuids: members.map((m) => m.uuid) });
		}
	};
	check("title", (b) => (b.title ?? "").trim());
	check("author", (b) => (b.author ?? "").trim());
	check("language", (b) => String(b.language ?? "").trim());
	return out;
}

/**
 * Collapse source records into one merged record per presentation group.
 *
 * `existingGroups` carries the stable `primaryUuid` forward. It is archive
 * state, not a migration and not an index read back from existing notes.
 */
export function groupForPresentation(
	books: RawBook[],
	existingGroups: PresentationGroup[] = []
): GroupingResult {
	const stablePrimary = new Map(existingGroups.map((g) => [g.key, g.primaryUuid]));

	// Preserve first-appearance order so note output is deterministic.
	const buckets = new Map<string, RawBook[]>();

	for (const book of books) {
		const gk = groupKeyFor(book);
		// Unmergeable records stand alone under their own uuid.
		const key = gk ? presentationKey(gk.cdeKey, gk.language) : soloKey(book.uuid);
		const bucket = buckets.get(key);
		if (bucket) bucket.push(book);
		else buckets.set(key, [book]);
	}

	const groups: PresentationGroup[] = [];
	const merged: RawBook[] = [];
	const conflicts: GroupingConflict[] = [];

	for (const [key, members] of buckets) {
		const gk = groupKeyFor(members[0]);

		const sourceUuids = members.map((m) => m.uuid).sort();

		// Set once and never reselected -- this is the existing note's
		// kindle_uuid -- *except* when the record it names is gone. A group can
		// shrink (a cloud entry disappears from cc.db and no archive record
		// survives it), and a primaryUuid naming an absent record could never
		// self-heal: the next run would read the same stale value straight back
		// out of archive.json. So re-key, and persist the new choice.
		const known = stablePrimary.get(key);
		const primaryUuid = known && sourceUuids.includes(known) ? known : sourceUuids[0];

		if (gk) {
			groups.push({
				key,
				cdeKey: gk.cdeKey,
				language: gk.language,
				primaryUuid,
				sourceUuids,
			});
		}

		// One record: nothing to merge, and its own uuid is the primary.
		if (members.length === 1) {
			merged.push(members[0]);
			continue;
		}

		conflicts.push(...collectConflicts(key, members));

		const display = pickDisplayPrimary(members, primaryUuid);

		merged.push({
			...display,
			// Reconciliation identity, not display selection.
			uuid: primaryUuid,
			vocabulary: members.reduce<VocabLookup[]>((all, m) => unionLookups(all, m.vocabulary as VocabLookup[] | undefined), []) as RawBook["vocabulary"],
			clippings: unionClippings(members.map((m) => m.clippings ?? [])),
			annotations: unionAnnotations(members.map((m) => m.annotations ?? [])) as RawBook["annotations"],
			// The two keys mean different things and stay independent.
			on_device: members.some((m) => m.on_device === true || m.on_device === 1),
			isArchived: members.some((m) => m.isArchived === 1 || m.isArchived === true) ? 1 : display.isArchived ?? null,
			has_sidecar: members.some((m) => m.has_sidecar === true || m.has_sidecar === 1),
		});
	}

	return { books: merged, groups, conflicts };
}
