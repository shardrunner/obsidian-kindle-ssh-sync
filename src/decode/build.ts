/**
 * The join: raw cache -> LibraryJson.
 *
 * This produces the *ungrouped source records*, one per `uuid`. Presentation
 * grouping (turning several source records into one stable generated note) is
 * a separate, later step in `archive.ts` -- a source `uuid` is the identity of
 * a raw record, and `cdeKey` is never one.
 *
 * Deliberately not decoded: X-Ray, popular highlights, end actions and
 * aggregate telemetry. Reconciliation starts from the archived record, so
 * fields the decoder does not produce carry forward.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { LibraryJson, RawBook, RawClipping } from "../types";
import { decodeKrds, KrdsValue } from "./krds";
import { computeTimerStats } from "./timer-stats";
import { loadCcDatabase, rowAuthor } from "./cc-db";
import { loadVocabulary, unionLookups, VocabLookup, VocabularyData } from "./vocab-db";
import { FmcacheData, loadFmcache, sessionsFor } from "./fmcache-db";
import { decodeUtf8Sig, parseClippings, ParsedClippings } from "./clippings";
import { num, str, titleKey } from "./normalize";
import { PresentationGroup, unionAnnotations, unionClippings } from "./archive";
import { validateLibraryData } from "../library";
import { assertCacheReady } from "../device/cache";
import { SqliteRow } from "./sqlite";

export const METRICS_EXTS = [".azw3f", ".yjf", ".mbs"];
export const READER_EXTS = [".azw3r", ".yjr", ".mbp1"];
export const EXTRA_SIDECAR_EXTS = [".xray", ".asc", ".phl", ".ea", ".eal", ".pdr", ".apnx"];
export const SIDECAR_EXTS = [...METRICS_EXTS, ...READER_EXTS, ...EXTRA_SIDECAR_EXTS];

/** Shown when cc.db carries no nominal title for a row. */
export const UNTITLED = "(untitled)";

export interface CachePaths {
	root: string;
	ccDb: string;
	vocabDb: string;
	fmcacheDb: string;
	documents: string;
	clippings: string;
	thumbnails: string;
	archive: string;
}

export function cachePaths(root: string): CachePaths {
	return {
		root,
		ccDb: path.join(root, "cc.db"),
		vocabDb: path.join(root, "vocab.db"),
		fmcacheDb: path.join(root, "fmcache.db"),
		documents: path.join(root, "documents"),
		clippings: path.join(root, "documents", "My Clippings.txt"),
		thumbnails: path.join(root, "thumbnails"),
		archive: path.join(root, "archive.json"),
	};
}

export interface BuildResult {
	/** Always carries the vocabulary word layer for the archive. */
	library: Required<LibraryJson>;
	/**
	 * The presentation-group state read from archive.json. Returned here so the
	 * caller does not have to parse a multi-megabyte archive a second time.
	 */
	archiveGroups: PresentationGroup[];
	warnings: string[];
}

function isMapping(v: unknown): v is Record<string, KrdsValue> {
	return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Flatten `annotation.cache.object` into `{type, ...fields}` records. */
export function annotationsFromReader(azw3r: Record<string, KrdsValue>): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	const aco = azw3r["annotation.cache.object"];
	if (isMapping(aco)) {
		for (const [cls, items] of Object.entries(aco)) {
			if (!Array.isArray(items)) continue;
			for (const it of items) {
				if (isMapping(it)) {
					out.push({ type: cls.split(".").pop() as string, ...it });
				}
			}
		}
	}
	return out;
}

/** The `.sdr` directory holding a book's sidecars, or undefined. */
export function sdrDirFor(cache: CachePaths, location: string | null): string | undefined {
	if (!location || !location.startsWith("/mnt/us/documents/")) return undefined;
	const rel = location.slice("/mnt/us/".length);
	if (rel.includes("\\") || rel.includes("\u0000") || rel.split("/").some(p => p === ".." || p === ".")) return undefined;
	const base = rel.replace(/\.[^./]*$/, "");
	const dir = path.join(cache.root, ...(base + ".sdr").split("/"));
	try {
		return fs.statSync(dir).isDirectory() ? dir : undefined;
	} catch {
		return undefined;
	}
}

