import { BookFrontmatter, RawClipping } from "./types";

const MONTH_MAP: Record<string, number> = {
	// German
	januar: 1,
	februar: 2,
	märz: 3,
	maerz: 3,
	april: 4,
	mai: 5,
	juni: 6,
	juli: 7,
	august: 8,
	september: 9,
	oktober: 10,
	november: 11,
	dezember: 12,
	// English
	january: 1,
	february: 2,
	march: 3,
	may: 5,
	june: 6,
	july: 7,
	october: 10,
	december: 12,
	// French
	janvier: 1,
	février: 2,
	fevrier: 2,
	mars: 3,
	avril: 4,
	juin: 6,
	juillet: 7,
	août: 8,
	aout: 8,
	septembre: 9,
	octobre: 10,
	novembre: 11,
	décembre: 12,
	decembre: 12,
	// Spanish
	enero: 1,
	febrero: 2,
	marzo: 3,
	abril: 4,
	mayo: 5,
	junio: 6,
	julio: 7,
	agosto: 8,
	septiembre: 9,
	diciembre: 12,
};

export function parseClippingDate(raw?: string | null): string {
	if (!raw || typeof raw !== "string") {
		return "";
	}
	const trimmed = raw.trim();

	// Pattern 1: DD. Month YYYY or DD Month YYYY or DD de Month de YYYY
	const m1 = trimmed.match(/(\d{1,2})\.?(?:\s+de)?\s+([A-Za-zÀ-ÿ]+)(?:\s+de)?\s+(\d{4})/i);
	if (m1) {
		const day = parseInt(m1[1], 10);
		const monthName = m1[2].toLowerCase();
		const year = parseInt(m1[3], 10);
		const monthNum = MONTH_MAP[monthName];
		if (monthNum) {
			const mm = String(monthNum).padStart(2, "0");
			const dd = String(day).padStart(2, "0");
			return `${year}-${mm}-${dd}`;
		}
	}

	// Pattern 2: Month DD, YYYY
	const m2 = trimmed.match(/([A-Za-zÀ-ÿ]+)\s+(\d{1,2}),?\s+(\d{4})/i);
	if (m2) {
		const monthName = m2[1].toLowerCase();
		const day = parseInt(m2[2], 10);
		const year = parseInt(m2[3], 10);
		const monthNum = MONTH_MAP[monthName];
		if (monthNum) {
			const mm = String(monthNum).padStart(2, "0");
			const dd = String(day).padStart(2, "0");
			return `${year}-${mm}-${dd}`;
		}
	}

	// Pattern 3: YYYY-MM-DD
	const m3 = trimmed.match(/(\d{4}-\d{2}-\d{2})/);
	if (m3) {
		return m3[1];
	}

	return trimmed;
}

/** Entities are literal text in Markdown, not syntax (including Obsidian links).
 * Escape ampersands first/by the same pass so imported entities cannot reactivate.
 * Keep line breaks only where the renderer supplies a quote prefix on every line.
 */
function literalText(text: string, multiline = false): string {
	return text.replace(/\r\n?/g, "\n").replace(/[\\&<>\[\]!*_`{}()#+=|~^$%:.·\u0000-\u001f\u007f-\u009f\u2028\u2029]|-(?=[- \t])/g, (c, offset, source) => {
		if (c === "\n" && multiline) return c;
		// Sentence punctuation cannot start a list or form an autolink. Keep ordinary
		// prose stable, but encode domain dots and numeric list delimiters.
		if (c === "." && /\p{L}/u.test(source[offset - 1] || "") && (!source[offset + 1] || /\s/.test(source[offset + 1]))) return c;
		return `&#${c.charCodeAt(0)};`;
	});
}

