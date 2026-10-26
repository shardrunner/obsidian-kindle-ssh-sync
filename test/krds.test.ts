import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import { decodeKrds } from "../src/decode/krds";

const METRICS_EXTS = [".azw3f", ".yjf", ".mbs"];

const READER_EXTS = [".azw3r", ".yjr", ".mbp1"];

const ALL_EXTS = [...METRICS_EXTS, ...READER_EXTS];

interface OracleBook {
	uuid: string;
	title: string;
	location?: string | null;
	azw3f?: Record<string, unknown> | null;
	azw3r?: Record<string, unknown> | null;
}

let cachedLibrary: OracleBook[] | undefined;

interface Pair {
	uuid: string;
	file: string;
	ext: string;
	kind: "azw3f" | "azw3r";
	expected: Record<string, unknown>;
}

class Enc {
	private parts: number[] = [];
	private raw(...b: number[]) { this.parts.push(...b); return this; }
	byte(v: number) { return this.raw(v & 0xff); }
	int(v: number) { const b = Buffer.alloc(5); b.writeInt8(1, 0); b.writeInt32BE(v, 1); return this.raw(...b); }
	long(v: bigint) { const b = Buffer.alloc(9); b.writeInt8(2, 0); b.writeBigInt64BE(v, 1); return this.raw(...b); }
	utf(s: string) {
		const u = Buffer.from(s, "utf-8");
		const b = Buffer.alloc(4 + u.length);
		b.writeInt8(3, 0); b.writeInt8(0, 1); b.writeUInt16BE(u.length, 2); u.copy(b, 4);
		return this.raw(...b);
	}
	/** Raw UTF payload with no type byte, for an object name. */
	private nameBytes(s: string) {
		const u = Buffer.from(s, "utf-8");
		const b = Buffer.alloc(3 + u.length);
		b.writeInt8(0, 0); b.writeUInt16BE(u.length, 1); u.copy(b, 3);
		return [...b];
	}
	obj(name: string, body: (e: Enc) => void) {
		this.raw(0xfe, ...this.nameBytes(name));
		body(this);
		return this.raw(0xff);
	}
	/** Wrap as a complete KRDS file with `count` top-level structures. */
	file(count: number): Uint8Array {
		const head = [0x00, 0x00, 0x00, 0x00, 0x00, 0x1a, 0xb1, 0x26];
		const pre = new Enc().int(1).int(count);
		return Uint8Array.from([...head, ...pre.parts, ...this.parts]);
	}
}

test("a truncated structure takes the raw fallback instead of emitting undefined fields", () => {
	// fpr wants position, time, timeZoneOffset, country, device. Supply two.
	const data = new Enc().obj("fpr", (e) => { e.utf("AcAAAAAAAA"); e.long(1739571950579n); }).file(1);
	const r = decodeKrds(data);

	assert.deepStrictEqual(r.rawFallbacks, ["fpr"]);
	// The raw value list, not a half-built object with vanished keys.
	assert.deepStrictEqual(r.value.fpr, ["AcAAAAAAAA", 1739571950579]);
});

test("optional timestamps decode to null, never undefined, so the key survives JSON", () => {
	const data = new Enc()
		.obj("fpr", (e) => { e.utf("p"); e.long(-1n); e.long(-1n); e.utf("DE"); e.utf("dev"); })
		.file(1);
	const fpr = decodeKrds(data).value.fpr as Record<string, unknown>;

	assert.deepStrictEqual(fpr, {
		position: "p", time: null, timeZoneOffset: null, country: "DE", device: "dev",
	});
	// The hazard is invisible until serialisation: undefined would delete both.
	assert.ok(JSON.stringify(fpr).includes('"time":null'));
	assert.ok(JSON.stringify(fpr).includes('"timeZoneOffset":null'));
});

test("timestamps are naive-local ISO strings, omitting a zero fraction", () => {
	const withMicros = new Enc()
		.obj("page.history.record", (e) => { e.utf("p"); e.long(1739571950579n); })
		.file(1);
	const zeroMicros = new Enc()
		.obj("page.history.record", (e) => { e.utf("p"); e.long(1739571950000n); })
		.file(1);

	const a = decodeKrds(withMicros).value["page.history.record"] as Record<string, unknown>;
	const z = decodeKrds(zeroMicros).value["page.history.record"] as Record<string, unknown>;

	// TZ is pinned to Europe/Berlin by the test script; local, no Z, 6 digits.
	assert.equal(a.time, "2025-02-14T23:25:50.579000");
	assert.equal(z.time, "2025-02-14T23:25:50");
});

test("invalid UTF-8 throws rather than substituting U+FFFD", () => {
	// Port hazard #3, with a correction to the plan's rationale: a bad byte can
	// NOT reach the raw fallback. UTF decoding happens in decodeNext, i.e. while
	// the byte cursor is still inside the object, whereas decodeObject only runs
	// after OBJECT_END. Python raises here too (verified against krds.py). The
	// hazard is that a lossy TextDecoder would substitute U+FFFD and carry on
	// with a desynchronised stream, turning a hard failure into silent garbage.
	const data = Uint8Array.from([
		0x00, 0x00, 0x00, 0x00, 0x00, 0x1a, 0xb1, 0x26,
		1, 0, 0, 0, 1, // first_value = 1
		1, 0, 0, 0, 1, // value_cnt = 1
		0xfe, 0x00, 0x00, 0x03, 0x66, 0x70, 0x72, // OBJECT_BEGIN "fpr"
		0x03, 0x00, 0x00, 0x01, 0xff, // utf, len 1, invalid start byte
		0xff, // OBJECT_END
	]);
	assert.throws(() => decodeKrds(data), /not valid for encoding utf-8|invalid/i);
});

test("unparsed trailing fields attach to a structure but never to an array", () => {
	// book.info.store consumes two values; a third is firmware drift.
	const drifted = new Enc()
		.obj("book.info.store", (e) => { e.long(1000n); e.byte(4); e.byte(0); e.byte(0); e.byte(0);
			e.byte(0); e.byte(0); e.byte(0); e.byte(0); e.byte(0); e.int(99); })
		.file(1);
	const r = decodeKrds(drifted);
	const bis = r.value["book.info.store"] as Record<string, unknown>;

	assert.deepStrictEqual(r.unparsedTrailing, ["book.info.store"]);
	assert.deepStrictEqual(bis._unparsed_trailing, [99]);
	// Round-trips: an array-attached property would be dropped here.
	assert.ok(JSON.stringify(bis).includes("_unparsed_trailing"));
});

test("the datatype byte is read signed, so OBJECT_BEGIN/END frame correctly", () => {
	const nested = new Enc()
		.obj("page.history.store", (e) => {
			e.int(1);
			e.obj("page.history.record", (i) => { i.utf("pos"); i.long(0n); });
		})
		.file(1);
	const rows = decodeKrds(nested).value["page.history.store"] as Record<string, unknown>[];
	assert.equal(rows.length, 1);
	assert.equal(rows[0].position, "pos");
});