function decodeSidecar(file: string, warnings: string[]): Record<string, KrdsValue> {
	try {
		const r = decodeKrds(new Uint8Array(fs.readFileSync(file)));
		for (const w of r.warnings) warnings.push(`${path.basename(file)}: ${w}`);
		return r.value;
	} catch (e) {
		// A container that cannot be decoded at all is reported, not fatal: one
		// corrupt sidecar must not cost the user their whole library.
		warnings.push(`Could not decode ${path.basename(file)}: ${String(e)}`);
		return {};
	}
}

/** Map each cached cover thumbnail by filename and by its ASIN/GUID part. */
export function buildThumbnailIndex(thumbnailsDir: string): Record<string, string> {
	const map: Record<string, string> = {};
	let names: string[];
	try {
		names = fs.readdirSync(thumbnailsDir);
	} catch {
		return map;
	}
	for (const f of names) {
		if (!/\.(jpe?g|png)$/i.test(f)) continue;
		map[f] = `thumbnails/${f}`;
		const parts = f.split("_");
		if (parts.length >= 2) map[parts[1]] = `thumbnails/${f}`;
	}
	return map;
}

export interface LoadedArchive {
	books: RawBook[];
	groups: PresentationGroup[];
	vocabulary?: LibraryJson["vocabulary"];
}

/**
 * Load the previously saved source archive and its group state in one read.
 *
 * A missing `groups` list means "choose the group primaries afresh".
 */
export function loadArchive(archivePath: string): LoadedArchive {
	let raw: string;
	try {
		raw = fs.readFileSync(archivePath, "utf-8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") {
			// A dangling archive symlink is damage, not a first run.
			try { fs.lstatSync(archivePath); } catch (statError) {
				if ((statError as NodeJS.ErrnoException).code === "ENOENT") return { books: [], groups: [] };
				throw statError;
			}
		}
		throw new Error(`Failed to read archive ${archivePath}: ${String(e)}`);
	}
	try {
		const data = JSON.parse(raw);
		validateLibraryData(data);
		return { books: data.books, groups: (data as LibraryJson & { groups?: PresentationGroup[] }).groups ?? [], vocabulary: data.vocabulary };
	} catch (e) {
		throw new Error(`Invalid archive ${archivePath}: ${String(e)}`);
	}
}

interface ArchiveIndex {
	byUuid: Map<string, RawBook>;
	byGuid: Map<string, RawBook[]>;
	byCde: Map<string, RawBook[]>;
	byNorm: Map<string, RawBook[]>;
}

function indexArchive(books: RawBook[]): ArchiveIndex {
	const byUuid = new Map<string, RawBook>();
	const byGuid = new Map<string, RawBook[]>();
	const byCde = new Map<string, RawBook[]>();
	const byNorm = new Map<string, RawBook[]>();

	const push = (m: Map<string, RawBook[]>, k: string, b: RawBook) => {
		const list = m.get(k);
		if (list) list.push(b);
		else m.set(k, [b]);
	};

	for (const b of books) {
		if (b.cdeKey) push(byCde, String(b.cdeKey), b);
		if (b.guid) push(byGuid, String(b.guid), b);
		if (b.uuid && !String(b.uuid).startsWith("synthetic-")) byUuid.set(String(b.uuid), b);
		if (b.catalogueUuid) byUuid.set(b.catalogueUuid, b);
		const nt = titleKey(b.title);
		if (nt) push(byNorm, nt, b);
	}

	return { byUuid, byGuid, byCde, byNorm };
}

/**
 * Resolve a cc.db row to its archived record.
 *
 * The tier order is uuid -> guid -> cdeKey -> normalised title, and every
 * non-uuid tier applies *only when it maps to exactly one* archived record;
 * the title tier additionally requires the author to match. A shared
 * cdeKey alone must never merge distinct source records.
 */
function matchArchived(
	idx: ArchiveIndex,
	uuid: string | null,
	guid: string | null,
	cde: string | null,
	normTitle: string,
	rowAuthorName: string
): RawBook | undefined {
	if (uuid) {
		const hit = idx.byUuid.get(uuid);
		if (hit) return hit;
	}
	if (guid) {
		const list = idx.byGuid.get(guid);
		if (list && list.length === 1) return list[0];
	}
	if (cde) {
		const list = idx.byCde.get(cde);
		if (list && list.length === 1) return list[0];
	}
	if (normTitle) {
		const list = idx.byNorm.get(normTitle);
		if (list && list.length === 1) {
			const candAuthor = titleKey(list[0].author);
			const rowAuth = titleKey(rowAuthorName);
			if (candAuthor && rowAuth && candAuthor === rowAuth) return list[0];
		}
	}
	return undefined;
}

