import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { buildLibrary, cachePaths, loadArchive, sdrDirFor } from "../src/decode/build";
import { validateLibraryData } from "../src/library";
import { VocabWord } from "../src/decode/vocab-db";

test("id-less words and lookups remain stable across device snapshots", () => temporary(root => {
	const db = new DatabaseSync(path.join(root, "cc.db"));
	db.exec(`CREATE TABLE Entries (p_type TEXT, p_uuid TEXT, p_cdeKey TEXT, p_titles_0_nominal TEXT); INSERT INTO Entries VALUES ('Entry:Item','u','asin','Book');`);
	db.close();
	const vocab = new DatabaseSync(path.join(root, "vocab.db"));
	vocab.exec(`CREATE TABLE BOOK_INFO (id TEXT, asin TEXT, title TEXT); INSERT INTO BOOK_INFO VALUES ('b','asin','Book'); CREATE TABLE WORDS (id TEXT, word TEXT, category INTEGER, timestamp INTEGER); INSERT INTO WORDS VALUES (NULL,'anonymous',0,1), ('w','word',0,2); CREATE TABLE LOOKUPS (id TEXT, word_key TEXT, book_key TEXT, usage TEXT, timestamp INTEGER); INSERT INTO LOOKUPS VALUES (NULL,NULL,'b','anonymous lookup',1), ('edit','w','b','old',2);`);
	for (let i = 0;i < 3;i++) {
		const result = buildLibrary(root).library;
		assert.equal(result.vocabulary?.words.length, 2);
		const word = result.vocabulary?.words.find((w: VocabWord) => w.id === "w");
		assert.equal(word?.lookups.length, 1);
		assert.equal(word?.lookups[0].usage, i === 0 ? "old" : "updated");
		assert.equal(word?.status, i === 0 ? "learning" : "mastered");
		assert.equal(result.books[0].vocabulary?.length, 2);
		assert.equal(result.books[0].vocabulary?.[1].usage, i === 0 ? "old" : "updated");
		fs.writeFileSync(path.join(root, "archive.json"), JSON.stringify(result));
		vocab.exec(`UPDATE LOOKUPS SET usage = 'updated' WHERE id = 'edit'; UPDATE WORDS SET category = 100 WHERE id = 'w'`);
	}
	vocab.close();
}));

test("pending cache promotion blocks decoding before database access", () => temporary(root => {
	fs.writeFileSync(path.join(root, ".pending-promotion.json"), "{}");
	assert.throws(() => buildLibrary(root), /pending promotion/);
}));

test("partial reader snapshots union annotations and reject escaped sidecar files", () => temporary(root => {
	const db = new DatabaseSync(path.join(root, "cc.db"));
	db.exec(`CREATE TABLE Entries (p_type TEXT, p_uuid TEXT, p_titles_0_nominal TEXT, p_location TEXT); INSERT INTO Entries VALUES ('Entry:Item','u','Book','/mnt/us/documents/book.azw3');`);
	db.close();
	const sdr = path.join(root, "documents", "book.sdr"); fs.mkdirSync(sdr, { recursive: true });
	fs.writeFileSync(path.join(sdr, "book.azw3r"), "reader");
	const annotation = (position: string, note: string, modified: string) => ({ type: "note", startPosition: position, endPosition: position, creationTime: "created", lastModificationTime: modified, note });
	let annotations = [annotation("1", "old", "1"), annotation("2", "retained", "1")];
	const int = (v: number) => { const b = Buffer.alloc(5); b[0] = 1; b.writeInt32BE(v, 1); return b; };
	const utf = (v: string) => { const bytes = Buffer.from(v); const b = Buffer.alloc(4); b[0] = 3; b.writeUInt16BE(bytes.length, 2); return Buffer.concat([b, bytes]); };
	const long = (v: number) => { const b = Buffer.alloc(9); b[0] = 2; b.writeBigInt64BE(BigInt(v), 1); return b; };
	const obj = (name: string, values: Buffer[]) => Buffer.concat([Buffer.from([254]), utf(name).subarray(1), ...values, Buffer.from([255])]);
	const saveReader = () => fs.writeFileSync(path.join(sdr, "book.azw3r"), Buffer.concat([
		Buffer.from([0, 0, 0, 0, 0, 26, 177, 38]), int(1), int(1),
		obj("annotation.cache.object", [int(1), int(2), obj("saved.avl.interval.tree", [int(annotations.length), ...annotations.map(a => obj("annotation.personal.note", [utf(a.startPosition), utf(a.endPosition), long(1000), long(Number(a.lastModificationTime) * 1000), utf(""), utf(a.note)]))])])
	]));
	saveReader();
	{
		let result = buildLibrary(root).library;
		fs.writeFileSync(path.join(root, "archive.json"), JSON.stringify(result));
		annotations = [annotation("1", "edited", "2"), annotation("3", "new", "1")];
		saveReader();
		result = buildLibrary(root).library;
		assert.deepEqual(result.books[0].annotations?.map(a => a.note), ["edited", "retained", "new"]);
		fs.writeFileSync(path.join(root, "archive.json"), JSON.stringify(result));
		for (let i = 0; i < 3; i++) {
			const repeated = buildLibrary(root).library;
			assert.deepEqual(repeated.books[0].annotations, result.books[0].annotations);
			fs.writeFileSync(path.join(root, "archive.json"), JSON.stringify(repeated));
		}
	}
}));