export function formatClipping(clipping: RawClipping): string {
	const type = (clipping.type || "").toLowerCase();
	const text = literalText((clipping.text || "").trim(), type !== "note");
	if (!text && type !== "note") {
		return "";
	}

	const metaParts: string[] = [];
	if (clipping.page !== undefined && clipping.page !== null && String(clipping.page).trim()) {
		metaParts.push(`p. ${literalText(String(clipping.page).trim())}`);
	}
	if (clipping.location !== undefined && clipping.location !== null && String(clipping.location).trim()) {
		const locStr = String(clipping.location).trim().replace(/-/g, "–");
		metaParts.push(`loc. ${literalText(locStr)}`);
	}
	const addedAt = parseClippingDate(clipping.added_at);
	if (addedAt) {
		metaParts.push(literalText(addedAt));
	}

	const metaLine = metaParts.length > 0 ? `*${metaParts.join(" · ")}*` : "";

	if (type === "note") {
		const noteHeader = text ? `**Note:** ${text}` : `**Note**`;
		return metaLine ? `${noteHeader}\n${metaLine}` : noteHeader;
	}

	// Default to highlight: quote multi-line text
	const lines = text.split("\n");
	const quoted = lines.map((line) => `> ${line}`).join("\n");
	return metaLine ? `${quoted}\n${metaLine}` : quoted;
}