/** A value worth keeping: not empty, not zero, not false. */
function truthy(v: unknown): boolean {
	if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
	if (Array.isArray(v)) return v.length > 0;
	if (typeof v === "object") return Object.keys(v as object).length > 0;
	return true;
}

export function buildLibrary(cacheRoot: string): BuildResult {
	assertCacheReady(cacheRoot);
	const cache = cachePaths(cacheRoot);
	const warnings: string[] = [];

	const fm = loadFmcache(cache.fmcacheDb);
	warnings.push(...fm.warnings);
	const vocab = loadVocabulary(cache.vocabDb);
	const clippings = readClippings(cache.clippings);
	const thumbnails = buildThumbnailIndex(cache.thumbnails);

	const loaded = loadArchive(cache.archive);
	mergeWordLayer(vocab, loaded.vocabulary);
	const existingBooks = loaded.books;
	const idx = indexArchive(existingBooks);

	const cc = loadCcDatabase(cache.ccDb);

	const activeBooks: RawBook[] = [];
	const matchedAsins = new Set<string>();
	const matchedGuids = new Set<string>();
	const matchedUuids = new Set<string>();
	const matchedNormTitles = new Set<string>();
	const matchedClippingTitles = new Set<string>();
	const matchedArchived = new Set<RawBook>();

	for (const row of cc.rows) {
		activeBooks.push(
			buildActiveBook({
				row,
				cache,
				cc,
				fm,
				vocab,
				clippings,
				thumbnails,
				idx,
				matchedArchived,
				matchedClippingTitles,
				warnings,
			})
		);

		const cde = str(row["p_cdeKey"]);
		const guid = str(row["p_guid"]);
		const uuid = str(row["p_uuid"]);
		const nt = titleKey(str(row["p_titles_0_nominal"]) || UNTITLED);
		if (cde) matchedAsins.add(cde);
		if (guid) matchedGuids.add(guid);
		if (uuid) matchedUuids.add(uuid);
		if (nt) matchedNormTitles.add(nt);
	}

	// --- archived records the device no longer has ---------------------------
	// Unexercised by the current fixture (every archive record matches a live
	// cc.db row), but it is the whole point of the archive on a real deletion.
	// Symbol-only titles normalise to nothing, so they are keyed by the raw title.
	const symbolTitles = new Map<string, RawClipping[]>();
	for (const c of clippings.clippings) {
		if (titleKey(c.title)) continue;
		const list = symbolTitles.get(c.title);
		if (list) list.push(c);
		else symbolTitles.set(c.title, [c]);
	}

	const archivedToKeep: RawBook[] = [];
	for (const b of existingBooks) {
		if (matchedArchived.has(b)) continue;

		const cde = b.cdeKey ? String(b.cdeKey) : null;
		const guid = b.guid ? String(b.guid) : null;
		const uuidVal = b.uuid ? String(b.uuid) : null;
		const nt = titleKey(b.title);

		if (uuidVal && matchedUuids.has(uuidVal)) continue;

		const copy: RawBook = { ...b };
		copy.on_device = false;
		// A book that vanished mid-read is abandoned, not still in progress.
		if (copy.read_status === "reading") copy.read_status = "abandoned";

		const newClips = (nt ? clippings.by_title[nt] : symbolTitles.get(b.title)) ?? [];
		if (newClips.length) {
			copy.clippings = unionClippings([newClips, copy.clippings ?? []]);
			if (nt) matchedClippingTitles.add(nt);
			else symbolTitles.delete(b.title);
		}
		const newVocab = resolveVocabulary(vocab, cde, guid, nt);
		copy.vocabulary = unionLookups(copy.vocabulary as VocabLookup[] | undefined, newVocab) as RawBook["vocabulary"];

		if (cde) matchedAsins.add(cde);
		if (guid) matchedGuids.add(guid);
		if (uuidVal) matchedUuids.add(uuidVal);
		if (nt) matchedNormTitles.add(nt);

		archivedToKeep.push(copy);
	}

	// --- books known only to vocab.db ---------------------------------------
	const synthetic: RawBook[] = [];
	for (const info of Object.values(vocab.books)) {
		const asin = info.asin;
		const guid = info.guid;
		const vTitle = info.title ?? "";
		const vAuthor = info.authors ?? "";
		const vNorm = titleKey(vTitle);

		if (
			(asin && matchedAsins.has(asin)) ||
			(guid && matchedGuids.has(guid)) ||
			(vNorm && matchedNormTitles.has(vNorm))
		) {
			continue;
		}

		const bookVocab = resolveVocabulary(vocab, asin, guid, vNorm);
		const bookClippings = clippings.by_title[vNorm] ?? [];
		if (bookClippings.length) matchedClippingTitles.add(vNorm);

		if (asin) matchedAsins.add(asin);
		if (guid) matchedGuids.add(guid);
		if (vNorm) matchedNormTitles.add(vNorm);

		if (!bookVocab.length && !bookClippings.length) continue;

		const readState = asin ? fm.read_state[asin] ?? null : null;
		synthetic.push(syntheticBook({
			uuid: "synthetic-" + (asin || vNorm),
			title: vTitle,
			author: vAuthor,
			cdeKey: asin,
			cdeType: asin ? "EBOK" : null,
			guid,
			language: info.lang,
			thumbnail: (asin ? thumbnails[asin] : undefined) ?? (guid ? thumbnails[guid] : undefined) ?? null,
			read_status: readState === "READ" ? "read" : "unread",
			fm_read_state: readState,
			device_sessions: asin ? sessionsFor(fm, asin) : [],
			vocabulary: bookVocab,
			clippings: bookClippings,
		}));
	}

	// --- clipping titles that match nothing at all ---------------------------
	for (const [normTitle, clipList] of Object.entries(clippings.by_title)) {
		if (matchedNormTitles.has(normTitle) || matchedClippingTitles.has(normTitle)) continue;
		matchedNormTitles.add(normTitle);
		matchedClippingTitles.add(normTitle);

		const first = clipList[0] ?? ({} as RawClipping);
		synthetic.push(syntheticBook({
			uuid: "synthetic-" + normTitle,
			title: first.title || normTitle,
			author: first.author || "",
			vocabulary: vocab.by_title[normTitle] ?? [],
			clippings: clipList,
		}));
	}

	// Hashed because uuids end up in vault paths. The raw title is kept so the
	// archived record absorbs the same clippings on the next build.
	for (const [title, clipList] of symbolTitles) {
		synthetic.push(syntheticBook({
			uuid: "synthetic-" + createHash("sha256").update(title).digest("hex").slice(0, 16),
			title,
			author: clipList[0].author || "",
			vocabulary: [],
			clippings: clipList,
		}));
	}

	const allBooks = [...activeBooks, ...archivedToKeep, ...synthetic];
	// Most-read first. The sort is stable, so equal-minute books keep their
	// construction order.
	allBooks.sort((a, b) => (b.stats?.minutes ?? 0) - (a.stats?.minutes ?? 0));

	validateLibraryData({ books: allBooks, vocabulary: { stats: vocab.stats, words: vocab.words } });
	return {
		archiveGroups: loaded.groups,
		library: {
			vocabulary: { stats: vocab.stats, words: vocab.words },
			books: allBooks,
		},
		warnings,
	};
}

