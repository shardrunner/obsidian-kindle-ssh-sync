import { after } from "node:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { syncLibraryToVault, validateVaultSettings } from "../src/vault-writer";
import { VaultTransaction } from "../src/vault-transaction";
import { KindleSyncSettings, LibraryJson } from "../src/types";

// Fixed-location recovery journals must remain inside disposable test storage.
const previousDataHome = process.env.XDG_DATA_HOME;
const testDataHome = fs.mkdtempSync(path.join(os.tmpdir(), "kindle-test-data-"));
process.env.XDG_DATA_HOME = testDataHome;
after(() => {
	if (previousDataHome === undefined) delete process.env.XDG_DATA_HOME;
	else process.env.XDG_DATA_HOME = previousDataHome;
	fs.rmSync(testDataHome, { recursive: true, force: true });
});

/** main.ts order without locks: validate, recover, then publish on the recovered transaction. */
export async function syncVault(
	app: any,
	library: LibraryJson,
	settings: KindleSyncSettings,
	signal?: AbortSignal,
	archive?: string
) {
	signal?.throwIfAborted();
	validateVaultSettings(settings);
	const transaction = new VaultTransaction(app, settings, signal);
	if (await transaction.recover()) throw new Error("Recovered interrupted Kindle sync. Wait for Obsidian metadata to refresh, then sync again.");
	return syncLibraryToVault(app, library, settings, transaction, parseFixtureYaml, archive);
}

/** Only the flat mappings and JSON values used by synthetic notes; production uses Obsidian's parser. */
function parseFixtureYaml(yaml: string): Record<string, unknown> {
	const fm: Record<string, unknown> = Object.create(null);
	for (const line of yaml.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const pair = line.match(/^\s*("(?:[^"\\]|\\.)*"|[^":]+)\s*:\s*(.*)$/);
		if (!pair) throw new Error(`Unsupported fixture YAML: ${line}`);
		const rawKey = pair[1].trim();
		const key = rawKey.startsWith('"') ? JSON.parse(rawKey) : rawKey;
		const value = pair[2].trim();
		fm[key] = /^["\[{]/.test(value) || /^(true|false|null)$/.test(value)
			? JSON.parse(value)
			: value !== "" && Number.isFinite(Number(value)) ? Number(value) : value;
	}
	return fm;
}

// Create a lightweight mock of the Obsidian App and Vault backed by the local filesystem
export class MockVaultApp {
	vaultPath: string;
	files: Map<string, { path: string; name: string; parent?: { path: string } }>;
	fileContents: Map<string, string>;
	metadataCache: {
		getFileCache: (file: any) => { frontmatter?: any } | null;
	};
	vault: {
		rename: (file: any, newPath: string) => Promise<void>;
		modifyBinary: (file: any, data: ArrayBuffer) => Promise<void>;
		adapter: {
			getBasePath: () => string;
			exists: (p: string) => Promise<boolean>;
			mkdir: (p: string) => Promise<void>;
			writeBinary: (p: string, data: ArrayBuffer) => Promise<void>;
			readBinary: (p: string) => Promise<ArrayBuffer>;
			stat: (p: string) => Promise<{ size: number; type: string } | null>;
		};
		getMarkdownFiles: () => any[];
		getAbstractFileByPath: (p: string) => any;
		getFileByPath: (p: string) => any;
		getFolderByPath: (p: string) => any;
		createBinary: (p: string, data: ArrayBuffer) => Promise<any>;
		createFolder: (p: string) => Promise<void>;
		create: (p: string, data: string) => Promise<any>;
		modify: (file: any, data: string) => Promise<void>;
		read: (file: any) => Promise<string>;
	};
	fileManager: {
		renameFile: (file: any, newPath: string) => Promise<void>;
	};

