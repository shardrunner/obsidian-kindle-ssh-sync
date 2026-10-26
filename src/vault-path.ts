/** Shared settings, output and recovery path policy (Linux vault-relative paths). */
export function normalizeVaultPath(p: string): string {
	if (typeof p === "string") p = p.trim();
	if (typeof p !== "string" || p.includes("\0") || p.includes("\\") || p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").some(part => part === "." || part === "..")) {
		throw new Error(`Unsafe vault-relative path: ${JSON.stringify(p)}`);
	}
	return p.replace(/\/+/g, "/").replace(/\/+$/, "");
}