/**
 * A book known only from vocab.db or My Clippings.txt. Key order matches the
 * cc.db records so archive output stays stable.
 */
function syntheticBook(f: {
	uuid: string;
	title: string;
	author: string;
	cdeKey?: string | null;
	cdeType?: string | null;
	guid?: string | null;
	language?: string | null;
	thumbnail?: string | null;
	read_status?: string;
	fm_read_state?: string | null;
	device_sessions?: unknown[];
	vocabulary: unknown[];
	clippings: RawClipping[];
}): RawBook {
	const fmReadState = f.fm_read_state ?? null;
	const sessions = f.device_sessions ?? [];
	return {
		uuid: f.uuid,
		title: f.title,
		author: f.author,
		cdeKey: f.cdeKey ?? null,
		cdeType: f.cdeType ?? null,
		guid: f.guid ?? null,
		publisher: null,
		language: f.language ?? null,
		publicationDate: null,
		addedDate: null,
		originType: null,
		isDRMProtected: false,
		isIndexed: false,
		diskUsage: null,
		contentSize: null,
		watermark: null,
		mimeType: null,
		thumbnail: f.thumbnail ?? null,
		percentFinished: null,
		readState: null,
		read_status: f.read_status ?? "unread",
		fm_read_state: fmReadState,
		dictionary_override: null,
		device_sessions: sessions,
		lastAccess: null,
		location: null,
		isArchived: null,
		series: null,
		stats: {},
		annotations: [],
		vocabulary: f.vocabulary as RawBook["vocabulary"],
		clippings: f.clippings,
		has_sidecar: false,
		azw3f: {},
		azw3r: {},
		on_device: false,
	};
}

