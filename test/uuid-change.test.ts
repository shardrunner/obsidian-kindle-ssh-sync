import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildLibrary } from "../src/decode/build";
import { groupForPresentation } from "../src/decode/archive";
import { DEFAULT_SETTINGS } from "../src/types";
import { MockVaultApp, syncVault } from "./mock-vault";

function writeCatalogue(root: string, uuid: string, language: string | null) {
	fs.rmSync(path.join(root, "cc.db"), { force: true });
	const db = new DatabaseSync(path.join(root, "cc.db"));
	try {
		db.exec(`CREATE TABLE Entries (p_type TEXT, p_uuid TEXT, p_cdeKey TEXT, p_guid TEXT, p_titles_0_nominal TEXT, p_credits_0_name_collation TEXT, p_languages_0 TEXT, p_readState INTEGER);`);
		db.prepare("INSERT INTO Entries VALUES ('Entry:Item', ?, 'B00KEY', 'guid-1', 'Kept Book', 'Author, Ann', ?, 2)").run(uuid, language);
	} finally { db.close(); }
}

async function sync(root: string, app: MockVaultApp) {
	const built = buildLibrary(root);
	const grouped = groupForPresentation(built.library.books, built.archiveGroups);
	const archive = JSON.stringify({ books: built.library.books, groups: grouped.groups, vocabulary: built.library.vocabulary });
	const settings = { ...DEFAULT_SETTINGS, cachePath: root, targetFolder: "Books", copyCovers: false };
	return syncVault(app as any, { ...built.library, books: grouped.books }, settings, undefined, archive);
}

for (const language of ["en", null]) {
	test(`a catalogue uuid change keeps the existing note (language ${language})`, async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "kindle-uuid-change-"));
		try {
			const app = new MockVaultApp(path.join(root, "vault"));
			writeCatalogue(root, "uuid-old", language);
			assert.equal((await sync(root, app)).created, 1);

			// The same book, matched by guid/cdeKey, now carries a new catalogue uuid.
			writeCatalogue(root, "uuid-new", language);
			const stats = await sync(root, app);

			const notes = [...app.fileContents.keys()].filter((p) => p.startsWith("Books/"));
			assert.deepEqual(notes, ["Books/Ann Author--Kept Book.md"]);
			assert.equal(stats.created, 0);
			assert.equal(stats.orphaned, 0);
			assert.match(app.fileContents.get(notes[0])!, /kindle_uuid: "uuid-old"/);
			const archived = JSON.parse(fs.readFileSync(path.join(root, "archive.json"), "utf8")).books;
			assert.deepEqual(archived.map((b: any) => [b.uuid, b.catalogueUuid]), [["uuid-old", "uuid-new"]]);

			// The catalogue uuid now matches directly, so the record stays put.
			assert.equal((await sync(root, app)).unchanged, 1);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
}
