/**
 * A tar read-path, sufficient for exactly what the Kindle's busybox `tar cf -`
 * emits and nothing more.
 *
 * This is deliberately NOT a plain ustar parser. Measured over the device
 * probe's own archive: of 1242 file entries, **779 are preceded by a GNU
 * LongName pseudo-entry** (typeflag 'L'), because ustar's 100-byte `name`
 * field cannot hold these paths and the prefix/name split fails for most of
 * them. A parser that ignores typeflag 'L' produces truncated or garbage paths
 * for 63% of the archive.
 *
 * Everything outside the measured shape is rejected rather than guessed at:
 * links, device nodes, PAX/unknown typeflags, bad checksums, duplicate members
 * and path traversal all fail the pull before anything is promoted.
 */

export const BLOCK_SIZE = 512;

export interface TarLimits {
	maxMemberBytes: number;
	maxEntries: number;
	maxArchiveBytes: number;
}

export const DEFAULT_TAR_LIMITS: Readonly<TarLimits> = {
	maxMemberBytes: 64 * 1024 * 1024,
	maxEntries: 100_000,
	maxArchiveBytes: 256 * 1024 * 1024,
};

export type TarEntryType = "file" | "directory";

export interface TarEntry {
	/** The member path as stored, with tar's stripped leading slash. */
	name: string;
	type: TarEntryType;
	size: number;
	mode: number;
	mtime: number;
	/** Empty for a directory. */
	data: Uint8Array;
}

export class TarError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TarError";
	}
}

const TYPEFLAG_FILE_ALT = "\0";
const TYPEFLAG_FILE = "0";
const TYPEFLAG_DIRECTORY = "5";
const TYPEFLAG_LONGNAME = "L";

const ASCII = new TextDecoder("utf-8", { fatal: false });

function cString(block: Uint8Array, offset: number, length: number): string {
	const slice = block.subarray(offset, offset + length);
	let end = slice.indexOf(0);
	if (end === -1) end = slice.length;
	return ASCII.decode(slice.subarray(0, end));
}

/** Parse a NUL/space-padded octal field. */
function octal(block: Uint8Array, offset: number, length: number, field: string): number {
	const raw = cString(block, offset, length).trim();
	if (raw === "") return 0;
	if (!/^[0-7]+$/.test(raw)) {
		throw new TarError(`tar: ${field} is not octal: ${JSON.stringify(raw)}`);
	}
	const value = Number.parseInt(raw, 8);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new TarError(`tar: ${field} out of range: ${raw}`);
	}
	return value;
}

function isZeroBlock(block: Uint8Array): boolean {
	for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false;
	return true;
}

/**
 * Validate the header checksum. The field itself counts as spaces. Historic
 * writers disagree on whether bytes are signed, so both sums are accepted --
 * that is the conventional reader behaviour, not laxity.
 */
function verifyChecksum(block: Uint8Array): void {
	const expected = octal(block, 148, 8, "checksum");
	let unsigned = 0;
	let signed = 0;
	for (let i = 0; i < BLOCK_SIZE; i++) {
		const b = i >= 148 && i < 156 ? 0x20 : block[i];
		unsigned += b;
		signed += b > 127 ? b - 256 : b;
	}
	if (expected !== unsigned && expected !== signed) {
		throw new TarError(
			`tar: header checksum mismatch (stored ${expected}, computed ${unsigned})`
		);
	}
}

/**
 * Reject anything that could write outside the intended destination. Tar
 * strips the leading '/', so an absolute member arrives relative -- but '..'
 * and a re-introduced absolute path must both be refused.
 *
 * Backslash is deliberately NOT rejected: this is Linux-only, where '\' is an
 * ordinary filename character that path.join treats as such. Refusing it would
 * fail an entire pull over a legally named book rather than prevent anything.
 */
export function assertSafeMemberPath(name: string): void {
	if (name === "") throw new TarError("tar: empty member name");
	if (name.startsWith("/")) throw new TarError(`tar: absolute member path: ${name}`);
	if (name.includes("\0")) throw new TarError(`tar: NUL in member path: ${name}`);
	for (const part of name.split("/")) {
		if (part === "..") throw new TarError(`tar: path traversal in member: ${name}`);
	}
}

/**
 * Incremental parser. Fed chunks as they arrive from the SSH stream; emits one
 * callback per accepted member. Only the current member's content is buffered,
 * never the whole archive.
 */
export class TarParser {
	private readonly header = new Uint8Array(BLOCK_SIZE);
	private headerBytes = 0;
	private member: Uint8Array | undefined;
	private memberBytes = 0;
	private memberSize = 0;
	private padding = 0;
	private archiveBytes = 0;
	private entries = 0;
	private readonly limits: TarLimits;
	private readonly seen = new Set<string>();
	private pendingName: string | undefined;
	private zeroBlocks = 0;
	private finished = false;

