/*
 * Kindle Reader Data Store (KRDS) deserializer.
 *
 * TypeScript port of `reading-metadata/scripts/krds.py` from
 * kindle-reading-dashboard, which is itself:
 *
 *   Copyright (C) 2019 John Howell <jhowell@acm.org>
 *   Licensed under the GNU General Public License v3.
 *   https://github.com/K-R-D-S/KRDS
 *
 * This port is a derivative work and is therefore also GPL v3.
 * See LICENSE at the repository root.
 *
 * Port notes: the behaviours below do NOT survive a naive transliteration and
 * each is called out at its site.
 *   - `list.pop(0)` on empty raises in Python (the raw-fallback trigger);
 *     `Array.shift()` silently returns undefined. See `pop()`.
 *   - Python `None` serialises to `null`; JS `undefined` deletes the key.
 *   - `bytes.decode("utf-8")` is strict; `TextDecoder` defaults to lossy.
 *   - the datatype byte is *signed* (OBJECT_BEGIN=-2, OBJECT_END=-1).
 *   - `datetime.fromtimestamp().isoformat()` is naive *local* time with
 *     conditional microseconds, not `toISOString()`.
 */

export type KrdsValue =
	| null
	| boolean
	| number
	| string
	| KrdsValue[]
	| { [key: string]: KrdsValue };

export interface KrdsDecodeResult {
	/** The merged top-level structure map, mirroring krds.py's OrderedDict. */
	value: Record<string, KrdsValue>;
	/** Every log.warning/log.error krds.py would have emitted. */
	warnings: string[];
	/** Names of structures that took the raw-fallback path. */
	rawFallbacks: string[];
	/** Names of structures that carried unparsed trailing fields. */
	unparsedTrailing: string[];
}

export class KrdsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "KrdsError";
	}
}

const SIGNATURE = Uint8Array.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x1a, 0xb1, 0x26]);

const DATATYPE_BOOLEAN = 0;
const DATATYPE_INT = 1;
const DATATYPE_LONG = 2;
const DATATYPE_UTF = 3;
const DATATYPE_DOUBLE = 4;
const DATATYPE_SHORT = 5;
const DATATYPE_FLOAT = 6;
const DATATYPE_BYTE = 7;
const DATATYPE_CHAR = 9;
const DATATYPE_OBJECT_BEGIN = -2;
const DATATYPE_OBJECT_END = -1;

const ANNOT_CLASS_NAMES: Record<number, string> = {
	0: "annotation.personal.bookmark",
	1: "annotation.personal.highlight",
	2: "annotation.personal.note",
	3: "annotation.personal.clip_article", // value not verified
	10: "annotation.personal.handwritten_note",
	11: "annotation.personal.sticky_note",
	13: "annotation.personal.underline",
};

const ANNOT_CLASS_NAME_SET = new Set(Object.values(ANNOT_CLASS_NAMES));

/** Strict, exactly like Python's `bytes.decode("utf-8")`. */
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Port hazard #1, and the single most important line in this file.
 *
 * `krds.py` relies on `val.pop(0)` raising IndexError on a short value list:
 * `decode_object`'s `except Exception` catches it and returns the raw list,
 * keeping the byte stream aligned. `Array.prototype.shift()` returns
 * `undefined` and throws nothing, which would emit a *wrong* tree (with the
 * undefined fields silently deleted by JSON.stringify) instead of a safe
 * fallback, across every branch of `decodeKnown`.
 */
function pop(val: KrdsValue[]): KrdsValue {
	if (val.length === 0) {
		throw new KrdsError("pop from empty value list");
	}
	return val.shift() as KrdsValue;
}

/** `pop` where the caller needs a count; mirrors Python duck-typing failures. */
function popCount(val: KrdsValue[]): number {
	const n = pop(val);
	if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
		throw new KrdsError(`expected a non-negative integer count, got ${JSON.stringify(n)}`);
	}
	return n;
}