function temporary(run: (root: string) => void) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "decoder-boundary-"));
	try { run(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

for (const field of ["guid", "cdeKey"] as const) {
	test(`an exact UUID match does not discard another source with the current ${field}`, () => temporary(root => {
		const db = new DatabaseSync(path.join(root, "cc.db"));
		try {
			db.exec(`CREATE TABLE Entries (p_type TEXT, p_uuid TEXT, p_titles_0_nominal TEXT, p_${field} TEXT)`);
			db.prepare(`INSERT INTO Entries VALUES ('Entry:Item', 'a', 'A', ?)`).run("shared-key");
		} finally { db.close(); }
		const annotations = [{ type: "note", startPosition: "1", note: "B's retained history" }];
		const archive = path.join(root, "archive.json");
		fs.writeFileSync(archive, JSON.stringify({ books: [
			{ uuid: "a", title: "A" },
			{ uuid: "b", title: "B", [field]: "shared-key", annotations },
		] }));
		for (let i = 0; i < 2; i++) {
			const result = buildLibrary(root).library;
			assert.deepEqual(result.books.map(b => b.uuid), ["a", "b"]);
			assert.deepEqual(result.books[0].annotations, []);
			assert.deepEqual(result.books[1].annotations, annotations);
			assert.equal(result.books[1].on_device, false);
			fs.writeFileSync(archive, JSON.stringify(result));
		}
	}));
}

test("archive: only missing file is first run; corrupt/read/schema errors abort", () => temporary(root => {
	const file = path.join(root, "archive.json");
	assert.deepEqual(loadArchive(file).books, []);
	for (const value of ["{", "{}", "{\"books\":[null]}", "{\"books\":[],\"groups\":{}}", "{\"books\":[],\"vocabulary\":{\"words\":[null]}}"]) {
		fs.writeFileSync(file, value);
		assert.throws(() => loadArchive(file));
	}
	fs.unlinkSync(file);
	fs.symlinkSync(path.join(root, "missing"), file);
	assert.throws(() => loadArchive(file));
	fs.unlinkSync(file); fs.mkdirSync(file);
	assert.throws(() => loadArchive(file));
}));
test("archive rejects duplicate UUIDs and dangling group sources", () => temporary(root => {
	const file = path.join(root, "archive.json");
	const book = { uuid: "u", title: "Book" };
	fs.writeFileSync(file, JSON.stringify({ books: [book, book] }));
	assert.throws(() => loadArchive(file), /Duplicate kindle_uuid/);
	fs.writeFileSync(file, JSON.stringify({ books: [book], groups: [{ key: "g", cdeKey: "asin", language: "en", primaryUuid: "u", sourceUuids: ["u", "missing"] }] }));
	assert.throws(() => loadArchive(file), /sourceUuids/);
}));
test("opaque firmware timestamps and unknown statistics survive validation", () => {
	const data = { books: [{ uuid: "u", title: "B", annotations: [{ type: "note", creationTime: 123, lastModificationTime: { raw: 456 }, note: "N" }], azw3r: { sync_lpr: true, lpr: { position: "1", timeZoneOffset: 60 } } }], vocabulary: { stats: { firmware: { version: 1 } }, words: [] } };
	assert.doesNotThrow(() => validateLibraryData(data));
});
test("library rejects malformed renderer values without coercion", () => {
	for (const fields of [{ title: 42 }, { stats: { minutes: "1" } }, { clippings: [{ title: "B", type: "note", text: {} }] }, { annotations: [null] }, { vocabulary: [null] }]) {
		assert.throws(() => validateLibraryData({ books: [{ uuid: "u", title: "B", ...fields }] }));
	}
});
test("sidecar directories come only from locations under documents", () => temporary(root => {
	fs.mkdirSync(path.join(root, "documents"));
	fs.mkdirSync(path.join(root, "outside.sdr"));
	const cache = cachePaths(root);
	for (const loc of ["/mnt/us/outside.azw3", "/mnt/us/documents/../outside.azw3"]) assert.equal(sdrDirFor(cache, loc), undefined);
	fs.mkdirSync(path.join(root, "documents", "ok.sdr"));
	assert.equal(sdrDirFor(cache, "/mnt/us/documents/ok.azw3"), path.join(root, "documents", "ok.sdr"));
}));
for (const resident of [true, false]) test(`successive builds preserve pruned book lookups and word layer (resident=${resident})`, () => temporary(root => {
	const db = new DatabaseSync(path.join(root, "cc.db"));
	db.exec(`CREATE TABLE Entries (p_type TEXT, p_uuid TEXT, p_cdeKey TEXT, p_titles_0_nominal TEXT); INSERT INTO Entries VALUES ('Entry:Item', 'u', 'asin', 'Book');`);
	if (!resident) db.exec("DELETE FROM Entries");
	const lookup = (id: string) => ({ id, word_key: "w", usage: id });
	const old = { books: [{ uuid: "u", title: "Book", cdeKey: "asin", vocabulary: [lookup("old")], annotations: [{ type: "highlight", startPosition: "1", creationTime: "t", text: "raw" }] }], vocabulary: { stats: {}, words: [{ id: "w", word: "word", stem: "word", status: "learning", category: 0, lookups: [lookup("old")] }] } };
	fs.writeFileSync(path.join(root, "archive.json"), JSON.stringify(old));
	const vocab = new DatabaseSync(path.join(root, "vocab.db"));
	vocab.exec(`CREATE TABLE BOOK_INFO (id TEXT, asin TEXT, title TEXT); INSERT INTO BOOK_INFO VALUES ('b','asin','Book'); CREATE TABLE WORDS (id TEXT, word TEXT, category INTEGER, timestamp INTEGER); INSERT INTO WORDS VALUES ('w','word',0,1); CREATE TABLE LOOKUPS (id TEXT, word_key TEXT, book_key TEXT, usage TEXT, timestamp INTEGER); INSERT INTO LOOKUPS VALUES ('new','w','b','new',1);`);
	vocab.close();
	for (let i = 0;i < 3;i++) {
		const result = buildLibrary(root).library;
		assert.deepEqual(result.books[0].vocabulary?.map(v => v.id), ["old", "new"]);
		assert.equal(result.vocabulary?.words[0].lookups.length, 2);
		assert.equal(result.books[0].annotations?.[0].text, "raw");
		fs.writeFileSync(path.join(root, "archive.json"), JSON.stringify(result));
		if (i === 0) { db.exec("DELETE FROM Entries"); fs.unlinkSync(path.join(root, "vocab.db")); }
	}
	db.close();
}));
test("clippings with symbol-only titles still get a book of their own", () => temporary(root => {
	const db = new DatabaseSync(path.join(root, "cc.db"));
	db.exec(`CREATE TABLE Entries (p_type TEXT, p_uuid TEXT, p_titles_0_nominal TEXT); INSERT INTO Entries VALUES ('Entry:Item','u','Book');`);
	db.close();
	fs.mkdirSync(path.join(root, "documents"));
	const clip = (title: string, text: string) => `${title}\n- Your Highlight on Location 1 | Added on Monday, 1 January 2024 00:00:00\n\n${text}\n==========\n`;
	fs.writeFileSync(path.join(root, "documents", "My Clippings.txt"), clip("★ (A)", "star") + clip("../x", "slash") + clip("★ (A)", "again") + clip("(A)", "empty") + clip("Book", "matched"));
	for (let i = 0; i < 2; i++) {
		const books = buildLibrary(root).library.books;
		const byText = (text: string) => books.filter(b => b.clippings?.some(c => c.text === text));
		for (const text of ["star", "again", "slash", "empty", "matched"]) assert.equal(byText(text).length, 1, text);
		assert.equal(byText("star")[0], byText("again")[0]);
		assert.equal(byText("matched")[0].uuid, "u");
		for (const text of ["star", "slash", "empty"]) assert.match(byText(text)[0].uuid, /^synthetic-[a-z0-9]+$/);
		assert.equal(books.length, 4);
		fs.writeFileSync(path.join(root, "archive.json"), JSON.stringify({ books }));
	}
}));
for (const resident of [true, false]) test(`archived fields and clippings survive a partial device view (resident=${resident})`, () => temporary(root => {
	const db = new DatabaseSync(path.join(root, "cc.db"));
	db.exec(`CREATE TABLE Entries (p_type TEXT, p_uuid TEXT, p_cdeKey TEXT, p_titles_0_nominal TEXT, p_publisher TEXT); INSERT INTO Entries VALUES ('Entry:Item','u','asin','Book',NULL);`);
	if (!resident) db.exec("DELETE FROM Entries");
	db.close();
	const clip = (text: string) => ({ title: "Book", author: "", type: "highlight", page: null, location: "1", added_at: "Monday, 1 January 2024 00:00:00", text });
	fs.writeFileSync(path.join(root, "archive.json"), JSON.stringify({ books: [{ uuid: "u", title: "Book", cdeKey: "asin", publisher: "Old", firmware_extra: "keep", clippings: [clip("A"), clip("B")] }] }));
	fs.mkdirSync(path.join(root, "documents"));
	fs.writeFileSync(path.join(root, "documents", "My Clippings.txt"), `Book\n- Your Highlight on Location 1 | Added on Monday, 1 January 2024 00:00:00\n\nA\n==========\n`);
	for (let i = 0; i < 2; i++) {
		const [book] = buildLibrary(root).library.books;
		assert.equal((book as any).firmware_extra, "keep");
		assert.deepEqual(book.clippings?.map(c => c.text), ["A", "B"]);
		// Current device facts win, including an absent value.
		assert.equal(book.publisher, resident ? null : "Old");
		fs.writeFileSync(path.join(root, "archive.json"), JSON.stringify({ books: [book] }));
	}
}));
