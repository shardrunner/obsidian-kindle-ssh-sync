import { MockVaultApp, syncVault } from "./mock-vault";
import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import * as os from "node:os";



import { isActiveBook } from "../src/book-note";

import { KindleSyncSettings, LibraryJson } from "../src/types";


test("two books swapping filenames keep their own notes", async () => {
	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kindle-sync-swap-"));
	try {
		const app = new MockVaultApp(tempDir) as any;

		const settings: KindleSyncSettings = {
			cachePath: path.join(tempDir, "cache"),
			targetFolder: "Kindle-Sync",
			inactiveSubfolder: "",
			assetsSubfolder: "assets",
			baseEmbed: "Kindle.base#Detail",
			copyCovers: false,
			kindleHost: "",
			kindleUser: "",
			kindlePassword: "",
			kindleHostFingerprint: "",
			syncTimeoutSeconds: 600,
		};

		const note = (uuid: string, title: string) =>
			`---\nmeta_generator: kindle_sync\nkindle_uuid: ${uuid}\nkindle_title: ${title}\n---\n\n![[Kindle.base#Detail]]\n`;

		// Previous run: uuid-a is "Alpha", uuid-b is "Beta".
		await app.vault.create("Kindle-Sync/Auth--Alpha.md", note("uuid-a", "Alpha"));
		await app.vault.create("Kindle-Sync/Auth--Beta.md", note("uuid-b", "Beta"));

		// This run: upstream corrected the titles, swapping the two filenames.
		const library: LibraryJson = {
			books: [
				{ uuid: "uuid-a", title: "Beta", author: "Auth", read_status: "read" },
				{ uuid: "uuid-b", title: "Alpha", author: "Auth", read_status: "read" },
			],
		};

		const stats = await syncVault(app, library, settings);

		const alpha = app.fileContents.get("Kindle-Sync/Auth--Alpha.md");
		const beta = app.fileContents.get("Kindle-Sync/Auth--Beta.md");
		assert.ok(alpha, "Auth--Alpha.md must still exist");
		assert.ok(beta, "Auth--Beta.md must still exist");
		assert.ok(alpha.includes('kindle_uuid: "uuid-b"'), "Alpha.md now belongs to uuid-b");
		assert.ok(beta.includes('kindle_uuid: "uuid-a"'), "Beta.md now belongs to uuid-a");
		assert.equal(stats.renamed, 2);
		assert.equal(stats.created, 0);
		assert.equal(stats.warnings.length, 0);

		// No temp files left behind
		const strays = (Array.from(app.files.keys()) as string[]).filter((p) =>
			p.includes("__kindle-sync-move-")
		);
		assert.deepEqual(strays, []);
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