/**
 * Python evaluates a comprehension's outermost iterable *first*, so
 * `[val.pop(0) for _ in range(val.pop(0))]` pops the count before any element.
 * Preserving that order is load-bearing.
 */
function popList(val: KrdsValue[]): KrdsValue[] {
	const n = popCount(val);
	const out: KrdsValue[] = [];
	for (let i = 0; i < n; i++) out.push(pop(val));
	return out;
}

/** As `popList`, but unwraps each element's single named structure key. */
function popListUnwrapping(val: KrdsValue[], key: string): KrdsValue[] {
	const n = popCount(val);
	const out: KrdsValue[] = [];
	for (let i = 0; i < n; i++) {
		const item = pop(val);
		if (item === null || typeof item !== "object" || Array.isArray(item) || !(key in item)) {
			// Python would raise TypeError/KeyError here -> raw fallback.
			throw new KrdsError(`expected an object with key ${key}, got ${JSON.stringify(item)}`);
		}
		out.push((item as Record<string, KrdsValue>)[key]);
	}
	return out;
}

function pad(n: number, width: number): string {
	return String(Math.abs(n)).padStart(width, "0");
}

/**
 * Port hazard #2: reproduce `datetime.fromtimestamp(ms/1000.0).isoformat()`.
 *
 * That is naive *local* time, with a 6-digit fractional part that is omitted
 * entirely when microseconds are zero. `new Date(ms).toISOString()` would give
 * UTC, a `Z` suffix and always 3 digits. Because the output is local, the
 * golden tests pin TZ (see package.json).
 */
