import { BookFrontmatter, RawBook } from "./types";
import { clippingKey } from "./note-render";

export function normalizeAuthor(raw?: string | null): string {
	if (!raw || !raw.trim()) {
		return "Unknown";
	}
	const trimmed = raw.trim();
	if (trimmed.includes(" and ") || trimmed.includes("&")) {
		return trimmed;
	}
	const parts = trimmed.split(",");
	if (parts.length === 2) {
		const last = parts[0].trim();
		const first = parts[1].trim();
		if (first && last) {
			return `${first} ${last}`;
		}
	}
	return trimmed;
}

export function sanitizeFilename(name: string): string {
	// Replace Obsidian forbidden chars: * " \ / < > : | ? # ^ [ ]
	const cleaned = name.replace(/[*"\\/<>:|?#^[\]]/g, " ");
	return cleaned.replace(/\s+/g, " ").trim();
}

export function truncateOnWordBoundary(text: string, maxLen: number = 120): string {
	if (text.length <= maxLen) {
		return text;
	}
	let truncated = text.slice(0, maxLen);
	const lastSpace = truncated.lastIndexOf(" ");
	if (lastSpace > 0) {
		truncated = truncated.slice(0, lastSpace);
	}
	return truncated.replace(/[\s\-_]+$/, "");
}

export function formatDate(timestampOrString?: number | string | null): string | undefined {
	if (timestampOrString === null || timestampOrString === undefined || timestampOrString === "") {
		return undefined;
	}
	if (typeof timestampOrString === "number") {
		const ms = timestampOrString > 1e11 ? timestampOrString : timestampOrString * 1000;
		const d = new Date(ms);
		if (isNaN(d.getTime())) return undefined;
		// Local, not UTC: these are reading events on a device in the user's
		// timezone, and toISOString() would report the previous day for anything
		// before 01:00/02:00 local. formatDateTime below is likewise local.
		const yyyy = d.getFullYear();
		const mm = String(d.getMonth() + 1).padStart(2, "0");
		const dd = String(d.getDate()).padStart(2, "0");
		return `${yyyy}-${mm}-${dd}`;
	}
	if (typeof timestampOrString === "string") {
		const str = timestampOrString.trim();
		const match = str.match(/^(\d{4}-\d{2}-\d{2})/);
		if (match) {
			return match[1];
		}
		const num = Number(str);
		if (!isNaN(num) && num > 0) {
			return formatDate(num);
		}
	}
	return undefined;
}

export function formatDateTime(raw?: string | null): string | undefined {
	if (!raw || typeof raw !== "string") {
		return undefined;
	}
	const str = raw.trim();
	// Matches ISO strings like 2025-02-14T23:25:50 or 2025-02-14 23:25:50
	const match = str.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/);
	if (match) {
		return `${match[1]} ${match[2]}`;
	}
	const dateOnly = str.match(/^(\d{4}-\d{2}-\d{2})/);
	if (dateOnly) {
		return `${dateOnly[1]} 00:00:00`;
	}
	return undefined;
}

export function decodeMimeType(mime?: string | null): string | undefined {
	if (!mime) return undefined;
	switch (mime.trim()) {
		case "application/x-mobipocket-ebook":
			return "MOBI";
		case "application/x-kfx-ebook":
			return "KFX";
		case "application/x-mobi8-ebook":
			return "KF8";
		case "application/x-kindle-acx":
			return "ACX";
		case "text/plain":
			return "TXT";
		case "application/octet-stream":
			return "UNKNOWN";
		default:
			return mime.replace(/^application\/x-/, "").replace(/-ebook$/, "").toUpperCase();
	}
}

export function decodeOriginType(origin?: number | null): string {
	if (origin === 0) return "Purchased";
	if (origin === 22) return "Kindle Unlimited";
	if (origin === 10) return "Manual";
	return "Sideloaded";
}

function bisectRight(arr: number[], x: number): number {
	let low = 0;
	let high = arr.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (arr[mid] <= x) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

export interface ProgressAndPages {
	progress?: number;
	percentFinished?: number;
	page?: number;
	totalPages?: number;
	textRead?: number;
	wordsRead?: number;
	bookWords?: number;
}

export function resolveProgressAndPages(book: RawBook): ProgressAndPages {
	let progress: number | undefined;
	let percentFinished: number | undefined;
	let page: number | undefined;
	let totalPages: number | undefined;
	let textRead: number | undefined;
	let wordsRead: number | undefined;
	let bookWords: number | undefined;

	// Raw percent finished
	if (book.percentFinished !== undefined && book.percentFinished !== null) {
		percentFinished = Math.round(Number(book.percentFinished) * 10) / 10;
	}

	// APNX page calculations
	const azw3r = book.azw3r;
	if (azw3r && typeof azw3r === "object") {
		const apnxKey = azw3r["apnx.key"];
		if (apnxKey && Array.isArray(apnxKey.oPNToPosition) && apnxKey.oPNToPosition.length > 1) {
			const opn = apnxKey.oPNToPosition;
			const total = opn.length - 1;
			totalPages = total;

			const lpr = book.azw3f && typeof book.azw3f === "object" ? book.azw3f.lpr : null;
			const syncLpr = azw3r.sync_lpr;
			const fpr = book.azw3f && typeof book.azw3f === "object" ? book.azw3f.fpr : null;

			let posStr: string | number | null | undefined = null;
			for (const cand of [lpr, syncLpr, fpr]) {
				if (cand && typeof cand === "object" && cand.position !== undefined && cand.position !== null) {
					posStr = cand.position;
					break;
				}
			}

			if (posStr !== null && posStr !== undefined) {
				const byteOffset = parseInt(String(posStr).split(":")[0], 10);
				if (!isNaN(byteOffset)) {
					const idx = bisectRight(opn, byteOffset);
					page = Math.max(1, Math.min(total, idx - 1));
				}
			}
		}
	}

	// Stats
	const stats = book.stats;
	if (stats && typeof stats === "object") {
		if (stats.percent_read !== undefined && stats.percent_read !== null) {
			textRead = Math.round(Number(stats.percent_read) * 10) / 10;
		}
		if (stats.words_read !== undefined && stats.words_read !== null) {
			wordsRead = Math.round(Number(stats.words_read));
		}
		if (stats.book_words !== undefined && stats.book_words !== null) {
			bookWords = Math.round(Number(stats.book_words));
		}
	}

	if (bookWords === undefined && book.azw3f && typeof book.azw3f === "object") {
		const storeWords = book.azw3f["book.info.store"]?.numberOfWords;
		if (storeWords !== undefined && storeWords !== null) {
			bookWords = Math.round(Number(storeWords));
		}
	}

	// Inferred progress resolution:
	// 1. cc.db.p_percentFinished (if present)
	if (percentFinished !== undefined) {
		progress = Math.min(100.0, Math.max(0.0, percentFinished));
	} else if (page !== undefined && totalPages !== undefined && totalPages > 0) {
		// 2. APNX Page fraction from azw3r
		const apnxPct = (page / totalPages) * 100.0;
		progress = Math.min(100.0, Math.max(0.0, Math.round(apnxPct * 10) / 10));
	} else if (stats && stats.percent_read !== undefined && stats.percent_read !== null) {
		// 3. stats.percent_read capped at 100.0 %
		progress = Math.min(100.0, Math.max(0.0, Math.round(Number(stats.percent_read) * 10) / 10));
	} else if (book.read_status === "read") {
		// 4. 100.0 % IF read_status == "read" and no measurement exists
		progress = 100.0;
	}

	return {
		progress,
		percentFinished,
		page,
		totalPages,
		textRead,
		wordsRead,
		bookWords,
	};
}

export function isFinished(book: RawBook, progress?: number): boolean {
	if (book.read_status === "read") {
		return true;
	}
	if (progress !== undefined && progress >= 93.0) {
		return true;
	}
	return false;
}

export function isActiveBook(book: RawBook): boolean {
	const hasStats = Boolean(
		book.stats &&
			(book.stats.hours !== undefined ||
				book.stats.words_read !== undefined ||
				book.stats.percent_read !== undefined)
	);
	const hasAnnotations = Boolean(
		Array.isArray(book.annotations) && book.annotations.length > 0
	);
	const hasPercent = Boolean(
		book.percentFinished !== undefined &&
			book.percentFinished !== null &&
			book.percentFinished > 0
	);
	const isRead = book.read_status === "read";
	const hasClippings = Boolean(
		Array.isArray(book.clippings) &&
			book.clippings.some((c) => c && c.type !== "bookmark" && (c.text || "").trim())
	);
	const hasVocab = Boolean(
		Array.isArray(book.vocabulary) && book.vocabulary.length > 0
	);

	return hasStats || hasAnnotations || hasPercent || isRead || hasClippings || hasVocab;
}

export function generateFilenames(books: RawBook[]): Map<string, string> {
	const baseNameCounts = new Map<string, number>();
	const baseNames = new Map<string, string>();

	for (const book of books) {
		const author = normalizeAuthor(book.author);
		const cleanAuthor = sanitizeFilename(author);
		const cleanTitle = sanitizeFilename(book.title || "Untitled");
		const combined = `${cleanAuthor}--${cleanTitle}`;
		const truncated = truncateOnWordBoundary(combined, 120);

		baseNames.set(book.uuid, truncated);
		baseNameCounts.set(truncated, (baseNameCounts.get(truncated) || 0) + 1);
	}

	const result = new Map<string, string>();
	for (const book of books) {
		const base = baseNames.get(book.uuid)!;
		const count = baseNameCounts.get(base) || 1;
		if (count > 1) {
			const shortUuid = book.uuid.slice(0, 8);
			result.set(book.uuid, `${base}--${shortUuid}.md`);
		} else {
			result.set(book.uuid, `${base}.md`);
		}
	}

	return result;
}

export function buildBookFrontmatter(
	book: RawBook,
	options: {
		targetFolder: string;
		assetsSubfolder?: string;
		copyCovers: boolean;
		existingFrontmatter?: Partial<BookFrontmatter>;
	}
): BookFrontmatter {
	const {
		targetFolder,
		assetsSubfolder = "assets",
		copyCovers,
		existingFrontmatter,
	} = options;
	const resolved = resolveProgressAndPages(book);

	const annotationsCount = Array.isArray(book.annotations) ? book.annotations.length : undefined;
	const vocabCount = Array.isArray(book.vocabulary) ? book.vocabulary.length : undefined;
	const finalClippingsCount = Array.isArray(book.clippings)
		? new Set(book.clippings.filter((c) => c && (c.text || "").trim()).map(clippingKey).filter(Boolean)).size
		: undefined;

	let lastReadTime: string | undefined;
	if (book.azw3f && typeof book.azw3f === "object") {
		const lprTime = book.azw3f.lpr?.time;
		const fprTime = book.azw3f.fpr?.time;
		lastReadTime = formatDateTime(lprTime || fprTime);
	}

	let coverPath: string | undefined;
	if (copyCovers && book.thumbnail && typeof book.thumbnail === "string") {
		const thumbnailName = book.thumbnail.split("/").pop();
		if (thumbnailName) {
			coverPath = `${targetFolder}/${assetsSubfolder}/${thumbnailName}`;
		}
	}

	const stats = book.stats;

	const finished = isFinished(book, resolved.progress);
	const onDevice = book.on_device === false || (book as any).on_device === 0 ? false : true;

	const incoming: Partial<BookFrontmatter> = {
		meta_type: "db",
		meta_project: "reading_db",
		meta_source: "kindle",
		meta_generator: "kindle_sync",
		kindle_uuid: book.uuid,
		kindle_asin: book.cdeKey ? String(book.cdeKey) : undefined,
		kindle_title: book.title,
		kindle_author: normalizeAuthor(book.author),
		kindle_publisher: book.publisher ? String(book.publisher) : undefined,
		kindle_published: formatDate(book.publicationDate),
		kindle_language: book.language ? String(book.language) : undefined,
		kindle_format: decodeMimeType(book.mimeType),
		kindle_drm:
			book.isDRMProtected !== undefined && book.isDRMProtected !== null
				? Boolean(book.isDRMProtected)
				: undefined,
		kindle_type: book.cdeType ? String(book.cdeType) : undefined,
		kindle_origin: decodeOriginType(book.originType),
		kindle_progress_derived: resolved.progress,
		kindle_percent_finished: resolved.percentFinished,
		kindle_page: resolved.page,
		kindle_total_pages: resolved.totalPages,
		kindle_text_read: resolved.textRead,
		kindle_words_read: resolved.wordsRead,
		kindle_book_words: resolved.bookWords,
		kindle_finished: finished,
		kindle_read_status: book.read_status ? String(book.read_status) : undefined,
		kindle_hours:
			stats?.hours !== undefined && stats?.hours !== null
				? Math.round(Number(stats.hours) * 10) / 10
				: undefined,
		kindle_wpm:
			stats?.wpm_overall !== undefined && stats?.wpm_overall !== null
				? Math.round(Number(stats.wpm_overall))
				: undefined,
		kindle_wpm_reading:
			stats?.wpm_reading !== undefined && stats?.wpm_reading !== null
				? Math.round(Number(stats.wpm_reading))
				: undefined,
		kindle_wpm_std_dev:
			stats?.wpm_std_dev !== undefined && stats?.wpm_std_dev !== null
				? Math.round(Number(stats.wpm_std_dev) * 10) / 10
				: undefined,
		kindle_annotations: annotationsCount && annotationsCount > 0 ? annotationsCount : undefined,
		kindle_clippings: finalClippingsCount && finalClippingsCount > 0 ? finalClippingsCount : undefined,
		kindle_vocabulary: vocabCount && vocabCount > 0 ? vocabCount : undefined,
		kindle_added: formatDate(book.addedDate),
		kindle_last_read: lastReadTime,
		kindle_last_access: formatDate(book.lastAccess),
		kindle_amazon_archived: book.isArchived === 1 || book.isArchived === true,
		kindle_on_device: onDevice,
		kindle_cover: coverPath,
	};

	// Non-destructive update: preserve existing frontmatter values if incoming is undefined
	const merged: any = Object.assign(Object.create(null), {
		meta_type: "db",
		meta_project: "reading_db",
		meta_source: "kindle",
		meta_generator: "kindle_sync",
		kindle_uuid: book.uuid,
	});

	const allKeys = new Set([
		...Object.keys(incoming),
		...(existingFrontmatter ? Object.keys(existingFrontmatter) : []),
	]);

	for (const key of allKeys) {
		if (key === "position" || Object.hasOwn(merged, key)) continue;
		const incVal = Object.hasOwn(incoming, key) ? (incoming as any)[key] : undefined;
		const existVal = existingFrontmatter ? (existingFrontmatter as any)[key] : undefined;

		if (incVal !== undefined && incVal !== null) {
			merged[key] = incVal;
		} else if (existVal !== undefined && existVal !== null) {
			merged[key] = existVal;
		}
	}

	return merged as BookFrontmatter;
}
