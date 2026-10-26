/**
 * What to pull, in what order, and how it becomes the cache.
 *
 * One `exec`, one round trip. One `cat` per file would cost roughly 1,230
 * sequential SSH round trips per sync. The probe measured the
 * replacement at 26.8 MB in 7.6 s.
 *
 * Not compressed, deliberately: the 2019 ARM core takes 31 s to gzip the
 * sidecars down to 4.6 MB versus 2.5 s to tar them raw at 14.1 MB, and usbnet
 * is fast. Compression trades 10 MB on a fast link for 28 s of slow CPU.
 */
import { SIDECAR_EXTS } from "../decode/build";
import { mergeClippingsBytes } from "../decode/clippings";
import {
	isExcludedMember,
	mapRemotePath,
	promotePull,
	StagedFile,
} from "./cache";
import { DEVICE_DEFAULTS, execStreaming, SshSettings } from "./ssh";
import { DEFAULT_TAR_LIMITS, TarEntry, TarLimits, TarParser } from "./tar";
import * as fs from "node:fs";
import * as path from "node:path";

export const REMOTE_CLIPPINGS = "mnt/us/documents/My Clippings.txt";
export const REMOTE_FMCACHE = "mnt/us/system/fmcache/fmcache.db";

/**
 * The one-shot pull command.
 *
 * Three things here are load-bearing and each was measured, not assumed:
 *
 *  - `set -eu` plus the trap. Without them a failed or partial `find` would
 *    still produce a successful-looking but incomplete archive.
 *  - Newline-separated `-T`, never `--null`: busybox 1.28.3 rejects `--null`
 *    outright, so the GNU `find -print0 | tar --null -T -` idiom fails. 817 of
 *    819 sidecar paths contain spaces and `-T` handled every one, because
 *    busybox reads whole lines. A filename containing a literal newline would
 *    break this; no Kindle title has one and no speculative guard is written.
 *  - `fmcache.db` is listed only when it exists. Firmware 5.16+ writes it;
 *    on 5.11.2 its directory is absent, and tar exits non-zero on a missing
 *    member. An earlier design joined two halves with `&&`, which would have
 *    short-circuited and silently skipped the entire documents tree.
 */
export function buildPullCommand(): string {
	const nameExpr = SIDECAR_EXTS.map((ext) => `-name '*${ext}'`).join(" -o ");
	return [
		"set -eu",
		"list=/tmp/kindle-ssh-sync-sidecars.$$",
		`trap 'rm -f "$list"' EXIT HUP INT TERM`,
		`find /mnt/us/documents -type f \\( ${nameExpr} \\) >"$list"`,
		`if [ -e /${REMOTE_FMCACHE} ]; then echo /${REMOTE_FMCACHE} >>"$list"; fi`,
		"tar cf - /var/local/cc.db /mnt/us/system/vocabulary/vocab.db " +
			"/mnt/us/system/thumbnails '/mnt/us/documents/My Clippings.txt' " +
			'-T "$list"',
	].join("\n");
}

export interface PullOptions {
	/** Caller holds its CacheLock and has recovered any pending promotion. */
	cacheRoot: string;
	/** Overrides the tar parser's staging bounds; tests use tiny limits. */
	limits?: Partial<TarLimits>;
	settings: SshSettings;
	signal?: AbortSignal;
	onProgress?: (message: string) => void;
}

export interface PullResult {
	fileCount: number;
	newObjects: number;
	bytesPulled: number;
	/** Members deliberately not cached: wishlist art, half-downloaded covers. */
	excluded: number;
	warnings: string[];
	/** The host key fingerprint trusted on this first connection, to be saved. */
	trustedHostKey?: string;
}

/**
 * Stage and validate the complete pull before starting journaled promotion.
 *
 * Nothing touches the live cache until the remote command has exited 0 *and*
 * the tar parser has accepted every member. A mid-extraction abort therefore
 * leaves neither a current-view change nor a snapshot manifest. Once promotion
 * starts, recovery rolls forward individual files; the view is not atomic.
 */
export async function pullFromDevice(options: PullOptions): Promise<PullResult> {
	const { cacheRoot, settings, signal } = options;
	const progress = options.onProgress ?? (() => undefined);
	const warnings: string[] = [];

	// The parser bounds the staged bytes, entries and member size.
	const limits = { ...DEFAULT_TAR_LIMITS, ...options.limits };
	const staged = new Map<string, StagedFile>();
	let rejected = 0;
	let excluded = 0;

	const accept = (entry: TarEntry) => {
		if (entry.type !== "file") return;
		const local = mapRemotePath(entry.name);
		if (!local) {
			// Two ways to be unwanted, and only one is a surprise.
			// Wishlist art and half-downloaded covers are expected on every
			// pull, so they are counted but never warned about.
			if (isExcludedMember(entry.name)) excluded++;
			else rejected++;
			return;
		}
		staged.set(entry.name, { remote: entry.name, bytes: entry.data });
	};

	progress("Pulling from the Kindle over SSH...");
	const parser = new TarParser(accept, limits);
	const { trustedHostKey } = await execStreaming(settings, buildPullCommand(), {
		signal,
		onData: (chunk) => parser.write(chunk),
	});
	parser.end();

	if (rejected > 0) {
		warnings.push(`${rejected} archive members fell outside the cache mapping and were skipped.`);
	}
	if (staged.size === 0) {
		throw new Error("The device returned an empty archive; nothing was promoted.");
	}

	// The clippings merge must happen BEFORE anything is written. Kindle
	// prunes My Clippings.txt in place, so writing the device's copy
	// straight out of the stream would destroy every clipping it has since
	// dropped -- unrecoverably if the cached copy were overwritten.
	const incoming = staged.get(REMOTE_CLIPPINGS);
	if (!incoming) throw new Error("The device returned no My Clippings.txt; nothing was promoted.");
	const cached = readIfPresent(path.join(cacheRoot, "documents", "My Clippings.txt"), limits.maxMemberBytes);
	const merged = mergeClippingsBytes(cached, incoming.bytes);
	if (merged.length > limits.maxMemberBytes) throw new Error("Merged clippings exceed the member byte limit");
	staged.set(REMOTE_CLIPPINGS, { ...incoming, bytes: merged });

	// An abort must never become a promotion.
	if (signal?.aborted) throw new Error("Sync aborted; nothing was promoted.");

	progress("Promoting the pull...");
	const files = [...staged.values()];
	const promoted = promotePull(cacheRoot, files, {
		host: settings.kindleHost?.trim() || DEVICE_DEFAULTS.host,
	});

	return {
		fileCount: files.length,
		newObjects: promoted.newObjects,
		bytesPulled: promoted.bytesPulled,
		excluded,
		warnings,
		trustedHostKey,
	};
}

function readIfPresent(file: string, maxBytes: number): Uint8Array | null {
	try {
		if (fs.statSync(file).size > maxBytes) throw new Error("Cached clippings exceed the member byte limit");
		return new Uint8Array(fs.readFileSync(file));
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		return null;
	}
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n / 1024;
	let i = 0;
	while (v >= 1024 && i < units.length - 1) {
		v /= 1024;
		i++;
	}
	return `${v.toFixed(1)} ${units[i]}`;
}
