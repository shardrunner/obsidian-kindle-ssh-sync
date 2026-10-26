import type { App, TFile } from "obsidian";
import { VaultTransaction, vaultContentHash, vaultOwnedIdentity, type VaultOperation } from "./vault-transaction";
import * as fs from "node:fs";
import * as path from "node:path";
import { BookFrontmatter, KindleSyncSettings, LibraryJson, RawBook, SyncStats } from "./types";
import { resolveCachePath } from "./device/cache";
import { buildBookFrontmatter, generateFilenames, isActiveBook } from "./book-note";
import { renderBookNote, renderFrontmatterYaml } from "./note-render";

import { normalizeVaultPath } from "./vault-path";

export function validateVaultSettings(settings: KindleSyncSettings): void {
	for (const key of ["targetFolder", "inactiveSubfolder", "assetsSubfolder"] as const) {
		normalizeVaultPath(settings[key]);
	}
	if (!settings.targetFolder.trim()) throw new Error("Target folder is not configured.");
}

/** Queue cover writes on the journal; returns how many were queued. */
async function queueBookCovers(
	app: App,
	books: RawBook[],
	settings: KindleSyncSettings,
	warnings: string[],
	transaction: VaultTransaction
): Promise<number> {
	if (!settings.copyCovers) return 0;

	const thumbDir = path.join(resolveCachePath(settings), "thumbnails");
	if (!fs.existsSync(thumbDir)) {
		warnings.push(`Cover cache not found at ${thumbDir}; no covers copied.`);
		return 0;
	}

	const assetsVaultDir = normalizeVaultPath(
		`${settings.targetFolder}/${settings.assetsSubfolder}`
	);
	// Binary covers have no ownership marker. Reuse identical bytes; differing
	// files in the configured output folder are replaced with a warning.
	const queued = new Set<string>();
	for (const book of books) {
		if (!book.thumbnail || typeof book.thumbnail !== "string") continue;
		const filename = path.basename(book.thumbnail);
		const srcPath = path.join(thumbDir, filename);
		if (!fs.existsSync(srcPath)) continue;
		const destination = normalizeVaultPath(`${assetsVaultDir}/${filename}`);
		if (queued.has(destination)) continue;
		const data = await fs.promises.readFile(srcPath);
		const stat = await app.vault.adapter.stat(destination);
		const content = data.toString("base64");
		if (stat) {
			if (stat.type !== "file") throw new Error(`Refusing occupied cover destination: ${destination}`);
			const before = Buffer.from(await app.vault.adapter.readBinary(destination));
			if (data.equals(before)) continue;
			// Treat the cover folder as generated output, not a place for custom images.
			warnings.push(`Overwriting changed cover: ${destination}`);
			transaction.operations.push({ kind: "write", path: destination, content, binary: true, beforeHash: vaultContentHash(before) });
		} else {
			transaction.operations.push({ kind: "write", path: destination, content, binary: true, create: true });
		}
		queued.add(destination);
	}
	return queued.size;
}

interface BookPlan {
	book: RawBook;
	expectedPath: string;
	existingFile?: TFile;
	/** Path the note occupied before this run, for move/rename accounting. */
	originalPath?: string;
}

/**
 * Plan and publish one batch. The caller has validated settings, holds the
 * global sync lock, and has already recovered `transaction`.
 */
