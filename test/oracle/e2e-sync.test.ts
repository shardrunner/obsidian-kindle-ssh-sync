import { MockVaultApp, syncVault } from "../mock-vault";
import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import * as os from "node:os";



import { isActiveBook } from "../../src/book-note";

import { KindleSyncSettings, LibraryJson } from "../../src/types";
import { golden } from "./golden";


test("end-to-end sync against mock vault with the golden real library", async () => {

	const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "kindle-sync-test-"));
	try {
		const app = new MockVaultApp(tempDir) as any;
		const library: LibraryJson = golden();

		const settings: KindleSyncSettings = {
			cachePath: path.join(__dirname, "../fixtures", "cache"),
			targetFolder: "Kindle-Sync",
			inactiveSubfolder: "inactive",
			assetsSubfolder: "assets",
			baseEmbed: "Kindle.base#Detail",
			copyCovers: true,
			kindleHost: "",
			kindleUser: "",
			kindlePassword: "",
			kindleHostFingerprint: "",
			syncTimeoutSeconds: 600,
		};

		// 1. First sync run
		const stats1 = await syncVault(app, library, settings);
		assert.equal(stats1.total, 690);
		assert.equal(stats1.created, 690);
		assert.equal(stats1.updated, 0);
		assert.equal(stats1.unchanged, 0);

		// Check files created in vault
		const activeFiles = fs.readdirSync(path.join(tempDir, "Kindle-Sync")).filter((f) => f.endsWith(".md"));
		const inactiveFiles = fs.readdirSync(path.join(tempDir, "Kindle-Sync", "inactive")).filter((f) => f.endsWith(".md"));

		const expectedActive = library.books.filter(isActiveBook).length;
		const expectedInactive = library.books.filter((b) => !isActiveBook(b)).length;

		assert.equal(activeFiles.length, expectedActive);
		assert.equal(inactiveFiles.length, expectedInactive);

		// Verify kindle_amazon_archived and kindle_on_device values in created notes
		const cloudBook = library.books.find((b) => b.isArchived === 1);
		assert.ok(cloudBook);
		const cloudFile = app.vault.getMarkdownFiles().find((f: any) => {
			const fm = app.metadataCache.getFileCache(f)?.frontmatter;
			return fm?.kindle_uuid === cloudBook.uuid;
		});
		assert.ok(cloudFile);
		const cloudFm = app.metadataCache.getFileCache(cloudFile)?.frontmatter;
		assert.equal(cloudFm?.kindle_amazon_archived, true);
		assert.equal(cloudFm?.kindle_on_device, true);
		assert.equal(cloudFm?.kindle_archived, undefined);
		assert.equal(cloudFm?.amazon_archived, undefined);

		const localBook = library.books.find((b) => b.isArchived === 0);
		assert.ok(localBook);
		const localFile = app.vault.getMarkdownFiles().find((f: any) => {
			const fm = app.metadataCache.getFileCache(f)?.frontmatter;
			return fm?.kindle_uuid === localBook.uuid;
		});
		assert.ok(localFile);
		const localFm = app.metadataCache.getFileCache(localFile)?.frontmatter;
		assert.equal(localFm?.kindle_amazon_archived, false);
		assert.equal(localFm?.kindle_on_device, true);
		assert.equal(localFm?.kindle_archived, undefined);
		assert.equal(localFm?.amazon_archived, undefined);

		// 2. Second sync run (no changes) -> skip-if-identical
		const stats2 = await syncVault(app, library, settings);
		assert.equal(stats2.created, 0);
		assert.equal(stats2.updated, 0);
		assert.equal(stats2.unchanged, 690);

		// 3. Test active move: make an inactive book active
		const testInactive = library.books.find((b) => !isActiveBook(b));
		assert.ok(testInactive);
		testInactive.read_status = "read";

		const stats3 = await syncVault(app, library, settings);
		assert.equal(stats3.moved, 1);
		assert.equal(stats3.updated, 1);
		assert.equal(stats3.unchanged, 689);

		// 4. Test orphan stamping: remove a reading book from library
		const readingBook = library.books.find((b) => b.read_status === "reading" && b.percentFinished && b.percentFinished < 90);
		assert.ok(readingBook);
		const removedBookUuid = readingBook.uuid;
		const truncatedLib: LibraryJson = {
			...library,
			books: library.books.filter((b) => b.uuid !== removedBookUuid),
		};

		const stats4 = await syncVault(app, truncatedLib, settings);
		assert.equal(stats4.orphaned, 1);

		// Verify orphan frontmatter has kindle_on_device: false and kindle_read_status: "abandoned"
		const orphanFile = app.vault.getMarkdownFiles().find((f: any) => {
			const fm = app.metadataCache.getFileCache(f)?.frontmatter;
			return fm?.kindle_uuid === removedBookUuid;
		});
		assert.ok(orphanFile);
		const orphanFm = app.metadataCache.getFileCache(orphanFile)?.frontmatter;
		assert.equal(orphanFm?.kindle_on_device, false);
		assert.equal(orphanFm?.kindle_read_status, "abandoned");
	} finally {
		fs.rmSync(tempDir, { recursive: true, force: true });
	}
});
