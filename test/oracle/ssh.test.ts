import { test } from "node:test";

import assert from "node:assert/strict";

import * as fs from "node:fs";

import * as path from "node:path";

import { Server } from "ssh2";
import { createHash } from "node:crypto";

import { execStreaming, SshError, SshSettings } from "../../src/device/ssh";

import { TarParser } from "../../src/device/tar";

const HOST_KEY = path.join(__dirname, "../fixtures", "ssh", "host_ed25519");

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
		kindleHostFingerprint: "SHA256:" + createHash("sha256")
			.update(Buffer.from(fs.readFileSync(HOST_KEY + ".pub", "utf8").split(" ")[1], "base64"))
			.digest("base64").replace(/=+$/, ""),
		syncTimeoutSeconds: 15,
		...over,
	} as SshSettings & { port: number };
}

test("a real tar stream survives the transport and parses end to end", async () => {
	// The whole pull path, minus the device: SSH -> chunks -> tar parser.
	const tarBytes = new Uint8Array(fs.readFileSync(path.join(__dirname, "../fixtures", "pull.tar")));
	const server = await startServer({ stdout: tarBytes });
	try {
		const names: string[] = [];
		const parser = new TarParser((e) => {
			if (e.type === "file") names.push(e.name);
		});

		await execStreaming(
			{ ...settingsFor(server.port), kindleHost: `127.0.0.1:${server.port}` },
			"tar cf - .",
			{ onData: (c) => parser.write(c) }
		);
		parser.end();

		assert.equal(names.length, 1221, "the tar stream did not survive the transport intact");
		assert.ok(names.some((n) => n.length > 100), "long paths were lost in transit");
	} finally {
		await server.close();
	}
});
