/**
 * Parser and merger for Kindle `My Clippings.txt`.
 *
 * `mergeClippingsBytes` is load-bearing and must run in the *pull* path, before
 * anything is written. Kindle prunes `My Clippings.txt` in place, so
 * writing the device's copy straight out of the tar stream would destroy every
 * clipping the device has since dropped.
 */
import { RawClipping } from "../types";
import { titleKey } from "./normalize";

// JS `\s` and `trim()` include U+FEFF, so BOMs that older merges left
// mid-file are stripped along with ordinary whitespace.
const HEADER_RE = /^(.*?)(?:\s*\(([^()]+)\))?\s*$/u;
const PAGE_RE = /(?:page|seite|p[áa]g(?:ina)?|p\.)\s*(\d+)/i;
const LOC_RE = /(?:location|position|emplacement|posici[óo]n)\s*([0-9]+(?:-[0-9]+)?)/i;
const DATE_RE = /(?:added on|hinzugef[üu]gt am|ajout[ée] le|a[ñn]adido el)\s+(.*)$/iu;

const NOTE_KEYS = ["note", "notiz", "nota"];
const BOOKMARK_KEYS = ["bookmark", "lesezeichen", "signet", "marcador", "segnalibro"];

export interface ParsedClippings {
	clippings: RawClipping[];
	by_title: Record<string, RawClipping[]>;
}

function parseEntryType(metaLine: string): "note" | "bookmark" | "highlight" {
	const lower = metaLine.toLowerCase();
	if (NOTE_KEYS.some((k) => lower.includes(k))) return "note";
	if (BOOKMARK_KEYS.some((k) => lower.includes(k))) return "bookmark";
	return "highlight";
}

/**
 * Line separators include the rarer Unicode ones, so a stray vertical tab
 * starts a new line instead of being folded into the body text. The split
 * decides both the parsed record and the merge key, so changing it changes
 * which blocks count as duplicates.
 */
const LINE_SEP = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/;

function splitBlockLines(block: string): string[] {
	return block
		.split(LINE_SEP)
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
}

export function parseClippings(text: string): ParsedClippings {
	const clippings: RawClipping[] = [];
	const byTitle: Record<string, RawClipping[]> = {};

	for (const block of text.split("==========")) {
		const lines = splitBlockLines(block);
		if (lines.length < 2) continue;

		const titleLine = lines[0];
		const metaLine = lines[1];
		const body = lines.length > 2 ? lines.slice(2).join("\n").trim() : "";

		let title = titleLine;
		let author = "";
		const head = HEADER_RE.exec(titleLine);
		if (head) {
			title = (head[1] ?? "").trim();
			author = (head[2] ?? "").trim();
		}

		const entryType = parseEntryType(metaLine);

		const mPage = PAGE_RE.exec(metaLine);
		const page = mPage ? Number.parseInt(mPage[1], 10) : null;

		const mLoc = LOC_RE.exec(metaLine);
		const location = mLoc ? mLoc[1] : null;

		const mDate = DATE_RE.exec(metaLine);
		const addedAt = mDate ? mDate[1].trim() : null;

		const record: RawClipping = {
			title,
			author,
			type: entryType,
			page: Number.isNaN(page as number) ? null : page,
			location,
			added_at: addedAt,
			text: body,
		};
		clippings.push(record);

		const normTitle = titleKey(title);
		if (normTitle) {
			(byTitle[normTitle] ??= []).push(record);
		}
	}

	return {
		clippings,
		by_title: byTitle,
	};
}

/**
 * The identity of a clipping block for merge purposes. Clippings carry no id,
 * so the parsed tuple is the only stable key available.
 */
type BlockKey = string;

function blockKey(titleLine: string, metaLine: string, body: string): BlockKey {
	return JSON.stringify([titleLine, metaLine, body]);
}

function extractBlocks(text: string): Array<{ key: BlockKey; raw: string }> {
	const out: Array<{ key: BlockKey; raw: string }> = [];
	for (const block of text.split("==========")) {
		const lines = splitBlockLines(block);
		if (lines.length < 2) continue;
		const body = lines.length > 2 ? lines.slice(2).join("\n").trim() : "";
		out.push({ key: blockKey(lines[0], lines[1], body), raw: block.trim() });
	}
	return out;
}

/** Preserve every existing entry and append only genuinely new ones. */
export function mergeClippingsText(existingText: string, incomingText: string): string {
	if (!existingText || !existingText.trim()) return incomingText || "";
	if (!incomingText || !incomingText.trim()) return existingText;

	const existing = extractBlocks(existingText);
	if (existing.length === 0) return incomingText;

	const incoming = extractBlocks(incomingText);
	if (incoming.length === 0) return existingText;

	const seen = new Set(existing.map((b) => b.key));
	const newRaw = incoming.filter((b) => !seen.has(b.key)).map((b) => b.raw);
	if (newRaw.length === 0) return existingText;

	return [...existing.map((b) => b.raw), ...newRaw].join("\n==========\n") + "\n==========\n";
}

/** Decode UTF-8, dropping a leading BOM. */
export function decodeUtf8Sig(bytes: Uint8Array | null | undefined): string {
	if (!bytes || bytes.length === 0) return "";
	// Lossy, unlike the KRDS decoder: one bad byte must not cost every clipping.
	const text = new TextDecoder("utf-8").decode(bytes);
	return text.startsWith("﻿") ? text.slice(1) : text;
}

/**
 * Merge the cached clippings file with the device's copy, returning UTF-8 bytes
 * with a BOM. Retain cached blocks when the device prunes its own copy, so
 * those blocks are not lost from the cache.
 */
export function mergeClippingsBytes(
	existingBytes: Uint8Array | null | undefined,
	incomingBytes: Uint8Array | null | undefined
): Uint8Array {
	const merged = mergeClippingsText(decodeUtf8Sig(existingBytes), decodeUtf8Sig(incomingBytes));
	const withBom = merged.startsWith("﻿") ? merged : "﻿" + merged;
	return new TextEncoder().encode(withBom);
}
