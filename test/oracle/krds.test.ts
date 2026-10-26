import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import { decodeKrds } from "../../src/decode/krds";

import { golden } from "./golden";

const FIXTURES = path.join(__dirname, "../fixtures");

const CACHE = path.join(FIXTURES, "cache");

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

function library(): OracleBook[] {
	if (!cachedLibrary) {
		cachedLibrary = golden().books as OracleBook[];
	}
	return cachedLibrary;
}

function allSidecars(): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
			const p = path.join(dir, e.name);
			if (e.isDirectory()) walk(p);
			else if (ALL_EXTS.some((x) => e.name.endsWith(x))) out.push(p);
		}
	};
	walk(path.join(CACHE, "documents"));
	return out.sort();
}

function sdrDirFor(location: string | null | undefined): string | undefined {
	if (!location || !location.startsWith("/mnt/us/")) return undefined;
	const rel = location.slice("/mnt/us/".length);
	const base = rel.replace(/\.[^./]*$/, "");
	const dir = path.join(CACHE, ...(base + ".sdr").split("/"));
	return fs.existsSync(dir) && fs.statSync(dir).isDirectory() ? dir : undefined;
}

interface Pair {
	uuid: string;
	file: string;
	ext: string;
	kind: "azw3f" | "azw3r";
	expected: Record<string, unknown>;
}

function pairs(): Pair[] {
	const out: Pair[] = [];
	for (const book of library()) {
		const dir = sdrDirFor(book.location);
		if (!dir) continue;

		const entries = fs.readdirSync(dir);
		const metrics = entries.filter((f) => METRICS_EXTS.some((x) => f.endsWith(x)));
		const reader = entries.filter((f) => READER_EXTS.some((x) => f.endsWith(x)));

		// The pairing is only sound while each .sdr holds at most one container
		// of each family. Fail loudly if a future fixture violates that.
		assert.ok(metrics.length <= 1, `${dir} has ${metrics.length} metric containers`);
		assert.ok(reader.length <= 1, `${dir} has ${reader.length} reader containers`);

		const push = (kind: "azw3f" | "azw3r", files: string[]) => {
			const tree = book[kind];
			if (!tree || Object.keys(tree).length === 0 || files.length !== 1) return;
			out.push({
				uuid: book.uuid,
				file: path.join(dir, files[0]),
				ext: path.extname(files[0]),
				kind,
				expected: tree,
			});
		};
		push("azw3f", metrics);
		push("azw3r", reader);
	}
	return out;
}

test("every paired sidecar decodes to its golden tree", () => {
	const paired = pairs();
	const failures: string[] = [];

	for (const p of paired) {
		const actual = decodeKrds(new Uint8Array(fs.readFileSync(p.file))).value;
		try {
			assert.deepStrictEqual(actual, p.expected);
		} catch (e) {
			failures.push(`${p.uuid} ${p.kind} ${path.basename(p.file)}: ${(e as Error).message}`);
		}
	}

	assert.deepStrictEqual(failures, [], `${failures.length} of ${paired.length} pairs diverged`);
	assert.equal(paired.length, 249, "paired count drifted; re-measure the fixture");
});

test("per-container-family pair counts hold, so KFX cannot vanish behind the folded JSON keys", () => {
	const counts: Record<string, number> = {};
	for (const p of pairs()) counts[p.ext] = (counts[p.ext] ?? 0) + 1;

	assert.deepStrictEqual(counts, {
		".yjf": 77,
		".yjr": 70,
		".mbs": 17,
		".mbp1": 17,
		".azw3f": 34,
		".azw3r": 34,
	});
});

test("all 442 cached containers decode with no raw fallback and no unparsed trailing", () => {
	const files = allSidecars();
	assert.equal(files.length, 442, "cached container count drifted; re-measure the fixture");

	const fallbacks: string[] = [];
	const trailing: string[] = [];

	for (const f of files) {
		const r = decodeKrds(new Uint8Array(fs.readFileSync(f)));
		for (const n of r.rawFallbacks) fallbacks.push(`${path.basename(f)}: ${n}`);
		for (const n of r.unparsedTrailing) trailing.push(`${path.basename(f)}: ${n}`);
	}

	assert.deepStrictEqual(fallbacks, []);
	assert.deepStrictEqual(trailing, []);
});

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