function mergeWordLayer(vocab: VocabularyData, archived: LibraryJson["vocabulary"]): void {
	if (!archived) return;
	const words = new Map<string, VocabularyData["words"][number]>();
	for (const word of [...(archived.words ?? []), ...vocab.words]) {
		const key = word.id || word.word_key ? `id:${word.id || word.word_key}` : `word:${word.word}`;
		const previous = words.get(key);
		const lookups = unionLookups(previous?.lookups, word.lookups);
		words.set(key, { ...previous, ...word, lookups, lookup_count: lookups.length });
	}
	vocab.words = [...words.values()];
	vocab.stats = {
		total_words: vocab.words.length,
		total_lookups: Math.max(vocab.stats.total_lookups, unionLookups([], vocab.words.flatMap(w => w.lookups)).length),
		mastered_words: vocab.words.filter(w => w.status === "mastered").length,
		learning_words: vocab.words.filter(w => w.status !== "mastered").length,
	};
}

function readClippings(file: string): ParsedClippings {
	if (!fs.existsSync(file)) {
		return {
			clippings: [],
			by_title: {},
		};
	}
	return parseClippings(decodeUtf8Sig(new Uint8Array(fs.readFileSync(file))));
}

/**
 * Resolve by cdeKey, then guid, then normalised title, each falling through
 * only on an *empty* result.
 */
function resolveVocabulary(
	vocab: VocabularyData,
	cde: string | null,
	guid: string | null,
	normTitle: string
): VocabLookup[] {
	const byCde = cde ? vocab.by_book[cde] : undefined;
	if (byCde?.length) return byCde;
	const byGuid = guid ? vocab.by_book[guid] : undefined;
	if (byGuid?.length) return byGuid;
	return vocab.by_title[normTitle] ?? [];
}

interface ActiveBookContext {
	row: SqliteRow;
	cache: CachePaths;
	cc: ReturnType<typeof loadCcDatabase>;
	fm: FmcacheData;
	vocab: VocabularyData;
	clippings: ParsedClippings;
	thumbnails: Record<string, string>;
	idx: ArchiveIndex;
	matchedArchived: Set<RawBook>;
	matchedClippingTitles: Set<string>;
	warnings: string[];
}

