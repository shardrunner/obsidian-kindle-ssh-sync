import { test } from "node:test";

import assert from "node:assert/strict";

import { parseTar, TarParser, TarError, assertSafeMemberPath, BLOCK_SIZE } from "../src/device/tar";

function header(name: string, size: number, typeflag: string, corruptChecksum = false): Uint8Array {
	const b = Buffer.alloc(BLOCK_SIZE);
	b.write(name, 0, 100, "utf-8");
	b.write("0000644\0", 100, 8, "ascii");
	b.write("0000000\0", 108, 8, "ascii");
	b.write("0000000\0", 116, 8, "ascii");
	b.write(size.toString(8).padStart(11, "0") + "\0", 124, 12, "ascii");
	b.write("00000000000\0", 136, 12, "ascii");
	b.write("        ", 148, 8, "ascii"); // checksum placeholder
	b.write(typeflag, 156, 1, "ascii");
	b.write("ustar\0", 257, 6, "ascii");
	b.write("00", 263, 2, "ascii");

	let sum = 0;
	for (let i = 0; i < BLOCK_SIZE; i++) sum += b[i];
	if (corruptChecksum) sum += 1;
	b.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
	return new Uint8Array(b);
}

function archive(...parts: Uint8Array[]): Uint8Array {
	const eof = new Uint8Array(BLOCK_SIZE * 2);
	const total = parts.reduce((n, p) => n + p.length, 0) + eof.length;
	const out = new Uint8Array(total);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	out.set(eof, o);
	return out;
}

function body(text: string): Uint8Array {
	const b = Buffer.alloc(Math.ceil(Buffer.byteLength(text) / BLOCK_SIZE) * BLOCK_SIZE || BLOCK_SIZE);
	b.write(text, 0, "utf-8");
	return new Uint8Array(b);
}

test("a corrupt header checksum fails before anything is accepted", () => {
	const bad = archive(header("mnt/us/documents/a.txt", 4, "0", true), body("data"));
	assert.throws(() => parseTar(bad), TarError);
	assert.throws(() => parseTar(bad), /checksum mismatch/);
});

test("path traversal is refused", () => {
	assert.throws(() => assertSafeMemberPath("mnt/us/../../etc/passwd"), /path traversal/);
	assert.throws(() => assertSafeMemberPath("/etc/passwd"), /absolute member path/);
	assert.throws(() => assertSafeMemberPath(""), /empty member name/);

	const evil = archive(header("mnt/us/documents/../../../etc/passwd", 4, "0"), body("data"));
	assert.throws(() => parseTar(evil), /path traversal/);
});

test("links, device nodes and unknown typeflags are refused, not guessed at", () => {
	for (const flag of ["1", "2", "3", "4", "6", "x", "g"]) {
		assert.throws(
			() => parseTar(archive(header("mnt/us/documents/a", 0, flag))),
			/unsupported member type/,
			`typeflag '${flag}' was accepted`
		);
	}
});

test("a duplicate member is refused rather than silently overwriting", () => {
	const dup = archive(
		header("mnt/us/documents/a.txt", 4, "0"),
		body("aaaa"),
		header("mnt/us/documents/a.txt", 4, "0"),
		body("bbbb")
	);
	assert.throws(() => parseTar(dup), /duplicate member/);
});

test("a truncated archive fails rather than yielding a partial pull", () => {
	const full = archive(header("mnt/us/documents/a.txt", 4, "0"), body("data"));
	// Cut off the end-of-archive marker.
	assert.throws(() => parseTar(full.subarray(0, full.length - BLOCK_SIZE * 2)), TarError);
	// Cut mid-content.
	assert.throws(() => parseTar(full.subarray(0, BLOCK_SIZE + 4)), TarError);
});

test("a non-octal size field is refused", () => {
	const b = Buffer.from(header("mnt/us/documents/a.txt", 4, "0"));
	b.write("99XX9999999\0", 124, 12, "ascii");
	assert.throws(() => parseTar(archive(new Uint8Array(b), body("data"))), /not octal|checksum/);
});

 test("tar bounds member bytes before buffering the body", () => {
 const parser = new TarParser(() => {}, { maxMemberBytes: 8 });
 assert.throws(() => parser.write(header("large", 9, "0")), /member.*limit/i);
 });
 test("tar bounds entries including GNU pseudo entries", () => {
 const parser = new TarParser(() => {}, { maxEntries: 1 });
 assert.throws(() => parser.write(archive(header("long", 1, "L"), body("a"), header("a", 0, "0"))), /entry.*limit/i);
 });
 test("tar bounds all archive bytes including EOF padding", () => {
 const parser = new TarParser(() => {}, { maxArchiveBytes: 1024 });
 parser.write(new Uint8Array(1024));
 assert.throws(() => parser.write(new Uint8Array(1)), /archive.*limit/i);
 });
 test("fragmented bodies and GNU long names survive byte-sized chunks", () => {
 const entries: any[] = [];
 const parser = new TarParser(e => entries.push(e));
 const name = "a/" + "b".repeat(120);
 const bytes = archive(header("long", name.length + 1, "L"), body(name + "\0"), header("short", 1500, "0"), body("z".repeat(1500)));
 for (const b of bytes) parser.write(Uint8Array.of(b));
 parser.end();
 assert.equal(entries[0].name, name);
 assert.equal(Buffer.from(entries[0].data).toString(), "z".repeat(1500));
 });
