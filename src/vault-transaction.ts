import type { App } from "obsidian";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { defaultCachePath, resolveCachePath, writeFileAtomic } from "./device/cache";
import { normalizeVaultPath } from "./vault-path";
import type { KindleSyncSettings } from "./types";

export type VaultOperation =
	/** Overwrites carry the planned bytes' hash; creations must not find a file. */
	| { kind: "write"; path: string; content: string; binary?: boolean; create?: boolean; beforeHash?: string }
	| { kind: "move"; from: string; path: string; uuid: string };

export function vaultContentHash(content: string | Buffer): string {
	return createHash("sha256").update(content).digest("hex");
}

/** Read identity from current bytes, never the potentially stale metadata cache. */
export function vaultOwnedIdentity(content: string): string | undefined {
	const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
	const scalar = (key: string) => {
		const values = frontmatter?.split(/\r?\n/).filter(line => line.startsWith(`${key}:`));
		if (values?.length !== 1) return undefined;
		const value = values[0].slice(key.length + 1).trim();
		if (value.startsWith('"')) { try { return JSON.parse(value); } catch { return undefined; } }
		if (value.startsWith("'")) return /^'([^']|'')*'$/.test(value) ? value.slice(1, -1).replaceAll("''", "'") : undefined;
		return value;
	};
	const uuid = scalar("kindle_uuid");
	if (scalar("meta_generator") !== "kindle_sync") return undefined;
	return typeof uuid === "string" && uuid ? uuid : undefined;
}

async function archiveHash(file: string): Promise<string | null> {
	try { return vaultContentHash(await fs.readFile(file)); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw error;
	}
}