/** Normalised comparison key for a highlight or note body. */
function highlightKey(text: string): string {
	return text.replace(/&#(?:9|10|13);/g, " ").replace(/\s+/g, " ").trim();
}

/** The body of the `## Highlights` section, up to the next heading. */
function highlightsSection(markdown: string): string {
	const heading = "## Highlights";
	const idx = markdown.indexOf(heading);
	if (idx === -1) return "";
	const rest = markdown.slice(idx + heading.length);
	const next = rest.search(/\n#{1,6} /);
	return next === -1 ? rest : rest.slice(0, next);
}

/**
 * Every block on disk keyed by type/location/page/normalised body. The date is
 * not identity: the Kindle re-saves a highlight seconds apart without a change.
 * Keys compare rendered text, never HTML-decode retained user Markdown: decoding
 * could conflate literal imported markup with an intentionally active user link.
 * Blocks are returned verbatim so retained ones keep their own meta line.
 */
export function extractHighlightBlocks(markdown: string): Map<string, string> {
	const blocks = new Map<string, string>();
	const section = highlightsSection(markdown);
	if (!section.trim()) return blocks;

	for (const raw of section.split(/\n\s*\n/)) {
		const block = raw.trim();
		if (!block) continue;

		const lines = block.split("\n");
		let page = "", location = "";
		// Drop a single trailing meta line (`*loc. 1 · 2024-01-01*`), but never
		// a `**Note**` header, which also looks asterisk-delimited.
		if (lines.length > 1 && /^\*[^*].*\*$/.test(lines[lines.length - 1].trim())) {
			const meta = lines.pop()!.trim().slice(1, -1);
			for (const part of meta.split(" · ")) {
				if (part.startsWith("p. ")) page = part.slice(3);
				else if (part.startsWith("loc. ")) location = part.slice(5).replace(/-/g, "–");
			}
		}
		const body = lines.join("\n");

		let text: string | undefined;
		const type = body.startsWith("**Note") ? "note" : "highlight";
		if (body === "**Note**") {
			text = "";
		} else if (body.startsWith("**Note:**")) {
			text = body.slice("**Note:**".length);
		} else if (/^>\s?/.test(body)) {
			text = body
				.split("\n")
				.map((line) => line.replace(/^>\s?/, ""))
				.join(" ");
		}
		if (text === undefined) continue;

		const key = JSON.stringify([type, location, page, highlightKey(text)]);
		if (!blocks.has(key)) {
			blocks.set(key, block);
		}
	}

	return blocks;
}

/**
 * A clipping's identity as rendered: type, position and normalised text. Parsed
 * back from the formatted block, so incoming and retained blocks compare alike.
 * Undefined for bookmarks and empty highlights, which are never rendered.
 */
export function clippingKey(clipping: RawClipping | null | undefined): string | undefined {
	if (!clipping) return undefined;
	const type = (clipping.type || "").toLowerCase();
	if (type === "bookmark" || (!(clipping.text || "").trim() && type !== "note")) return undefined;
	const formatted = formatClipping(clipping);
	return formatted ? extractHighlightBlocks(`## Highlights\n\n${formatted}`).keys().next().value : undefined;
}

export interface RenderedHighlights {
	text: string;
	/** How many on-disk blocks survived because the source no longer carries them. */
	retained: number;
}

/**
	* Renders the incoming clippings, then appends any block still on disk that the
	* source no longer reports. Kindle prunes `My Clippings.txt` in place, so
	* without this a rotation or a lost cache would erase highlights from the vault.
	*/
export function renderHighlights(
	clippings: RawClipping[],
	existingMarkdown?: string
): RenderedHighlights {
	const seen = new Set<string>();
	const blocks: string[] = [];

	for (const clipping of clippings) {
		const key = clippingKey(clipping);
		// The first, earliest clipping wins; repeats only differ in their time.
		if (key === undefined || seen.has(key)) continue;
		seen.add(key);
		blocks.push(formatClipping(clipping));
	}

	let retained = 0;
	if (existingMarkdown) {
		for (const [key, block] of extractHighlightBlocks(existingMarkdown)) {
			if (seen.has(key)) continue;
			seen.add(key);
			blocks.push(block);
			retained++;
		}
	}

	return { text: blocks.join("\n\n"), retained };
}

const ORDERED_KEYS: (keyof BookFrontmatter)[] = [
	"meta_type",
	"meta_project",
	"meta_source",
	"meta_generator",
	"kindle_uuid",
	"kindle_asin",
	"kindle_title",
	"kindle_author",
	"kindle_publisher",
	"kindle_published",
	"kindle_language",
	"kindle_format",
	"kindle_drm",
	"kindle_type",
	"kindle_origin",
	"kindle_progress_derived",
	"kindle_percent_finished",
	"kindle_page",
	"kindle_total_pages",
	"kindle_text_read",
	"kindle_words_read",
	"kindle_book_words",
	"kindle_finished",
	"kindle_read_status",
	"kindle_hours",
	"kindle_wpm",
	"kindle_wpm_reading",
	"kindle_wpm_std_dev",
	"kindle_annotations",
	"kindle_clippings",
	"kindle_vocabulary",
	"kindle_added",
	"kindle_last_read",
	"kindle_last_access",
	"kindle_amazon_archived",
	"kindle_on_device",
	"kindle_cover",
];

function yamlJson(value: unknown): string {
	return JSON.stringify(value).replace(/[\u0085\u2028\u2029]/g, c =>
		`\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function renderFrontmatterYaml(fm: BookFrontmatter): string {
	const lines: string[] = ["---"];

	const keys = [...ORDERED_KEYS, ...Object.keys(fm).filter(k => !(ORDERED_KEYS as string[]).includes(k) && k !== "position").sort()];
	for (const key of keys) {
		const val = (fm as any)[key];
		if (val === undefined || val === null || (typeof val === "number" && !Number.isFinite(val))) continue;
		// JSON values are a YAML-compatible subset: strings cannot inject syntax,
		// and user arrays/objects retain their types (formatting/comments are not kept).
		const yamlKey = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key) ? key : yamlJson(key);
		lines.push(`${yamlKey}: ${yamlJson(val)}`);
	}

	lines.push("---");
	return lines.join("\n");
}

export interface RenderedNote {
	content: string;
	retainedHighlights: number;
}

export interface RenderNoteOptions {
	clippings?: RawClipping[];
	existingMarkdown?: string;
	/** Base view to embed, e.g. `Kindle.base#Detail`. Empty string omits the embed. */
	baseEmbed?: string;
}

export function renderBookNote(
	fm: BookFrontmatter,
	options: RenderNoteOptions = {}
): RenderedNote {
	const { clippings = [], existingMarkdown, baseEmbed = "" } = options;
	const parts: string[] = [];

	// 1. Frontmatter
	parts.push(renderFrontmatterYaml(fm));

	// 2. Cover image (if present)
	if (fm.kindle_cover) {
		if (/[\[\]|#\\<>:\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(fm.kindle_cover)) {
			throw new Error("Unsafe cover embed path");
		}
		parts.push(`![[${fm.kindle_cover}|150]]`);
	}

	// 3. Base view embed (configurable; the .base file is hand-written, not generated)
	if (baseEmbed && baseEmbed.trim()) {
		parts.push(`![[${baseEmbed.trim()}]]`);
	}

	// 4. Highlights (if any)
	const highlights = renderHighlights(clippings, existingMarkdown);
	if (highlights.text) {
		parts.push(`## Highlights\n\n${highlights.text}`);
	}

	return {
		content: parts.join("\n\n") + "\n",
		retainedHighlights: highlights.retained,
	};
}
