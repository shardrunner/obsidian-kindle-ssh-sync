/**
 * SSH transport, over a single persistent `ssh2` connection.
 *
 * A device probe measured that this Kindle's dropbear offers
 * modern algorithms only -- curve25519-sha256, ssh-ed25519, aes128-ctr,
 * hmac-sha2-256 -- so the anticipated legacy `ssh-rsa` /
 * `diffie-hellman-group1-sha1` compatibility problem does not exist and no
 * custom `algorithms` block is needed. If a future device needs one, add it
 * here rather than loosening defaults globally.
 */
import { createHash } from "node:crypto";
import { Client, ConnectConfig } from "ssh2";

/** Jailbroken-Kindle usbnet defaults. */
export const DEVICE_DEFAULTS = {
	host: "192.168.15.244",
	user: "root",
};

export interface SshSettings {
	kindleHost: string;
	kindleUser: string;
	/** Empty until the first connection trusts and records the Kindle's key. */
	kindleHostFingerprint: string;
	kindlePassword: string;
	syncTimeoutSeconds: number;
}

/**
 * TCP connect, handshake and auth. usbnet answers in milliseconds, so an
 * unreachable device fails fast instead of after the whole operation timeout.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/** ssh2 error levels that mean the device was never reached. */
const UNREACHABLE_LEVELS = new Set(["client-socket", "client-timeout", "client-dns"]);

export class SshError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SshError";
	}
}

/**
 * Password authentication, trusting the host key on first use: with no stored
 * fingerprint the received one is accepted and reported through `onTrusted`,
 * and afterwards any other key is refused.
 */
export function buildConnectConfig(
	settings: SshSettings,
	onHostMismatch?: (error: SshError) => void,
	onTrusted?: (fingerprint: string) => void
): ConnectConfig {
	const { host, port } = parseHost(settings.kindleHost);
	if (!settings.kindlePassword) throw new SshError("Set the Kindle SSH password in the plugin settings.");
	const pin = settings.kindleHostFingerprint?.trim();

	return {
		host,
		port,
		username: settings.kindleUser?.trim() || DEVICE_DEFAULTS.user,
		password: settings.kindlePassword,
		authHandler: ["password"],
		readyTimeout: Math.min(CONNECT_TIMEOUT_MS, settings.syncTimeoutSeconds * 1000),
		hostVerifier: (key: Buffer) => {
			const received = "SHA256:" + createHash("sha256").update(key).digest("base64").replace(/=+$/, "");
			if (!pin) {
				onTrusted?.(received);
				return true;
			}
			if (received === pin) return true;
			onHostMismatch?.(new SshError(`The Kindle's SSH host key changed: expected ${pin}, received ${received}. If the Kindle was reset or re-jailbroken, clear "Kindle host fingerprint" in the settings to trust the new key.`));
			return false;
		},
	};
}

/**
 * Split an optional `:port` off the host setting. The device is always on 22,
 * but a user forwarding the device through a jump host needs to say so, and
 * silently ignoring the port they typed would be worse than parsing it.
 */
export function parseHost(value: string | undefined): { host: string; port: number } {
	const raw = value?.trim();
	if (!raw) return { host: DEVICE_DEFAULTS.host, port: 22 };

	const m = /^(.+):(\d{1,5})$/.exec(raw);
	if (!m) return { host: raw, port: 22 };

	const port = Number.parseInt(m[2], 10);
	if (port < 1 || port > 65535) {
		throw new SshError(`Not a valid port in the host setting: ${raw}`);
	}
	return { host: m[1], port };
}

/** A missing host address on the usbnet interface looks exactly like a dead Kindle. */
function unreachableError(host: string, port: number, reason: string): SshError {
	return new SshError(
		`Cannot reach the Kindle at ${host}:${port} (${reason}).\n` +
			`Check the USB cable and that usbnet is enabled. The computer also needs an ` +
			`address on the Kindle's USB network. With NetworkManager, until it is unplugged:\n` +
			`nmcli dev modify <USB device> ipv4.method manual ipv4.addresses 192.168.15.201/24\n` +
			`("nmcli dev" lists the device names.)`
	);
}

