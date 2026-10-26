import { LibraryJson } from "./types";

type Mapping = Record<string, unknown>;
function object(value: unknown, at: string): Mapping {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${at}: expected object`);
	return value as Mapping;
}
function array(value: unknown, at: string): unknown[] {
	if (!Array.isArray(value)) throw new Error(`Invalid ${at}: expected array`);
	return value;
}
function fields(value: Mapping, names: string, types: string, at: string) {
	for (const key of names.split(" ")) {
		const v = value[key];
		if (v == null) continue;
		if (!types.split("|").includes(typeof v) || (typeof v === "number" && !Number.isFinite(v))) throw new Error(`Invalid ${at}.${key}: expected ${types}`);
	}
}
function records(value: unknown, at: string, validate: (v: Mapping, at: string) => void) {
	array(value, at).forEach((v, i) => validate(object(v, `${at}[${i}]`), `${at}[${i}]`));
}
function clipping(v: Mapping, at: string) {
	if (typeof v.title !== "string" || typeof v.type !== "string") throw new Error(`Invalid ${at}: clipping title/type required`);
	fields(v, "author location added_at text", "string", at);
	fields(v, "page", "string|number", at);
}
function lookup(v: Mapping, at: string) {
	fields(v, "id word_key book_key book_asin book_title dict_key pos usage word stem status", "string", at);
	fields(v, "timestamp category lookup_count", "number", at);
}
function numbers(v: unknown, names: string, at: string) {
	fields(object(v, at), names, "number", at);
}
/** Validate only consumed structure; unknown raw provenance is retained verbatim. */
export function validateLibraryData(data: unknown): asserts data is LibraryJson {
	const root = object(data, "library");
	const uuids = new Set<string>();
	records(root.books, "books", (book, at) => {
		if (typeof book.uuid !== "string" || !book.uuid.trim()) throw new Error(`Invalid ${at}.uuid: required string`);
		if (uuids.has(book.uuid)) throw new Error(`Duplicate kindle_uuid ${book.uuid} at ${at}`);
		uuids.add(book.uuid);
		if (typeof book.title !== "string") throw new Error(`Invalid ${at}.title: required string`);
		fields(book, "catalogueUuid author cdeKey cdeType guid publisher language watermark mimeType thumbnail read_status fm_read_state dictionary_override location", "string", at);
		fields(book, "addedDate originType diskUsage contentSize percentFinished readState lastAccess", "number", at);
		fields(book, "publicationDate", "string|number", at);
		fields(book, "isDRMProtected isIndexed isArchived on_device has_sidecar", "number|boolean", at);
		if (book.series != null) fields(object(book.series, `${at}.series`), "label name seriesId", "string", `${at}.series`);
		if (book.stats != null) {
			const stats = object(book.stats, `${at}.stats`);
			fields(stats, "hours wpm_overall wpm_reading wpm_std_dev percent_read words_read book_words minutes speed_samples wpm_variance outliers_count samples_recorded", "number", `${at}.stats`);
			if (stats.outliers != null) array(stats.outliers, `${at}.stats.outliers`).forEach(v => { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Invalid ${at}.stats.outliers`); });
			if (stats.clusters != null) records(stats.clusters, `${at}.stats.clusters`, (v, p) => { fields(v, "cluster count wpm std_dev", "number", p); fields(v, "label", "string", p); });
		}
		if (book.clippings != null) records(book.clippings, `${at}.clippings`, clipping);
		if (book.vocabulary != null) records(book.vocabulary, `${at}.vocabulary`, lookup);
		if (book.annotations != null) records(book.annotations, `${at}.annotations`, (v, p) => {
			fields(v, "type text note", "string", p);
			fields(v, "startPosition endPosition", "string|number", p);
		});
		if (book.device_sessions != null) array(book.device_sessions, `${at}.device_sessions`);
		for (const key of ["azw3f", "azw3r"]) if (book[key] != null) {
			const raw = object(book[key], `${at}.${key}`);
			// sync_lpr is a boolean on some firmware; only object positions are consumed.
			for (const pos of ["lpr", "fpr", "sync_lpr"]) if (raw[pos] != null && typeof raw[pos] === "object" && !Array.isArray(raw[pos])) {
				const v = object(raw[pos], `${at}.${key}.${pos}`);
				fields(v, "position", "string|number", at); fields(v, "time", "string", at);
			}
			if (raw["book.info.store"] != null && !Array.isArray(raw["book.info.store"])) fields(object(raw["book.info.store"], at), "numberOfWords percentOfBook", "number", at);
			if (raw["apnx.key"] != null && !Array.isArray(raw["apnx.key"])) {
				const apnx = object(raw["apnx.key"], at);
				// Other APNX fields are opaque provenance, not renderer inputs.
				if (apnx.oPNToPosition != null) array(apnx.oPNToPosition, `${at}.oPNToPosition`).forEach(v => { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`Invalid ${at}.oPNToPosition`); });
			}
		}
	});
	if (root.groups !== undefined) records(root.groups, "groups", (g, at) => {
		for (const key of ["key", "cdeKey", "language", "primaryUuid"]) if (typeof g[key] !== "string" || !g[key]) throw new Error(`Invalid ${at}.${key}`);
		const sources = array(g.sourceUuids, `${at}.sourceUuids`);
		if (sources.some(v => typeof v !== "string" || !uuids.has(v)) || new Set(sources).size !== sources.length || !sources.includes(g.primaryUuid)) throw new Error(`Invalid ${at}.sourceUuids`);
	});
	if (root.vocabulary !== undefined) {
		const v = object(root.vocabulary, "vocabulary");
		if (v.stats !== undefined) numbers(v.stats, "total_words total_lookups mastered_words learning_words", "vocabulary.stats");
		records(v.words, "vocabulary.words", (word, at) => {
			lookup(word, at);
			if (typeof word.word !== "string") throw new Error(`Invalid ${at}.word`);
			if (word.lookups !== undefined) records(word.lookups, `${at}.lookups`, lookup);
		});
	}
}