export async function syncLibraryToVault(
	app: App,
	library: LibraryJson,
	settings: KindleSyncSettings,
	transaction: VaultTransaction,
	/** Use the host's YAML parser for current note bytes, independently of metadata refresh. */
	parseYaml: (yaml: string) => unknown,
	/** Serialized source archive (including stable groups), published last by the journal. */
	archive?: string
): Promise<SyncStats> {
	const stats: SyncStats = {
		created: 0,
		updated: 0,
		renamed: 0,
		moved: 0,
		unchanged: 0,
		orphaned: 0,
		total: library.books.length,
		highlightsRetained: 0,
		coversCopied: 0,
		warnings: [],
	};

	const targetFolder = normalizeVaultPath(settings.targetFolder);
	/** Every mover parks here first, so books can exchange filenames. */
	const parkingPath = (uuid: string) => normalizeVaultPath(`${targetFolder}/__kindle-sync-move-${uuid}.md`);
	const inactiveFolder = settings.inactiveSubfolder.trim()
		? normalizeVaultPath(`${targetFolder}/${settings.inactiveSubfolder.trim()}`)
		: "";

	// 2. Scan existing plugin-owned notes in the target and inactive folders
	const existingByUuid = new Map<string, TFile>();

	for (const file of app.vault.getMarkdownFiles()) {
		const filePath = normalizeVaultPath(file.path);
		const isInTarget =
			filePath.startsWith(`${targetFolder}/`) ||
			(inactiveFolder ? filePath.startsWith(`${inactiveFolder}/`) : false);

		if (!isInTarget) continue;

		const fm = app.metadataCache.getFileCache(file)?.frontmatter;

		// Orphan guard: must have meta_generator: kindle_sync and non-empty kindle_uuid
		if (fm && fm.meta_generator === "kindle_sync" && fm.kindle_uuid) {
			if (existingByUuid.has(String(fm.kindle_uuid))) throw new Error(`Duplicate owned UUID: ${fm.kindle_uuid}`);
			existingByUuid.set(String(fm.kindle_uuid), file);
		}
	}

	// 3. Plan every destination before touching the vault
	const filenames = generateFilenames(library.books);
	const currentUuids = new Set<string>();
	const plans: BookPlan[] = [];

	for (const book of library.books) {
		currentUuids.add(book.uuid);
		const filename = filenames.get(book.uuid)!;

		const isActive = isActiveBook(book);
		const destDir = isActive || !inactiveFolder ? targetFolder : inactiveFolder;
		const existing = existingByUuid.get(book.uuid);

		plans.push({
			book,
			expectedPath: normalizeVaultPath(`${destDir}/${filename}`),
			existingFile: existing,
			originalPath: existing ? normalizeVaultPath(existing.path) : undefined,
		});
	}

	// 4. Plan moves. Every mover goes via a temp name first, so books can
	//    exchange filenames without colliding. Execution follows existing-note
	//    writes, preserving FileManager's backlink updates.
	const movers = plans.filter(
		(p) => p.existingFile && p.originalPath !== p.expectedPath
	);

	// Preflight the entire note batch before folders, covers, renames or writes.
	const contents = new Map<TFile, { content: string; frontmatter: Partial<BookFrontmatter> }>();
	for (const [uuid, file] of existingByUuid) {
		const content = await app.vault.read(file);
		if (vaultOwnedIdentity(content) !== uuid) throw new Error(`Note ownership changed at ${file.path}; wait for metadata refresh and review before retrying.`);
		// Preservation and overwrite preconditions must describe the same bytes.
		try {
			const frontmatter = parseYaml(content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)![1]);
			if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) throw new Error("Expected a YAML mapping");
			contents.set(file, { content, frontmatter });
		} catch (error) {
			throw new Error(`Invalid frontmatter at ${file.path}: ${error instanceof Error ? error.message : error}`);
		}
	}
	const reserved = new Set<string>();
	const reservedParents = new Set<string>();
	const checkParents = (p: string) => {
		const parts = p.split("/");
		for (let i = 1; i < parts.length; i++) {
			const parent = parts.slice(0, i).join("/");
			if (app.vault.getAbstractFileByPath(parent) && !app.vault.getFolderByPath(parent)) throw new Error(`File blocks folder: ${parent}`);
		}
	};
	const reserve = (p: string) => {
		if (reserved.has(p)) throw new Error(`Duplicate output path: ${p}`);
		if (reservedParents.has(p)) throw new Error(`Output file blocks another output: ${p}`);
		const parts = p.split("/");
		for (let i = 1; i < parts.length; i++) {
			const parent = parts.slice(0, i).join("/");
			if (reserved.has(parent)) throw new Error(`Output file blocks another output: ${p}`);
			reservedParents.add(parent);
		}
		reserved.add(p);
		checkParents(p);
	};
	for (const plan of plans) {
		reserve(plan.expectedPath);
		const occupant = app.vault.getAbstractFileByPath(plan.expectedPath);
		if (occupant && occupant !== plan.existingFile && !movers.some(m => m.existingFile === occupant)) throw new Error(`Refusing occupied destination: ${plan.expectedPath}`);
	}
	for (const plan of movers) {
		const temp = parkingPath(plan.book.uuid);
		reserve(temp);
		const occupant = app.vault.getAbstractFileByPath(temp);
		if (occupant && occupant !== plan.existingFile) throw new Error(`Refusing occupied temporary path: ${temp}`);
	}
	for (const dir of [targetFolder, inactiveFolder, `${targetFolder}/${settings.assetsSubfolder}`]) {
		if (!dir) continue;
		const normalized = normalizeVaultPath(dir);
		for (const output of reserved) {
			if (normalized === output || normalized.startsWith(`${output}/`)) throw new Error(`Output file blocks configured folder: ${output}`);
		}
		checkParents(`${normalized}/placeholder`);
	}
	stats.coversCopied = await queueBookCovers(app, library.books, settings, stats.warnings, transaction);

	// Existing notes must be written at their original paths BEFORE any rename:
	// FileManager's link updates must be the last changes to their contents.
	// New notes wait until movers have vacated any reused destinations.
	const moves: VaultOperation[] = [];
	const creations: VaultOperation[] = [];
	for (const plan of movers) {
		const tempPath = parkingPath(plan.book.uuid);
		// A note parked by a crashed run is already there; renaming onto itself throws.
		if (normalizeVaultPath(plan.existingFile!.path) !== tempPath) {
			moves.push({ kind: "move", from: plan.originalPath!, path: tempPath, uuid: plan.book.uuid });
		}
	}
	for (const plan of movers) {
		moves.push({ kind: "move", from: parkingPath(plan.book.uuid), path: plan.expectedPath, uuid: plan.book.uuid });

		const oldDir = plan.originalPath!.split("/").slice(0, -1).join("/");
		const newDir = plan.expectedPath.split("/").slice(0, -1).join("/");
		if (oldDir !== newDir) {
			stats.moved++;
		} else {
			stats.renamed++;
		}
	}

	// 5. Write content
	for (const plan of plans) {
		const { book, existingFile } = plan;

		const existing = existingFile ? contents.get(existingFile) : undefined;
		const existingContent = existing?.content;

		const frontmatter = buildBookFrontmatter(book, {
			targetFolder,
			assetsSubfolder: settings.assetsSubfolder,
			copyCovers: settings.copyCovers,
			existingFrontmatter: existing?.frontmatter,
		});

		const rendered = renderBookNote(frontmatter, {
			clippings: book.clippings || [],
			existingMarkdown: existingContent,
			baseEmbed: settings.baseEmbed,
		});
		stats.highlightsRetained += rendered.retainedHighlights;

		if (existingFile) {
			if (existingContent !== rendered.content) {
				transaction.operations.push({ kind: "write", path: plan.originalPath!, content: rendered.content, beforeHash: vaultContentHash(existingContent!) });
				stats.updated++;
			} else {
				stats.unchanged++;
			}
			continue;
		}

		creations.push({ kind: "write", path: plan.expectedPath, content: rendered.content, create: true });
		stats.created++;
	}

	// 6. Handle orphans (books removed from device)
	for (const [uuid, file] of existingByUuid) {
		if (currentUuids.has(uuid)) continue;
		const { content: before, frontmatter } = contents.get(file)!;
		if (frontmatter.kindle_on_device === false) continue;

		const fm = { ...frontmatter, kindle_on_device: false } as BookFrontmatter;
		if (fm.kindle_read_status === "reading" && !fm.kindle_finished) fm.kindle_read_status = "abandoned";
		if (!/^---\r?\n[\s\S]*?\r?\n---/.test(before)) throw new Error(`Missing owned frontmatter: ${file.path}`);
		const content = before.replace(/^---\r?\n[\s\S]*?\r?\n---/, () => renderFrontmatterYaml(fm));
		transaction.operations.push({ kind: "write", path: file.path, content, beforeHash: vaultContentHash(before) });
		stats.orphaned++;
	}

	transaction.operations.push(...moves, ...creations);
	await transaction.commit(archive);
	return stats;
}