const MAX_STDERR_BYTES = 64 * 1024;

export interface ExecStreamResult {
	/** Set when this connection trusted a previously unknown host key. */
	trustedHostKey?: string;
}

export interface ExecOptions {
	signal?: AbortSignal;
	/** Called for each stdout chunk as it arrives. */
	onData: (chunk: Uint8Array) => void;
}

/**
 * Connect, run one command, stream stdout to `onData`, disconnect.
 *
 * The caller must treat a non-zero exit status as a failed pull. Nothing is
 * promoted until both this resolves successfully *and* the local parser
 * accepts the stream.
 */
export function execStreaming(
	settings: SshSettings,
	command: string,
	options: ExecOptions
): Promise<ExecStreamResult> {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new SshError("Sync aborted before the connection was opened."));
			return;
		}

		let config: ConnectConfig;
		let hostMismatch: SshError | undefined;
		let trustedHostKey: string | undefined;
		try {
			config = buildConnectConfig(settings, (error) => { hostMismatch = error; }, (fingerprint) => { trustedHostKey = fingerprint; });
		} catch (e) {
			reject(e);
			return;
		}

		const client = new Client();
		let settled = false;
		let ready = false;
		const stderrChunks: Buffer[] = [];
		let stderrBytes = 0;
		const stderrText = () => Buffer.concat(stderrChunks, stderrBytes).toString("utf8");
		let timer: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			try {
				client.end();
			} catch {
				/* already closing */
			}
		};

		const fail = (err: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		const succeed = (result: ExecStreamResult) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(result);
		};

		function onAbort() {
			// There is no child process to kill here -- the abort path is simply
			// tearing down the connection and never promoting the staged pull.
			fail(new SshError("Sync aborted."));
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });

		const timeoutMs = settings.syncTimeoutSeconds * 1000;
		timer = setTimeout(() => {
			const seconds = Math.round(timeoutMs / 1000);
			fail(ready
				? new SshError(`The SSH operation did not finish within ${seconds} s.`)
				: unreachableError(config.host!, config.port!, `no connection within ${seconds} s`));
		}, timeoutMs);

		client.on("error", (err: Error & { level?: string }) => {
			if (hostMismatch) fail(hostMismatch);
			else if (!ready && err.level && UNREACHABLE_LEVELS.has(err.level)) fail(unreachableError(config.host!, config.port!, err.message));
			else fail(new SshError(`SSH connection failed: ${err.message}`));
		});

		client.on("ready", () => {
			ready = true;
			client.exec(command, (err, stream) => {
				if (err) {
					fail(new SshError(`Could not start the remote command: ${err.message}`));
					return;
				}

				let exitCode: number | null = null;

				stream.on("data", (chunk: Buffer) => {
					if (settled) return;
					try {
						options.onData(new Uint8Array(chunk));
					} catch (e) {
						// A parser rejection must abort the pull immediately rather
						// than draining 27 MB into a stream nobody is reading.
						fail(e instanceof Error ? e : new Error(String(e)));
					}
				});

				stream.stderr.on("data", (chunk: Buffer) => {
					if (settled) return;
					if (chunk.length > MAX_STDERR_BYTES - stderrBytes) {
						fail(new SshError(`SSH stderr exceeded the ${MAX_STDERR_BYTES}-byte limit.`));
						return;
					}
					stderrChunks.push(Buffer.from(chunk));
					stderrBytes += chunk.length;
				});

				stream.on("exit", (code: number | null) => {
					exitCode = code ?? -1;
				});

				stream.on("close", () => {
					if (exitCode !== 0) {
						fail(
							new SshError(
								`The remote command exited with status ${exitCode}.\n` +
									(stderrText().trim() || "(no stderr output)")
							)
						);
						return;
					}
					succeed({ trustedHostKey });
				});
			});
		});

		try {
			client.connect(config);
		} catch (e) {
			fail(new SshError(`SSH connection failed: ${String(e)}`));
		}
	});
}