function buildActiveBook(ctx: ActiveBookContext): RawBook {
	const { row, cache, cc, fm, vocab, clippings, thumbnails, idx, warnings } = ctx;

	const loc = str(row["p_location"]) ?? "";
	let azw3f: Record<string, KrdsValue> = {};
	let azw3r: Record<string, KrdsValue> = {};

	const sdr = sdrDirFor(cache, loc);
	if (sdr) {
		for (const f of fs.readdirSync(sdr)) {
			const p = path.join(sdr, f);
			if (METRICS_EXTS.some((x) => f.endsWith(x))) azw3f = decodeSidecar(p, warnings);
			else if (READER_EXTS.some((x) => f.endsWith(x))) azw3r = decodeSidecar(p, warnings);
			// .xray/.asc/.phl/.ea/.eal are retained in the cache but never decoded.
		}
	}

	const tm = azw3f["timer.model"];
	const bi = azw3f["book.info.store"];
	let stats = computeTimerStats(tm ?? null, bi ?? null);
	let annots: unknown[] = annotationsFromReader(azw3r);

	const cde = str(row["p_cdeKey"]);
	const guid = str(row["p_guid"]);
	const ser = cde ? cc.seriesOf[cde] : undefined;

	// The modern fmcache mark overrides cc.db's legacy p_readState.
	const fmRs = cde ? fm.read_state[cde] ?? null : null;
	const devSessions = sessionsFor(fm, cde);
	const rstate = num(row["p_readState"]);
	const pctFinished = num(row["p_percentFinished"]);

	let readStatus: string;
	if (fmRs === "READ" || rstate === 2 || (pctFinished !== null && pctFinished >= 93.0)) {
		readStatus = "read";
	} else if (fmRs === "UNREAD") {
		readStatus = "unread";
	} else if (rstate === 1 || (pctFinished !== null && pctFinished > 0.0)) {
		readStatus = "reading";
	} else {
		readStatus = "unread";
	}

	const title = str(row["p_titles_0_nominal"]) || UNTITLED;
	const normTitle = titleKey(title);
	const author = rowAuthor(row);
	let hasSidecar = truthy(tm) || truthy(azw3r);

	const rowUuid = str(row["p_uuid"]) as string;
	const archived = matchArchived(idx, rowUuid, guid, cde, normTitle, author);
	if (archived) ctx.matchedArchived.add(archived);

	let bookVocab: VocabLookup[] | unknown[] = resolveVocabulary(vocab, cde, guid, normTitle);
	let bookClippings: RawClipping[] = clippings.by_title[normTitle] ?? [];
	if (!bookClippings.length && archived) {
		const archNt = titleKey(archived.title);
		if (archNt && clippings.by_title[archNt]) bookClippings = clippings.by_title[archNt];
	}

	if (archived) {
		if (!hasSidecar && truthy(archived.has_sidecar)) {
			stats = (archived.stats ?? {}) as typeof stats;
			hasSidecar = true;
			if (truthy(archived.azw3f)) azw3f = archived.azw3f as Record<string, KrdsValue>;
			if (truthy(archived.azw3r)) azw3r = archived.azw3r as Record<string, KrdsValue>;
		}
		annots = unionAnnotations([archived.annotations ?? [], annots]);
		bookClippings = unionClippings([bookClippings, archived.clippings ?? []]);
		bookVocab = unionLookups(archived.vocabulary as VocabLookup[] | undefined, bookVocab as VocabLookup[]);
		if (archived.read_status === "read" && readStatus !== "reading") readStatus = "read";
	}

	if (bookClippings.length) {
		if (clippings.by_title[normTitle]) ctx.matchedClippingTitles.add(normTitle);
		if (archived) {
			const archNt = titleKey(archived.title);
			if (archNt && clippings.by_title[archNt]) ctx.matchedClippingTitles.add(archNt);
		}
	}

	const thumb =
		(cde ? thumbnails[cde] : undefined) ?? (guid ? thumbnails[guid] : undefined) ?? null;

	// A matched record keeps its uuid, which is the note's kindle_uuid; a
	// catalogue that reassigned p_uuid is remembered as catalogueUuid so the
	// next build matches it directly.
	const uuid = archived?.uuid ?? rowUuid;
	const { catalogueUuid: _previous, ...carried } = archived ?? {};

	// Fields this decoder does not produce carry forward; current device facts
	// win, including absent ones.
	return {
		...carried,
		uuid,
		...(rowUuid !== uuid ? { catalogueUuid: rowUuid } : {}),
		title,
		author,
		cdeKey: cde,
		cdeType: str(row["p_cdeType"]),
		guid,
		publisher: str(row["p_publisher"]),
		language: str(row["p_languages_0"]),
		publicationDate: (row["p_publicationDate"] ?? null) as string | number | null,
		addedDate: num(row["p_modificationTime"]),
		originType: num(row["p_originType"]),
		isDRMProtected: truthy(row["p_isDRMProtected"]),
		isIndexed: row["p_contentIndexedState"] === 1,
		diskUsage: num(row["p_diskUsage"]),
		contentSize: num(row["p_contentSize"]),
		watermark: str(row["p_watermark"]),
		mimeType: str(row["p_mimeType"]),
		thumbnail: thumb,
		percentFinished: pctFinished,
		readState: rstate,
		read_status: readStatus,
		fm_read_state: fmRs,
		dictionary_override: (azw3r["dictionary"] ?? null) as string | null,
		device_sessions: devSessions,
		lastAccess: num(row["p_lastAccess"]),
		location: loc,
		isArchived: (row["p_isArchived"] ?? null) as number | boolean | null,
		series: ser
			? {
					label: ser.label,
					name: ser.seriesId ? cc.seriesName[ser.seriesId] ?? null : null,
					seriesId: ser.seriesId,
			  }
			: null,
		stats,
		annotations: annots as RawBook["annotations"],
		vocabulary: bookVocab as RawBook["vocabulary"],
		clippings: bookClippings,
		has_sidecar: hasSidecar,
		azw3f: azw3f as RawBook["azw3f"],
		azw3r: azw3r as RawBook["azw3r"],
		on_device: true,
	};
}