	/** A folder-like object if a directory (and no tracked file) lives at `p`. */
	folder(p: string): { path: string } | null {
		if (this.files.has(p)) return null;
		const full = path.join(this.vaultPath, p);
		if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
			return { path: p };
		}
		return null;
	}

	constructor(tempDir: string) {
		fs.mkdirSync(tempDir, { recursive: true });
		this.vaultPath = tempDir;
		this.files = new Map();
		this.fileContents = new Map();

		const self = this;

		this.metadataCache = {
			getFileCache: (file: any) => {
				const content = self.fileContents.get(file.path);
				if (!content) return null;
				// Parse only the synthetic fixture subset, without a live metadata cache.
				const match = content.match(/^---\n([\s\S]*?)\n---/);
				if (!match) return null;
				return { frontmatter: parseFixtureYaml(match[1]) };
			},
		};

		this.vault = {
			rename: async (file, newPath) => self.fileManager.renameFile(file, newPath),
			modifyBinary: async (file, data) => self.vault.adapter.writeBinary(file.path, data),
			adapter: {
				getBasePath: () => self.vaultPath,
				exists: async (p: string) => {
					const full = path.join(self.vaultPath, p);
					return fs.existsSync(full);
				},
				mkdir: async (p: string) => {
					const full = path.join(self.vaultPath, p);
					fs.mkdirSync(full, { recursive: true });
				},
				readBinary: async (p: string) => new Uint8Array(fs.readFileSync(path.join(self.vaultPath, p))).buffer,
				stat: async (p: string) => {
					const full = path.join(self.vaultPath, p);
					if (!fs.existsSync(full)) return null;
					return { size: fs.statSync(full).size, type: fs.statSync(full).isDirectory() ? "folder" : "file" };
				},
				writeBinary: async (p: string, data: ArrayBuffer) => {
					const full = path.join(self.vaultPath, p);
					fs.mkdirSync(path.dirname(full), { recursive: true });
					fs.writeFileSync(full, Buffer.from(data));
				},
			},
			getMarkdownFiles: () => {
				return Array.from(self.files.values()).filter((f) => f.path.endsWith(".md"));
			},
			getAbstractFileByPath: (p: string) => {
				return self.files.get(p) || self.folder(p);
			},
			getFileByPath: (p: string) => {
				return self.files.get(p) || null;
			},
			getFolderByPath: (p: string) => {
				return self.folder(p);
			},
			createBinary: async (p: string, data: ArrayBuffer) => { await self.vault.adapter.writeBinary(p, data); self.files.set(p, { path: p, name: path.basename(p) }); },
			createFolder: async (p: string) => {
				const full = path.join(self.vaultPath, p);
				fs.mkdirSync(full, { recursive: true });
			},
			create: async (p: string, data: string) => {
				if (self.vault.getAbstractFileByPath(p)) throw new Error(`Already exists: ${p}`);
				const full = path.join(self.vaultPath, p);
				fs.mkdirSync(path.dirname(full), { recursive: true });
				fs.writeFileSync(full, data, "utf-8");
				const name = path.basename(p);
				const dir = path.dirname(p);
				const fileObj = { path: p, name, parent: { path: dir === "." ? "" : dir } };
				self.files.set(p, fileObj);
				self.fileContents.set(p, data);
				return fileObj;
			},
			modify: async (file: any, data: string) => {
				const full = path.join(self.vaultPath, file.path);
				fs.writeFileSync(full, data, "utf-8");
				self.fileContents.set(file.path, data);
			},
			read: async (file: any) => {
				return self.fileContents.get(file.path) || "";
			},
		};

		this.fileManager = {
			renameFile: async (file: any, newPath: string) => {
				if (self.vault.getAbstractFileByPath(newPath)) throw new Error(`Already exists: ${newPath}`);
				const oldFull = path.join(self.vaultPath, file.path);
				const newFull = path.join(self.vaultPath, newPath);
				fs.mkdirSync(path.dirname(newFull), { recursive: true });
				if (fs.existsSync(oldFull)) {
					fs.renameSync(oldFull, newFull);
				}
				const content = self.fileContents.get(file.path) || "";
				self.files.delete(file.path);
				self.fileContents.delete(file.path);

				const name = path.basename(newPath);
				const dir = path.dirname(newPath);
				file.path = newPath;
				file.name = name;
				file.parent = { path: dir === "." ? "" : dir };
				self.files.set(newPath, file);
				self.fileContents.set(newPath, content);
			},
		};
	}
}

