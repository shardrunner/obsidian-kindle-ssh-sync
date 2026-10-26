/**
 * The raw cache: an immutable object store plus a materialised latest view.
 *
 * Retained raw history has two layers:
 *
 *   raw-objects/<sha256>   every distinct byte sequence ever pulled, written
 *                          once, never pruned
 *   snapshots/<ISO>.json   remote path -> digest, one per successful pull
 *
 * Live files at the cache root are a materialised latest view, not another
 * retained history layer. No retention setting prunes objects or snapshots.
 *
 * Pull bytes are staged and validated before promotion: an aborted or
 * malformed pull cannot alter the live view or create a snapshot. Once
 * promotion starts, a journal rolls forward the manifest and live files;
 * they do not all change atomically. SSH abort tears down the connection
 * before promotion rather than killing a child process.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface RemoteMapping {
	/** The member path as tar emits it, with the leading slash stripped. */
	prefix: string;
	/** Where it lands under the cache root. */
	local: string;
	/** True when `prefix` names a single file rather than a directory. */
	exact?: boolean;
}

/**
 * The explicit remote -> cache mapping. Tar strips the leading '/', so members
 * arrive relative; anything not matching one of these is rejected rather than
 * written somewhere plausible.
 */
export const REMOTE_MAPPINGS: RemoteMapping[] = [
	{ prefix: "var/local/cc.db", local: "cc.db", exact: true },
	{ prefix: "mnt/us/system/vocabulary/vocab.db", local: "vocab.db", exact: true },
	{ prefix: "mnt/us/system/fmcache/fmcache.db", local: "fmcache.db", exact: true },
	{ prefix: "mnt/us/system/thumbnails", local: "thumbnails" },
	{ prefix: "mnt/us/documents", local: "documents" },
];

export class CacheError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CacheError";
	}
}

/**
 * Members the pull collects but the cache deliberately refuses.
 *
 * The one-shot pull takes `/mnt/us/system/thumbnails` wholesale, because
 * enumerating covers per book would cost the round trips the single tar exists
 * to avoid. That directory is not only covers for books you own:
 *
 *  - `StoreWishListResults/` is Amazon store wishlist art. Measured on FW
 *    5.11.2: 15 covers there, and not one of their ASINs appears among the 519
 *    cdeKeys in the catalogue. They are books you have *not* bought.
 *  - `*.partial` is a cover still downloading. All 18 seen were zero bytes.
 *
 * Neither has ever reached a note -- `buildThumbnailIndex` reads the directory
 * flat and matches on a jpg/png suffix, so a subfolder and a `.partial` both
 * fall out. That is an accident of the scan, not a decision: make the scan
 * recursive and wishlist art starts appearing on notes. The exclusion belongs
 * here, at the boundary that decides what the cache is, where it is explicit.
 */
/** Path segments that disqualify a member wherever they appear. */
const EXCLUDED_DIRECTORIES = ["StoreWishListResults"];
/** Filename suffixes that disqualify a member. */
const EXCLUDED_SUFFIXES = [".partial"];

/**
 * True when a member is pulled but deliberately not cached.
 *
 * Distinct from an unmapped path on purpose. Both are skipped, but an unmapped
 * path is a surprise worth a warning and this is not.
 */