async function readJson(file: string): Promise<any | undefined> {
	try { return JSON.parse(await fs.readFile(file, "utf8")); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function validateOperations(operations: VaultOperation[]): void {
	for (const op of operations) {
		if (!op || (op.kind === "move" ? typeof op.uuid !== "string" || !op.uuid
			: op.kind !== "write" || typeof op.content !== "string" || (!op.create && !/^[a-f0-9]{64}$/.test(op.beforeHash ?? "")))) {
			throw new Error("Invalid sync journal operation");
		}
		for (const p of [op.path, ...(op.kind === "move" ? [op.from] : [])]) {
			if (!p || normalizeVaultPath(p) !== p) throw new Error(`Unsafe sync journal path: ${JSON.stringify(p)}`);
		}
	}
}

/** Durable roll-forward journal. Keep it until every operation has completed. */
export class VaultTransaction {
	readonly operations: VaultOperation[] = [];
	private journal: string;
	private cacheRoot: string;
	/** Fixed, outside-vault directory. Callers must hold the global CacheLock before recovery or sync. */
	readonly directory: string;

	constructor(private app: App, settings: KindleSyncSettings, private signal?: AbortSignal) {
		const adapter = app.vault.adapter as typeof app.vault.adapter & { getBasePath(): string };
		const base = adapter.getBasePath();
		const id = createHash("sha256").update(realpathSync(base)).digest("hex");
		this.cacheRoot = path.resolve(resolveCachePath(settings));
		this.directory = path.join(defaultCachePath(), "vault-transactions", id);
		this.journal = path.join(this.directory, "transaction.json");
	}

	private save(value: unknown, destination = this.journal) {
		writeFileAtomic(destination, Buffer.from(JSON.stringify(value)));
	}

	private async readState() {
		const state = await readJson(this.journal);
		if (state === undefined) return undefined;
		if (!state || state.version !== 2 || typeof state.cacheRoot !== "string" || !path.isAbsolute(state.cacheRoot) || !(state.archive === null || typeof state.archive === "string") || typeof state.id !== "string" || !Array.isArray(state.operations) || !Number.isInteger(state.next) || state.next < 0 || state.next > state.operations.length) {
			throw new Error(`Invalid sync journal: ${this.journal}`);
		}
		if (!(state.archiveBeforeHash === null || (typeof state.archiveBeforeHash === "string" && /^[a-f0-9]{64}$/.test(state.archiveBeforeHash)))) {
			throw new Error(`Invalid archive precondition in sync journal: ${this.journal}`);
		}
		validateOperations(state.operations);
		return state;
	}

	/** Snapshot cache to recover before recover(); may differ from current settings. Hold the global lock first. */
	async pendingCacheRoot(): Promise<string | undefined> {
		return (await this.readState())?.cacheRoot;
	}

	async recover(replaying = true): Promise<boolean> {
		this.signal?.throwIfAborted();
		const state = await this.readState();
		if (state === undefined) return false;
		const checkpoint = `${this.journal}.progress`;
		const progress = await readJson(checkpoint);
		if (progress?.id === state.id) {
			if (!Number.isInteger(progress.next) || progress.next < 0 || progress.next > state.operations.length) throw new Error("Invalid sync checkpoint");
			state.next = progress.next;
		}
		while (state.next < state.operations.length) {
			this.signal?.throwIfAborted();
			await this.apply(state.operations[state.next], replaying);
			state.next++;
			// Checkpoint only the cursor, not the entire library, after each operation.
			this.save({ id: state.id, next: state.next }, checkpoint);
		}
		// Final operation is deliberately replayed if publication succeeded before a crash.
		this.signal?.throwIfAborted();
		if (state.archive !== null) {
			const archive = path.join(state.cacheRoot, "archive.json");
			const payload = Buffer.from(state.archive, "utf8");
			const currentHash = await archiveHash(archive);
			this.signal?.throwIfAborted();
			if (currentHash !== vaultContentHash(payload)) {
				if (currentHash !== state.archiveBeforeHash) throw new Error(`Recovery conflict: changed archive at ${archive}; pending journal retained at ${this.journal}`);
				writeFileAtomic(archive, payload);
			}
		}
		await fs.unlink(this.journal);
		await fs.rm(checkpoint, { force: true });
		const dir = await fs.open(this.directory, "r");
		try { await dir.sync(); } finally { await dir.close(); }
		return true;
	}

	async commit(archive?: string) {
		this.signal?.throwIfAborted();
		if (!this.operations.length && archive === undefined) return;
		validateOperations(this.operations);
		if (await this.readState() !== undefined) throw new Error("Pending Kindle sync journal must be recovered before a new batch.");
		this.signal?.throwIfAborted();
		const archiveBeforeHash = archive === undefined ? null : await archiveHash(path.join(this.cacheRoot, "archive.json"));
		this.signal?.throwIfAborted();
		this.save({ version: 2, id: randomUUID(), cacheRoot: this.cacheRoot, archive: archive ?? null, archiveBeforeHash, next: 0, operations: this.operations });
		try { await this.recover(false); }
		catch (error) {
			throw new Error(`Vault update interrupted. Keep the cache and journal, and retry sync to recover. If a conflict is reported, preserve both versions and review it before retrying; do not delete the journal. Journal: ${this.journal}. ${error instanceof Error ? error.message : error}`);
		}
	}

	private async folder(p: string): Promise<void> {
		this.signal?.throwIfAborted();
		const parent = p.split("/").slice(0, -1).join("/");
		if (!parent || this.app.vault.getFolderByPath(parent)) return;
		await this.folder(parent);
		this.signal?.throwIfAborted();
		await this.app.vault.createFolder(parent);
	}

	private async apply(op: VaultOperation, replaying: boolean) {
		const { vault } = this.app;
		await this.folder(op.path);
		this.signal?.throwIfAborted();
		if (op.kind === "move") {
			const source = vault.getFileByPath(op.from);
			const matches = async (p: string) => (await vault.adapter.stat(p))?.type === "file" && vaultOwnedIdentity(Buffer.from(await vault.adapter.readBinary(p)).toString("utf8")) === op.uuid;
			if (!source && !(await vault.adapter.exists(op.from)) && await matches(op.path)) return;
			if (!source || !await matches(op.from) || await vault.adapter.exists(op.path)) throw new Error(`Recovery conflict at move ${op.from} -> ${op.path}`);
			// Preserve Obsidian's backlink handling and the user's link-update setting.
			this.signal?.throwIfAborted();
			await this.app.fileManager.renameFile(source, op.path);
		} else {
			const file = vault.getFileByPath(op.path);
			if (op.create && await vault.adapter.exists(op.path)) {
				if (!replaying) throw new Error(`Destination appeared during sync: ${op.path}`);
				// Only an exact match proves no further write is needed. A partial
				// creation cannot be distinguished safely from an unrelated file.
				const stat = await vault.adapter.stat(op.path);
				const expected = Buffer.from(op.content, op.binary ? "base64" : "utf8");
				if (stat?.type === "file" && expected.equals(Buffer.from(await vault.adapter.readBinary(op.path)))) return;
				throw new Error(`Recovery conflict at ${op.path}: review and move the conflicting file aside before retrying.`);
			}
			if (!op.create) {
				if (!file || (await vault.adapter.stat(op.path))?.type !== "file") throw new Error(`Recovery conflict: missing or replaced file at ${op.path}`);
				const current = Buffer.from(await vault.adapter.readBinary(op.path));
				const expected = Buffer.from(op.content, op.binary ? "base64" : "utf8");
				if (current.equals(expected)) return;
				if (vaultContentHash(current) !== op.beforeHash) throw new Error(`Recovery conflict: changed file at ${op.path}`);
			}
			this.signal?.throwIfAborted();
			if (op.binary) {
				const bytes = Uint8Array.from(Buffer.from(op.content, "base64")).buffer;
				if (file) await vault.modifyBinary(file, bytes);
				else await vault.createBinary(op.path, bytes);
			} else if (file) await vault.modify(file, op.content);
			else await vault.create(op.path, op.content);
		}
	}
}