	constructor(private readonly onEntry: (entry: TarEntry) => void, limits: Partial<TarLimits> = {}) {
		this.limits = { ...DEFAULT_TAR_LIMITS, ...limits };
		for (const [name, value] of Object.entries(this.limits)) {
			if (!Number.isSafeInteger(value) || value <= 0) throw new TarError(`tar: invalid limit ${name}`);
		}
	}

	write(chunk: Uint8Array): void {
		if (chunk.length > this.limits.maxArchiveBytes - this.archiveBytes) {
			throw new TarError("tar: archive byte limit exceeded");
		}
		this.archiveBytes += chunk.length;
		let offset = 0;
		while (offset < chunk.length) {
			if (this.finished) return;
			if (this.member) {
				const count = Math.min(this.memberSize - this.memberBytes, chunk.length - offset);
				this.member.set(chunk.subarray(offset, offset + count), this.memberBytes);
				this.memberBytes += count;
				offset += count;
				if (this.memberBytes < this.memberSize) return;
				const skip = Math.min(this.padding, chunk.length - offset);
				this.padding -= skip;
				offset += skip;
				if (this.padding) return;
				const data = this.member;
				this.member = undefined;
				this.handle(this.header, cString(this.header, 156, 1) || TYPEFLAG_FILE_ALT, this.memberSize, data);
				continue;
			}
			const count = Math.min(BLOCK_SIZE - this.headerBytes, chunk.length - offset);
			this.header.set(chunk.subarray(offset, offset + count), this.headerBytes);
			this.headerBytes += count;
			offset += count;
			if (this.headerBytes < BLOCK_SIZE) return;
			this.headerBytes = 0;
			if (isZeroBlock(this.header)) {
				if (++this.zeroBlocks >= 2) this.finished = true;
				continue;
			}
			this.zeroBlocks = 0;
			verifyChecksum(this.header);
			if (++this.entries > this.limits.maxEntries) throw new TarError("tar: entry count limit exceeded");
			this.memberSize = octal(this.header, 124, 12, "size");
			if (this.memberSize > this.limits.maxMemberBytes) throw new TarError("tar: member byte limit exceeded");
			const paddedSize = Math.ceil(this.memberSize / BLOCK_SIZE) * BLOCK_SIZE;
			const consumed = this.archiveBytes - chunk.length + offset;
			if (paddedSize > this.limits.maxArchiveBytes - consumed) throw new TarError("tar: archive byte limit exceeded");
			if (this.memberSize === 0) {
				this.handle(this.header, cString(this.header, 156, 1) || TYPEFLAG_FILE_ALT, 0, new Uint8Array(0));
			} else {
				this.member = new Uint8Array(this.memberSize);
				this.memberBytes = 0;
				this.padding = paddedSize - this.memberSize;
			}
		}
	}

	/** Finish parsing and assert the archive was well-formed. */
	end(): void {
		if (!this.finished) throw new TarError("tar: truncated stream ended before the end-of-archive marker");
	}

	private handle(header: Uint8Array, typeflag: string, size: number, data: Uint8Array): void {
		// GNU long name: a pseudo-entry whose *content* is the real path of the
		// entry that follows. 63% of this archive needs it. Long link targets
		// ('K') only precede links, which are rejected anyway.
		if (typeflag === TYPEFLAG_LONGNAME) {
			let end = data.indexOf(0);
			if (end === -1) end = data.length;
			this.pendingName = new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, end));
			return;
		}

		const shortName = cString(header, 0, 100);
		const prefix = cString(header, 345, 155);
		const name = this.pendingName ?? (prefix ? `${prefix}/${shortName}` : shortName);
		this.pendingName = undefined;

		let type: TarEntryType;
		if (typeflag === TYPEFLAG_FILE || typeflag === TYPEFLAG_FILE_ALT) type = "file";
		else if (typeflag === TYPEFLAG_DIRECTORY) type = "directory";
		else {
			// Links, device nodes, FIFOs, PAX headers and anything else are not
			// in the measured archive and are not guessed at.
			throw new TarError(
				`tar: unsupported member type '${typeflag}' for ${JSON.stringify(name)}`
			);
		}

		const normalised = name.replace(/\/+$/, "");
		assertSafeMemberPath(normalised);

		if (type === "file") {
			if (this.seen.has(normalised)) {
				// A duplicate member would let a later entry silently overwrite
				// an earlier one after it had already been accepted.
				throw new TarError(`tar: duplicate member ${JSON.stringify(normalised)}`);
			}
			this.seen.add(normalised);
		}

		this.onEntry({
			name: normalised,
			type,
			size: type === "directory" ? 0 : size,
			mode: octal(header, 100, 8, "mode"),
			mtime: octal(header, 136, 12, "mtime"),
			data: type === "directory" ? new Uint8Array(0) : data,
		});
	}
}

/** Convenience wrapper for a complete in-memory archive. */
export function parseTar(bytes: Uint8Array): TarEntry[] {
	const entries: TarEntry[] = [];
	const parser = new TarParser((e) => entries.push(e));
	parser.write(bytes);
	parser.end();
	return entries;
}
