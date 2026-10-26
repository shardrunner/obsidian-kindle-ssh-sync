/**
 * Kindle Vocabulary Builder database (`vocab.db`).
 *
 * On the measured FW 5.11.2 snapshot every WORDS row has category 0, so
 * `mastered_words: 0` and `learning_words: 2096` do not measure actual mastery.
 */
import * as fs from "node:fs";
import { num, str, titleKey } from "./normalize";
import { queryOptional, withDatabase } from "./sqlite";

export interface VocabBook {
	id: string;
	asin: string | null;
	guid: string | null;
	lang: string | null;
	title: string | null;
	authors: string | null;
}

export interface VocabLookup {
	id: string | null;
	word_key: string | null;
	book_key: string | null;
	book_asin: string | null;
	book_title: string | null;
	dict_key: string | null;
	pos: string | null;
	usage: string;
	timestamp: number | null;
}

export interface VocabWord {
	id: string | null;
	word_key: string | null;
	word: string;
	stem: string;
	category: number;
	status: "mastered" | "learning";
	timestamp: number | null;
	lookup_count: number;
	lookups: VocabLookup[];
}

export interface VocabularyData {
	stats: {
		total_words: number;
		total_lookups: number;
		mastered_words: number;
		learning_words: number;
	};
	words: VocabWord[];
	books: Record<string, VocabBook>;
	by_book: Record<string, VocabLookup[]>;
	by_title: Record<string, VocabLookup[]>;
}

export function emptyVocabulary(): VocabularyData {
	return {
		stats: { total_words: 0, total_lookups: 0, mastered_words: 0, learning_words: 0 },
		words: [],
		books: {},
		by_book: {},
		by_title: {},
	};
}

export function loadVocabulary(dbPath: string | null | undefined): VocabularyData {
	if (!dbPath || !fs.existsSync(dbPath)) return emptyVocabulary();

	return withDatabase(dbPath, (db) => {
		const books: Record<string, VocabBook> = {};
		for (const r of queryOptional(db, "SELECT * FROM BOOK_INFO")) {
			const bid = str(r["id"]);
			if (!bid) continue;
			books[bid] = {
				id: bid,
				asin: str(r["asin"]),
				guid: str(r["guid"]),
				lang: str(r["lang"]),
				title: str(r["title"]),
				authors: str(r["authors"]),
			};
		}

		const lookupsByWord: Record<string, VocabLookup[]> = {};
		const byBook: Record<string, VocabLookup[]> = {};
		const byTitle: Record<string, VocabLookup[]> = {};
		let totalLookups = 0;

		for (const r of queryOptional(db, "SELECT * FROM LOOKUPS ORDER BY timestamp ASC")) {
			const wordKey = str(r["word_key"]) || str(r["id"]);
			const bookKey = str(r["book_key"]);
			const info = bookKey ? books[bookKey] : undefined;

			const item: VocabLookup = {
				id: str(r["id"]),
				word_key: wordKey,
				book_key: bookKey,
				book_asin: info?.asin ?? null,
				book_title: info?.title ?? null,
				dict_key: str(r["dict_key"]),
				pos: str(r["pos"]),
				usage: (str(r["usage"]) ?? "").trim(),
				timestamp: num(r["timestamp"]),
			};

			if (wordKey) (lookupsByWord[wordKey] ??= []).push(item);

			// Index each lookup under the book's ASIN, its GUID and its raw
			// key, skipping duplicates among the three.
			const asin = info?.asin ?? null;
			const guid = info?.guid ?? null;
			if (asin) (byBook[asin] ??= []).push(item);
			if (guid && guid !== asin) (byBook[guid] ??= []).push(item);
			if (bookKey && bookKey !== asin && bookKey !== guid) (byBook[bookKey] ??= []).push(item);

			const title = info?.title ?? null;
			if (title) {
				const norm = titleKey(title);
				if (norm) (byTitle[norm] ??= []).push(item);
			}

			totalLookups++;
		}

		const words: VocabWord[] = [];
		let mastered = 0;
		let learning = 0;

		for (const r of queryOptional(db, "SELECT * FROM WORDS ORDER BY timestamp DESC")) {
			const wordKey = str(r["id"]) || str(r["word_key"]);
			const cat = num(r["category"]) ?? 0;
			const isMastered = cat >= 100;
			if (isMastered) mastered++;
			else learning++;

			const wLookups = wordKey ? lookupsByWord[wordKey] ?? [] : [];
			words.push({
				id: str(r["id"]),
				word_key: wordKey,
				word: str(r["word"]) ?? "",
				stem: str(r["stem"]) || str(r["word"]) || "",
				category: cat,
				status: isMastered ? "mastered" : "learning",
				timestamp: num(r["timestamp"]),
				lookup_count: wLookups.length,
				lookups: wLookups,
			});
		}

		return {
			stats: {
				total_words: words.length,
				total_lookups: totalLookups,
				mastered_words: mastered,
				learning_words: learning,
			},
			words,
			books,
			by_book: byBook,
			by_title: byTitle,
		};
	});
}

/**
 * Union two lookup lists by the stable lookup `id`.
 * Unlike clippings, vocabulary is not protected by `mergeClippingsBytes`,
 * because `vocab.db` is a genuine whole-file overwrite: a device-side prune
 * would otherwise shrink the retained record.
 */
export function unionLookups(
	archived: VocabLookup[] | null | undefined,
	incoming: VocabLookup[] | null | undefined
): VocabLookup[] {
	const chosen = new Map<string, VocabLookup>();
	for (const item of [...(archived ?? []), ...(incoming ?? [])]) {
		// Without an ID, only an identical consumed tuple is a repeat.
		const key = item.id ? `id:${item.id}` : JSON.stringify([
			item.word_key ?? null, item.book_key ?? null, item.book_asin ?? null,
			item.book_title ?? null, item.dict_key ?? null, item.pos ?? null,
			item.usage, item.timestamp ?? null,
		]);
		chosen.set(key, item);
	}
	return [...chosen.values()];
}