export function isExcludedMember(member: string): boolean {
	const segments = member.split("/");
	if (segments.some((s) => EXCLUDED_DIRECTORIES.includes(s))) return true;
	const name = segments[segments.length - 1];
	return EXCLUDED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** Map a tar member to its cache-relative path, or null if it is not wanted. */
export function mapRemotePath(member: string): string | null {
	if (member.includes("\\") || member.includes("\u0000") || member.split("/").some(p => !p || p === "." || p === "..")) return null;
	if (isExcludedMember(member)) return null;
	for (const m of REMOTE_MAPPINGS) {
		if (member === m.prefix) return m.local;
		if (!m.exact && member.startsWith(m.prefix + "/")) {
			return path.posix.join(m.local, member.slice(m.prefix.length + 1));
		}
	}
	return null;
}

/** The default cache location: `$XDG_DATA_HOME/kindle-ssh-sync/`. */
export function defaultCachePath(): string {
	const xdg = process.env.XDG_DATA_HOME;
	const base = xdg && xdg.trim() ? xdg.trim() : path.join(os.homedir(), ".local", "share");
	return path.join(base, "kindle-ssh-sync");
}

/** The configured cache path, or the XDG default when it is left blank. */
export function resolveCachePath(settings: { cachePath?: string }): string {
	const configured = settings.cachePath?.trim();
	return configured ? configured : defaultCachePath();
}

export function sha256(bytes: Uint8Array): string {
	return crypto.createHash("sha256").update(bytes).digest("hex");
}

export interface SnapshotManifest {
	/** ISO-8601, also the manifest's filename. */
	takenAt: string;
	host: string;
	/** remote member path -> raw-object digest. */
	files: Record<string, string>;
}

export interface CacheSizes {
	objectStoreBytes: number;
	objectCount: number;
	manifestBytes: number;
	archiveBytes: number;
}

/** Warn beyond this; never delete anything on the user's behalf. */
export const SIZE_WARNING_BYTES = 2 * 1024 * 1024 * 1024;

function ensureDir(dir: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		const parent = path.dirname(dir);
		ensureDir(parent);
		try {
			fs.mkdirSync(dir);
			// Persist each newly created entry, not just the first missing ancestor.
			syncDir(parent);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		stat = fs.statSync(dir);
	}
	if (!stat.isDirectory()) throw new CacheError(`Not a directory: ${dir}`);
}

function syncDir(dir: string): void {
	const fd = fs.openSync(dir, "r");
	try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Validate containment. */
function cacheDestination(root: string, local: string): string {
	if (!local || local.includes("\\") || local.split("/").some(p => !p || p === "." || p === "..") || path.isAbsolute(local)) {
		throw new CacheError(`Unsafe cache path: ${local}`);
	}
	let dir = root;
	for (const part of local.split("/").slice(0, -1)) {
		dir = path.join(dir, part);
		ensureDir(dir);
	}
	const dest = path.join(root, local);
	try {
		if (!fs.lstatSync(dest).isFile()) throw new CacheError(`Unsafe cache file: ${dest}`);
	} catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
	return dest;
}

/**
 * An exclusive filesystem lock. main.ts takes one at `defaultCachePath()` for
 * the whole sync, so two vaults or Obsidian instances never interleave raw
 * objects, manifests, archive.json or vault journals.
 */
export class CacheLock {
	private constructor(private readonly file: string) {}

	static acquire(cacheRoot: string): CacheLock {
		ensureDir(cacheRoot);
		const file = path.join(cacheRoot, ".lock");
		try {
			// 'wx' fails if it already exists: that is the mutual exclusion.
			const fd = fs.openSync(file, "wx");
			fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
			fs.closeSync(fd);
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code === "EEXIST") {
				let held = "";
				try {
					held = fs.readFileSync(file, "utf-8");
				} catch {
					/* the holder may have released it between the two calls */
				}
				throw new CacheError(
					`The cache at ${cacheRoot} is locked by another sync ${held}. ` +
						`If no sync is running, delete ${file} and retry.`
				);
			}
			throw e;
		}
		return new CacheLock(file);
	}

	release(): void {
		try {
			fs.unlinkSync(this.file);
		} catch {
			/* already gone; releasing twice is not an error */
		}
	}
}

export interface StagedFile {
	/** The remote member path, as recorded in the manifest. */
	remote: string;
	bytes: Uint8Array;
}

export interface PromoteResult {
	newObjects: number;
	bytesPulled: number;
}

/**
 * Write every accepted file's bytes into the object store, record a snapshot
 * manifest, and materialise the live view -- in that order, so the immutable
 * archive is durable before the mutable view changes.
 */
export function promotePull(
	cacheRoot: string,
	files: StagedFile[],
	options: { host: string; takenAt?: Date; onPromotionStage?: (stage: string) => void }
): PromoteResult {
	ensureDir(cacheRoot);
	assertCacheReady(cacheRoot);
	for (const f of files) {
		const local = mapRemotePath(f.remote);
		if (!local) throw new CacheError(`Invalid cache mapping: ${f.remote}`);
		cacheDestination(cacheRoot, local);
	}
	const objectsDir = path.join(cacheRoot, "raw-objects");
	const snapshotsDir = path.join(cacheRoot, "snapshots");
	ensureDir(objectsDir);
	ensureDir(snapshotsDir);

	const manifestFiles: Record<string, string> = {};
	let newObjects = 0;
	let bytesPulled = 0;

	for (const f of files) {
		const digest = sha256(f.bytes);
		manifestFiles[f.remote] = digest;
		bytesPulled += f.bytes.length;

		const objectPath = cacheDestination(cacheRoot, `raw-objects/${digest}`);
		if (!fs.existsSync(objectPath)) {
			// Content-addressed, so a byte-identical re-pull costs nothing and
			// a changed file never overwrites its predecessor.
			writeFileAtomic(objectPath, f.bytes);
			newObjects++;
		} else {
			// Committed objects are only verified, never rewritten or re-fsynced.
			if (sha256(readObject(cacheRoot, digest)) !== digest) throw new CacheError(`Corrupt raw object: ${digest}`);
		}
	}

	// Also commit object entries left by an interrupted earlier promotion.
	syncDir(objectsDir);
	options.onPromotionStage?.("objects");
	const takenAt = (options.takenAt ?? new Date()).toISOString();
	const manifest: SnapshotManifest = {
		takenAt,
		host: options.host,
		files: manifestFiles,
	};

	const manifestName = `${takenAt.replace(/:/g, "-")}-${crypto.randomUUID()}.json`;
	writeFileAtomic(path.join(cacheRoot, ".pending-promotion.json"), Buffer.from(JSON.stringify({ manifestName, manifest })));
	options.onPromotionStage?.("journal");
	recoverCachePromotion(cacheRoot, options.onPromotionStage);

	return { newObjects, bytesPulled };
}

/** Call while holding CacheLock, before any decoder/rebuild reads the live view. */
export function assertCacheReady(cacheRoot: string): void {
	try { fs.lstatSync(path.join(cacheRoot, ".pending-promotion.json")); }
	catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
	throw new CacheError("Cache has a pending promotion; recover it before reading or rebuilding.");
}

/** Idempotent roll-forward. Caller must hold CacheLock for recovery and subsequent reads. */
export function recoverCachePromotion(cacheRoot: string, onStage?: (stage: string) => void): void {
	const journal = path.join(cacheRoot, ".pending-promotion.json");
	let text: string;
	try { text = fs.readFileSync(journal, "utf8"); }
	catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
	const plainObject = (v: unknown): v is Record<string, unknown> =>
		v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;
	let parsed: unknown;
	try { parsed = JSON.parse(text); } catch { throw new CacheError("Invalid promotion journal"); }
	if (!plainObject(parsed) || typeof parsed.manifestName !== "string" || !/^[\w.-]+\.json$/.test(parsed.manifestName)
		|| !plainObject(parsed.manifest)) throw new CacheError("Invalid promotion journal");
	const candidate = parsed.manifest;
	if (typeof candidate.host !== "string" || !candidate.host.trim()
		|| typeof candidate.takenAt !== "string" || !candidate.takenAt.trim() || !Number.isFinite(Date.parse(candidate.takenAt))
		|| !plainObject(candidate.files) || !Object.keys(candidate.files).length) {
		throw new CacheError("Invalid promotion journal");
	}
	for (const [remote, digest] of Object.entries(candidate.files)) {
		if (!mapRemotePath(remote) || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)) throw new CacheError("Invalid promotion member");
	}
	const manifestName = parsed.manifestName;
	const manifest = candidate as unknown as SnapshotManifest;
	ensureDir(cacheRoot);
	// Validate every object before changing any live file. Corruption stays blocked.
	for (const [remote, digest] of Object.entries(manifest.files)) {
		const local = mapRemotePath(remote);
		if (!local) throw new CacheError(`Invalid promotion member: ${remote}`);
		cacheDestination(cacheRoot, local);
		cacheDestination(cacheRoot, `raw-objects/${digest}`);
		if (sha256(readObject(cacheRoot, digest)) !== digest) throw new CacheError(`Corrupt raw object: ${digest}`);
	}
	writeFileAtomic(cacheDestination(cacheRoot, `snapshots/${manifestName}`), Buffer.from(JSON.stringify(manifest, null, 1)));
	onStage?.("manifest");
	for (const [remote, digest] of Object.entries(manifest.files)) {
		const local = mapRemotePath(remote)!;
		writeFileAtomic(cacheDestination(cacheRoot, local), readObject(cacheRoot, digest));
		onStage?.(`file:${local}`);
	}
	fs.unlinkSync(journal);
	syncDir(cacheRoot);
	onStage?.("complete");
}