export function localIsoFromMillis(ms: number): string {
	const d = new Date(ms);
	if (Number.isNaN(d.getTime())) {
		throw new KrdsError(`not a valid timestamp: ${ms}`);
	}
	// getMilliseconds() is already floor-mod, matching Python's floor semantics
	// for negative epochs.
	const micros = d.getMilliseconds() * 1000;
	const date = `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
	const time = `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}`;
	return micros === 0 ? `${date}T${time}` : `${date}T${time}.${pad(micros, 6)}`;
}

function timestamp(value: KrdsValue): string {
	if (typeof value !== "number") {
		throw new KrdsError(`expected a numeric timestamp, got ${JSON.stringify(value)}`);
	}
	return localIsoFromMillis(value);
}

/**
 * Port hazard: `decode_position` is a pass-through in krds.py. Kept as a named
 * function so the port stays line-comparable with the original.
 */
function decodePosition(position: KrdsValue): KrdsValue {
	return position;
}

class Deserializer {
	private readonly view: DataView;
	private readonly bytes: Uint8Array;
	offset = 0;

	constructor(data: Uint8Array) {
		this.bytes = data;
		this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
	}

	get remaining(): number {
		return this.bytes.length - this.offset;
	}

	private need(size: number): void {
		if (this.remaining < size) {
			throw new KrdsError(
				`Deserializer: Insufficient data (need ${size} bytes, have ${this.remaining} bytes)`
			);
		}
	}

	/** Signed byte. Port hazard #5: never getUint8 -- OBJECT_BEGIN is -2. */
	int8(advance = true): number {
		this.need(1);
		const v = this.view.getInt8(this.offset);
		if (advance) this.offset += 1;
		return v;
	}

	int16(): number {
		this.need(2);
		const v = this.view.getInt16(this.offset, false);
		this.offset += 2;
		return v;
	}

	uint16(): number {
		this.need(2);
		const v = this.view.getUint16(this.offset, false);
		this.offset += 2;
		return v;
	}

	int32(): number {
		this.need(4);
		const v = this.view.getInt32(this.offset, false);
		this.offset += 4;
		return v;
	}

	/**
	 * Port hazard #4: `>q` is an 8-byte signed integer. `getBigInt64` returns a
	 * BigInt, which JSON.stringify throws on and which never deep-equals a
	 * Python int. Every observed value is well inside Number's safe range, so
	 * narrow deliberately -- with an assertion, not by accident.
	 */
	int64(): number {
		this.need(8);
		const v = this.view.getBigInt64(this.offset, false);
		this.offset += 8;
		if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(-Number.MAX_SAFE_INTEGER)) {
			throw new KrdsError(`long ${v} exceeds the safe integer range`);
		}
		return Number(v);
	}

	float32(): number {
		this.need(4);
		const v = this.view.getFloat32(this.offset, false);
		this.offset += 4;
		return v;
	}

	float64(): number {
		this.need(8);
		const v = this.view.getFloat64(this.offset, false);
		this.offset += 8;
		return v;
	}

	extract(size: number): Uint8Array {
		if (size < 0) throw new KrdsError(`Deserializer: negative size ${size}`);
		this.need(size);
		const out = this.bytes.subarray(this.offset, this.offset + size);
		this.offset += size;
		return out;
	}
}

class KindleReaderDataStore {
	private readonly krds: Deserializer;
	readonly warnings: string[] = [];
	readonly rawFallbacks: string[] = [];
	readonly unparsedTrailing: string[] = [];

	constructor(data: Uint8Array) {
		this.krds = new Deserializer(data);
	}

	deserialize(): Record<string, KrdsValue> {
		const signature = this.krds.extract(SIGNATURE.length);
		if (!SIGNATURE.every((b, i) => signature[i] === b)) {
			throw new KrdsError("KindleReaderDataStore signature is incorrect");
		}

		const firstValue = this.decodeNext();
		if (firstValue !== 1) {
			throw new KrdsError(`first_value = ${JSON.stringify(firstValue)}`);
		}

		const valueCnt = this.decodeNext();
		if (typeof valueCnt !== "number" || !Number.isInteger(valueCnt) || valueCnt < 0) {
			throw new KrdsError(`value_cnt = ${JSON.stringify(valueCnt)}`);
		}

		const value: Record<string, KrdsValue> = {};

		for (let i = 0; i < valueCnt; i++) {
			const val = this.decodeNext();
			// krds.py calls val.items(); a non-mapping raises and is not caught.
			if (val === null || typeof val !== "object" || Array.isArray(val)) {
				throw new KrdsError(
					`KindleReaderDataStore top-level value is not a structure: ${JSON.stringify(val)}`
				);
			}
			for (const [k, v] of Object.entries(val as Record<string, KrdsValue>)) {
				if (k in value) {
					throw new KrdsError(`KindleReaderDataStore has duplicate item ${k}`);
				}
				value[k] = v;
			}
		}

		if (this.krds.remaining !== 0) {
			this.warnings.push(
				`KindleReaderDataStore has ${this.krds.remaining} bytes of extra data`
			);
		}

		return value;
	}

	private decodeNext(datatype?: number): KrdsValue {
		const type = datatype === undefined ? this.krds.int8() : datatype;

		switch (type) {
			case DATATYPE_BOOLEAN: {
				const b = this.krds.int8();
				if (b === 0) return false;
				if (b === 1) return true;
				throw new KrdsError(`Unknown boolean value ${b}`);
			}
			case DATATYPE_INT:
				return this.krds.int32();
			case DATATYPE_LONG:
				return this.krds.int64();
			case DATATYPE_UTF: {
				if (this.decodeNext(DATATYPE_BOOLEAN)) return "";
				// Port hazard #3: strict decode, matching Python's
				// bytes.decode("utf-8"). This is NOT a raw-fallback trigger --
				// it fires while the cursor is still inside the object, so it
				// propagates out. That is correct: a bad byte means the stream
				// is desynchronised. A lossy TextDecoder would instead
				// substitute U+FFFD and keep parsing garbage.
				return UTF8.decode(this.krds.extract(this.krds.uint16()));
			}
			case DATATYPE_DOUBLE:
				return this.krds.float64();
			case DATATYPE_SHORT:
				return this.krds.int16();
			case DATATYPE_FLOAT:
				return this.krds.float32();
			case DATATYPE_BYTE:
				return this.krds.int8();
			case DATATYPE_CHAR:
				return UTF8.decode(this.krds.extract(1));
			case DATATYPE_OBJECT_BEGIN: {
				const name = this.decodeNext(DATATYPE_UTF);
				if (typeof name !== "string") {
					throw new KrdsError(`object name is not a string: ${JSON.stringify(name)}`);
				}
				const val: KrdsValue[] = [];
				// Look-ahead peek; signed, per port hazard #5.
				while (this.krds.int8(false) !== DATATYPE_OBJECT_END) {
					val.push(this.decodeNext());
				}
				this.krds.int8(); // consume OBJECT_END
				return this.decodeObject(name, val);
			}
			default:
				throw new KrdsError(`Unknown datatype ${type}`);
		}
	}

	private decodeObject(name: string, val: KrdsValue[]): KrdsValue {
		// Sub-values are fully read before this point (the cursor is already
		// past OBJECT_END), so any decode failure can fall back to the raw
		// value list without desynchronising the stream.
		const raw = val.slice();
		try {
			return { [name]: this.decodeKnown(name, val) };
		} catch (e) {
			this.warnings.push(`raw fallback for structure ${name}: ${String(e)}`);
			this.rawFallbacks.push(name);
			return { [name]: raw };
		}
	}

	private decodeKnown(name: string, val: KrdsValue[]): KrdsValue {
		let obj: KrdsValue = {};
		/** Narrowed alias; only used on the branches that build a mapping. */
		const o = () => obj as Record<string, KrdsValue>;

		if (
			name === "clock.data.store" ||
			name === "dictionary" ||
			name === "lpu" ||
			name === "pdf.contrast" ||
			name === "sync_lpr" ||
			name === "tpz.line.spacing" ||
			name === "XRAY_OTA_UPDATE_STATE" ||
			name === "XRAY_SHOWING_SPOILERS" ||
			name === "XRAY_SORTING_STATE" ||
			name === "XRAY_TAB_STATE"
		) {
			obj = pop(val); // single value
		} else if (
			name === "dict.prefs.v2" ||
			name === "EndActions" ||
			name === "ReaderMetrics" ||
			name === "StartActions" ||
			name === "Translator" ||
			name === "Wikipedia"
		) {
			const n = popCount(val);
			for (let i = 0; i < n; i++) {
				// key/value pairs
				const k = pop(val);
				if (typeof k !== "string") {
					throw new KrdsError(`non-string key ${JSON.stringify(k)} in ${name}`);
				}
				o()[k] = pop(val);
			}
		} else if (
			name === "buy.asin.response.data" ||
			name === "next.in.series.info.data" ||
			name === "price.info.data"
		) {
			obj = pop(val); // single value json
		} else if (name === "erl") {
			obj = decodePosition(pop(val));
		} else if (name === "lpr") {
			const version = pop(val);
			// Port hazard #7: string-or-int. Python tests isinstance *before*
			// comparing; JS would coerce ("1" <= 2 is true) and mis-branch.
			if (typeof version === "string") {
				o()["position"] = decodePosition(version); // old-style lpr
			} else if (typeof version === "number" && version <= 2) {
				o()["position"] = decodePosition(pop(val));
				const time = pop(val);
				// Port hazard #6: null, never undefined.
				o()["time"] = time !== -1 ? timestamp(time) : null;
			} else {
				throw new KrdsError(`Unknown lpr version ${JSON.stringify(version)}`);
			}
		} else if (name === "fpr" || name === "updated_lpr") {
			o()["position"] = decodePosition(pop(val));
			const time = pop(val);
			o()["time"] = time !== -1 ? timestamp(time) : null;
			const timezone = pop(val);
			o()["timeZoneOffset"] = timezone !== -1 ? timezone : null;
			o()["country"] = pop(val);
			o()["device"] = pop(val);
		} else if (name === "annotation.cache.object") {
			const n = popCount(val);
			for (let i = 0; i < n; i++) {
				const annotationType = pop(val);
				const annotClassName =
					typeof annotationType === "number" ? ANNOT_CLASS_NAMES[annotationType] : undefined;
				if (annotClassName === undefined) {
					throw new KrdsError(`Unknown annotation type ${JSON.stringify(annotationType)}`);
				}

				const tree = pop(val);
				if (
					tree === null ||
					typeof tree !== "object" ||
					Array.isArray(tree) ||
					!("saved.avl.interval.tree" in tree)
				) {
					throw new KrdsError(`Unknown annotation container: ${JSON.stringify(tree)}`);
				}
				const entries = (tree as Record<string, KrdsValue>)["saved.avl.interval.tree"];
				if (!Array.isArray(entries)) {
					throw new KrdsError(`saved.avl.interval.tree is not a list in ${name}`);
				}

				const annotations: KrdsValue[] = [];
				for (const annotation of entries) {
					if (
						annotation === null ||
						typeof annotation !== "object" ||
						Array.isArray(annotation) ||
						Object.keys(annotation).length !== 1 ||
						!(annotClassName in annotation)
					) {
						throw new KrdsError(`Unknown annotation format: ${JSON.stringify(annotation)}`);
					}
					annotations.push((annotation as Record<string, KrdsValue>)[annotClassName]);
				}

				o()[annotClassName] = annotations;
			}
		} else if (name === "saved.avl.interval.tree") {
			obj = popList(val); // annotation.personal.xxx
		} else if (ANNOT_CLASS_NAME_SET.has(name)) {
			o()["startPosition"] = decodePosition(pop(val));
			o()["endPosition"] = decodePosition(pop(val));
			o()["creationTime"] = timestamp(pop(val));
			o()["lastModificationTime"] = timestamp(pop(val));
			o()["template"] = pop(val);

			if (name === "annotation.personal.note") {
				o()["note"] = pop(val);
			} else if (name === "annotation.personal.handwritten_note") {
				o()["handwritten_note_nbk_ref"] = pop(val);
			} else if (name === "annotation.personal.sticky_note") {
				o()["sticky_note_nbk_ref"] = pop(val);
			}
		} else if (name === "apnx.key") {
			o()["asin"] = pop(val); // typically ISBN of the print edition
			o()["cdeType"] = pop(val);
			o()["sidecarAvailable"] = pop(val);
			o()["oPNToPosition"] = popList(val);
			o()["first"] = pop(val); // int
			o()["unknown1"] = pop(val); // int
			o()["unknown2"] = pop(val); // int
			o()["pageMap"] = pop(val); // "pageMapString"
		} else if (name === "fixed.layout.data") {
			o()["unknown1"] = pop(val); // boolean
			o()["unknown2"] = pop(val); // boolean
			o()["unknown3"] = pop(val); // boolean
		} else if (name === "sharing.limits") {
			o()["accumulated"] = pop(val);
		} else if (name === "language.store") {
			o()["language"] = pop(val); // string
			o()["unknown1"] = pop(val); // int
		} else if (name === "periodicals.view.state") {
			o()["unknown1"] = pop(val); // string
			o()["unknown2"] = pop(val); // string
		} else if (name === "font.prefs") {
			o()["typeface"] = pop(val); // string, default "_INVALID_"
			o()["lineSp"] = pop(val); // int (default -1)
			o()["size"] = pop(val); // int (default -1)
			o()["align"] = pop(val); // int (default -1)
			o()["insetTop"] = pop(val); // int (default -1)
			o()["insetLeft"] = pop(val); // int (default -1)
			o()["insetBottom"] = pop(val); // int (default -1)
			o()["insetRight"] = pop(val); // int (default -1)
			o()["unknown1"] = pop(val); // int (default -1)

			if (val.length) o()["bold"] = pop(val); // int (default -1)
			if (val.length) o()["userSideloadableFont"] = pop(val); // string
			if (val.length) o()["customFontIndex"] = pop(val); // int (default -1)
			if (val.length) o()["mobi7SystemFont"] = pop(val); // string
			if (val.length) o()["mobi7RestoreFont"] = pop(val); // boolean
			if (val.length) o()["readingPresetSelected"] = pop(val); // string
			if (val.length) o()["unknown2"] = pop(val);
		} else if (name === "purchase.state.data") {
			o()["state"] = pop(val); // string
			o()["time"] = timestamp(pop(val));
		} else if (name === "timer.data.store") {
			o()["on"] = pop(val); // boolean
			o()["readingTimerModel"] = pop(val);
			o()["version"] = pop(val); // long
		} else if (name === "timer.data.store.v2") {
			o()["on"] = pop(val); // boolean
			o()["readingTimerModel"] = pop(val);
			o()["version"] = pop(val); // long
			o()["lastOption"] = pop(val); // int
		} else if (name === "timer.model") {
			o()["version"] = pop(val);
			o()["totalTime"] = pop(val);
			o()["totalWords"] = pop(val);
			o()["totalPercent"] = pop(val);
			const avg = pop(val);
			if (
				avg === null ||
				typeof avg !== "object" ||
				Array.isArray(avg) ||
				!("timer.average.calculator" in avg)
			) {
				throw new KrdsError(`timer.model averageCalculator is malformed`);
			}
			o()["averageCalculator"] = (avg as Record<string, KrdsValue>)["timer.average.calculator"];
		} else if (name === "timer.average.calculator") {
			o()["samples1"] = popList(val); // doubles
			o()["samples2"] = popList(val); // doubles
			o()["normalDistributions"] = popListUnwrapping(
				val,
				"timer.average.calculator.distribution.normal"
			);
			o()["outliers"] = popListUnwrapping(val, "timer.average.calculator.outliers");
		} else if (name === "timer.average.calculator.distribution.normal") {
			o()["count"] = pop(val); // long
			o()["sum"] = pop(val); // double
			o()["sumOfSquares"] = pop(val); // double
		} else if (name === "timer.average.calculator.outliers") {
			obj = popList(val); // doubles
		} else if (name === "book.info.store") {
			o()["numberOfWords"] = pop(val); // long
			o()["percentOfBook"] = pop(val); // double
		} else if (name === "page.history.store") {
			obj = popListUnwrapping(val, "page.history.record");
		} else if (name === "page.history.record") {
			o()["position"] = decodePosition(pop(val));
			o()["time"] = timestamp(pop(val));
		} else if (name === "reader.state.preferences") {
			o()["fontPreferences"] = pop(val);
			o()["leftMargin"] = pop(val); // int
			o()["rightMargin"] = pop(val); // int
			o()["topMargin"] = pop(val); // int
			o()["bottomMargin"] = pop(val); // int
			o()["unknown1"] = pop(val); // boolean
		} else {
			this.warnings.push(`Unknown data structure ${name}`);
			// Python aliases `obj = val` then rebinds `val = []`, so the
			// trailing-drain below sees an empty list and does not fire.
			obj = val.slice();
			val.length = 0;
		}

		if (val.length) {
			// Newer firmware adds trailing fields this parser does not know.
			// Framing is delimiter-based, so draining here keeps the stream
			// aligned.
			this.warnings.push(
				`Excess values for structure ${name} (newer firmware?): ${JSON.stringify(val)}`
			);
			this.unparsedTrailing.push(name);
			// Port hazard #8: krds.py guards with isinstance(obj, dict), but in
			// JS `typeof [] === "object"`. Attaching this to an array would be
			// wrong twice over -- JSON.stringify then silently drops it.
			if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
				o()["_unparsed_trailing"] = val.slice();
			}
			val.length = 0;
		}

		return obj;
	}
}

/** Deserialize one KRDS container (.azw3f/.azw3r/.mbp1/.mbs/.yjf/.yjr). */
export function decodeKrds(data: Uint8Array): KrdsDecodeResult {
	const store = new KindleReaderDataStore(data);
	const value = store.deserialize();
	return {
		value,
		warnings: store.warnings,
		rawFallbacks: store.rawFallbacks,
		unparsedTrailing: store.unparsedTrailing,
	};
}
