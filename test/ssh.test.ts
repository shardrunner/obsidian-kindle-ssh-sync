import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import * as net from "node:net";

import { createHash } from "node:crypto";

import { Server } from "ssh2";

import { buildConnectConfig, execStreaming, SshError, SshSettings } from "../src/device/ssh";

import { TarParser } from "../src/device/tar";

const HOST_KEY = path.join(__dirname, "fixtures", "ssh", "host_ed25519");

const fingerprint = "SHA256:" + createHash("sha256").update(Buffer.from(fs.readFileSync(HOST_KEY + ".pub", "utf8").split(" ")[1], "base64")).digest("base64").replace(/=+$/, "");

const DEVICE_ALGORITHMS = {
	kex: ["curve25519-sha256@libssh.org" as const],
	serverHostKey: ["ssh-ed25519" as const],
	cipher: ["aes128-ctr" as const],
	hmac: ["hmac-sha2-256" as const],
};

interface Fixture {
	port: number;
	close: () => Promise<void>;
	authAttempts: string[];
}

function startServer(handler: {
	password?: string;
	stdout?: Uint8Array;
	exitCode?: number;
	stderr?: string;
	onCommand?: (cmd: string) => void;
}): Promise<Fixture> {
	const authAttempts: string[] = [];

	return new Promise((resolve) => {
		const server = new Server(
			{ hostKeys: [fs.readFileSync(HOST_KEY)], algorithms: DEVICE_ALGORITHMS },
			(client) => {
				client.on("authentication", (ctx) => {
					authAttempts.push(ctx.method);
					if (ctx.method === "password" && ctx.password === (handler.password ?? "kindle")) {
						ctx.accept();
					} else if (ctx.method === "none") {
						ctx.reject(["password"]);
					} else {
						ctx.reject(["password"]);
					}
				});

				client.on("ready", () => {
					client.on("session", (accept) => {
						const session = accept();
						session.on("exec", (acceptExec, _reject, info) => {
							handler.onCommand?.(info.command);
							const stream = acceptExec();
							if (handler.stderr) stream.stderr.write(handler.stderr);
							if (handler.stdout?.length) stream.write(Buffer.from(handler.stdout));
							stream.exit(handler.exitCode ?? 0);
							stream.end();
						});
					});
				});

				client.on("error", () => undefined);
			}
		);

		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as { port: number }).port;
			resolve({
				port,
				authAttempts,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

function settingsFor(port: number, over: Partial<SshSettings> = {}): SshSettings {
	return {
		kindleHost: "127.0.0.1",
		kindleUser: "root",
		kindlePassword: "kindle",
		kindleHostFingerprint: fingerprint,
		syncTimeoutSeconds: 15,
		...over,
	} as SshSettings & { port: number };
}

test("the client completes the device's measured handshake on the pure-JS path", async () => {
	const payload = new TextEncoder().encode("hello from the kindle");
	const server = await startServer({ stdout: payload });
	try {
		const chunks: Uint8Array[] = [];
		await execStreaming(
			{ ...settingsFor(server.port), kindleHost: `127.0.0.1:${server.port}` },
			"echo hi",
			{ onData: (c) => chunks.push(c) }
		);

		assert.equal(Buffer.concat(chunks.map(Buffer.from)).toString(), "hello from the kindle");
		assert.ok(server.authAttempts.includes("password"), "password auth was never attempted");
	} finally {
		await server.close();
	}
});

test("a successful command does not return stderr", async () => {
	const server = await startServer({ stderr: "informational output" });
	try {
		const result = await execStreaming(
			{ ...settingsFor(server.port), kindleHost: `127.0.0.1:${server.port}` },
			"true",
			{ onData: () => undefined }
		);
		assert.deepEqual(result, { trustedHostKey: undefined });
	} finally {
		await server.close();
	}
});

test("a non-zero remote exit fails the pull and surfaces stderr", async () => {
	const server = await startServer({ exitCode: 1, stderr: "find: permission denied" });
	try {
		await assert.rejects(
			execStreaming(
				{ ...settingsFor(server.port), kindleHost: `127.0.0.1:${server.port}` },
				"false",
				{ onData: () => undefined }
			),
			(e: Error) => {
				assert.ok(e instanceof SshError);
				assert.match(e.message, /exited with status 1/);
				assert.match(e.message, /permission denied/);
				return true;
			}
		);
	} finally {
		await server.close();
	}
});

test("a wrong password fails loudly rather than hanging", async () => {
	const server = await startServer({ password: "correct-horse" });
	try {
		await assert.rejects(
			execStreaming(
				{ ...settingsFor(server.port), kindleHost: `127.0.0.1:${server.port}`, kindlePassword: "wrong" },
				"true",
				{ onData: () => undefined }
			),
			(e: Error) => {
				assert.match(e.message, /SSH connection failed/);
				// Reachable but rejected: the network hint would mislead.
				assert.doesNotMatch(e.message, /192\.168\.15\.201/);
				return true;
			}
		);
	} finally {
		await server.close();
	}
});

test("the connection phase is capped well below the operation timeout", () => {
	assert.equal(buildConnectConfig(settingsFor(22, { syncTimeoutSeconds: 600 })).readyTimeout, 15_000);
	assert.equal(buildConnectConfig(settingsFor(22, { syncTimeoutSeconds: 5 })).readyTimeout, 5_000);
});

test("an unreachable Kindle fails with the usbnet address hint", async () => {
	const probe = net.createServer();
	await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
	const port = (probe.address() as net.AddressInfo).port;
	await new Promise<void>((r) => probe.close(() => r()));
	await assert.rejects(
		execStreaming({ ...settingsFor(port), kindleHost: `127.0.0.1:${port}` }, "true", { onData: () => undefined }),
		(e: Error) => {
			assert.match(e.message, /Cannot reach the Kindle at 127\.0\.0\.1:\d+/);
			assert.match(e.message, /ECONNREFUSED/);
			assert.match(e.message, /nmcli .*192\.168\.15\.201\/24/);
			return true;
		}
	);
});

test("a silent host fails at the connection cap with the usbnet hint", async () => {
	// Accepts TCP but never speaks SSH, like a host that swallows the handshake.
	const sockets: net.Socket[] = [];
	const silent = net.createServer((socket) => sockets.push(socket));
	await new Promise<void>((r) => silent.listen(0, "127.0.0.1", r));
	const port = (silent.address() as net.AddressInfo).port;
	try {
		await assert.rejects(
			execStreaming({ ...settingsFor(port, { syncTimeoutSeconds: 1 }), kindleHost: `127.0.0.1:${port}` }, "true", { onData: () => undefined }),
			(e: Error) => {
				assert.match(e.message, /Cannot reach the Kindle/);
				assert.match(e.message, /192\.168\.15\.201/);
				return true;
			}
		);
	} finally {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((r) => silent.close(() => r()));
	}
});

test("aborting rejects and never yields a result", async () => {
	const server = await startServer({ stdout: new Uint8Array(0) });
	try {
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(
			execStreaming(
				{ ...settingsFor(server.port), kindleHost: `127.0.0.1:${server.port}` },
				"true",
				{ onData: () => undefined, signal: controller.signal }
			),
			/aborted/
		);
	} finally {
		await server.close();
	}
});

 test("password auth requires a password and preserves its bytes", () => {
 assert.throws(() => buildConnectConfig(settingsFor(22, { kindlePassword: "" })), /password/i);
 const config = buildConnectConfig(settingsFor(22, { kindlePassword: " secret " }));
 assert.equal(config.password, " secret ");
 assert.deepEqual(config.authHandler, ["password"]);
 assert.equal(config.agent, undefined);
 });

 test("an unknown host key is trusted on first use and reported", async () => {
 const server = await startServer({});
 try {
 const result = await execStreaming(settingsFor(server.port, { kindleHost: `127.0.0.1:${server.port}`, kindleHostFingerprint: "" }), "true", { onData() {} });
 assert.equal(result.trustedHostKey, fingerprint);
 const pinned = await execStreaming(settingsFor(server.port, { kindleHost: `127.0.0.1:${server.port}` }), "true", { onData() {} });
 assert.equal(pinned.trustedHostKey, undefined);
 } finally { await server.close(); }
 });

 test("a changed host key rejects before authentication and reports received fingerprint", async () => {
 const server = await startServer({});
 try {
 await assert.rejects(execStreaming(settingsFor(server.port, { kindleHost: `127.0.0.1:${server.port}`, kindleHostFingerprint: "SHA256:" + "A".repeat(43) }), "true", { onData() {} }), (e: Error) => {
 assert.ok(e.message.includes(fingerprint));
 assert.match(e.message, /clear "Kindle host fingerprint"/);
 return true;
 });
 assert.deepEqual(server.authAttempts, []);
 } finally { await server.close(); }
 });

 test("stderr is bounded and fails loudly", async () => {
 const server = await startServer({ stderr: "x".repeat(128 * 1024) });
 try {
 await assert.rejects(execStreaming(settingsFor(server.port, { kindleHost: `127.0.0.1:${server.port}` }), "true", { onData() {} }), /stderr.*limit/i);
 } finally { await server.close(); }
 });