/** Write via a temporary file and rename, syncing both bytes and directory entry. */
export function writeFileAtomic(dest: string, bytes: Uint8Array): void {
	ensureDir(path.dirname(dest));
	const tmp = `${dest}.tmp-${crypto.randomUUID()}`;
	const fd = fs.openSync(tmp, "wx");
	try {
		fs.writeFileSync(fd, bytes);
		fs.fsyncSync(fd);
	} finally { fs.closeSync(fd); }
	fs.renameSync(tmp, dest);
	syncDir(path.dirname(dest));
}

/** Non-blocking size reporting; call once after the full operation, not during pull. */
export async function readCacheSizes(cacheRoot: string): Promise<CacheSizes> {
	const size = async (dir: string): Promise<{ bytes: number; count: number }> => {
		let entries: fs.Dirent[];
		try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
		catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { bytes: 0, count: 0 }; throw e; }
		let bytes = 0, count = 0;
		for (const entry of entries) {
			const file = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				const sub = await size(file); bytes += sub.bytes; count += sub.count;
			} else if (entry.isFile()) { bytes += (await fs.promises.stat(file)).size; count++; }
			else throw new CacheError(`Unexpected cache entry: ${file}`);
		}
		return { bytes, count };
	};
	const objects = await size(path.join(cacheRoot, "raw-objects"));
	const manifests = await size(path.join(cacheRoot, "snapshots"));
	let archiveBytes = 0;
	try { archiveBytes = (await fs.promises.stat(path.join(cacheRoot, "archive.json"))).size; }
	catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
	return { objectStoreBytes: objects.bytes, objectCount: objects.count, manifestBytes: manifests.bytes, archiveBytes };
}

/** Restore a file's bytes from the object store, by digest. */
export function readObject(cacheRoot: string, digest: string): Uint8Array {
	if (!/^[0-9a-f]{64}$/.test(digest)) {
		throw new CacheError(`Not a sha256 digest: ${digest}`);
	}
	return new Uint8Array(fs.readFileSync(path.join(cacheRoot, "raw-objects", digest)));
}
