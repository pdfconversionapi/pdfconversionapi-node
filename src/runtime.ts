// What the SDK needs from its runtime, found without static imports so the package loads in
// Node.js, Bun, Deno and workerd alike. The filesystem is loaded only when a path is used.

import type * as FsModule from "node:fs";
import type * as FsPromises from "node:fs/promises";
import type * as PathModule from "node:path";
import { PdfConversionApiError } from "./errors.js";
import { VERSION } from "./version.js";

interface Globals {
	process?: {
		env?: Record<string, string | undefined>;
		versions?: { node?: string };
		getBuiltinModule?: (id: string) => unknown;
	};
	Deno?: { version?: { deno?: string }; env?: { get(name: string): string | undefined } };
	Bun?: { version?: string };
	navigator?: { userAgent?: string };
}

const g = globalThis as unknown as Globals;

/** @internal Reads an environment variable where the runtime has them; undefined otherwise. */
export function readEnv(name: string): string | undefined {
	try {
		const value = g.process?.env?.[name];
		if (typeof value === "string") return value;
	} catch {
		// no permission (Deno without --allow-env), or no environment at all
	}
	try {
		const value = g.Deno?.env?.get(name);
		if (typeof value === "string") return value;
	} catch {
		// no permission
	}
	return undefined;
}

/** @internal Running in Bun. */
export const IS_BUN = typeof g.Bun?.version === "string";

/** @internal Running in Node.js itself (Bun and Deno also define process.versions.node). */
export const IS_NODE = !IS_BUN && g.Deno === undefined && typeof g.process?.versions?.node === "string";

/** @internal `<runtime>/<version>` for the User-Agent header. */
export function runtimeToken(): string {
	if (typeof g.Bun?.version === "string") return `bun/${g.Bun.version}`;
	if (typeof g.Deno?.version?.deno === "string") return `deno/${g.Deno.version.deno}`;
	if (g.navigator?.userAgent === "Cloudflare-Workers") return "workerd/unknown";
	if (typeof g.process?.versions?.node === "string") return `node/${g.process.versions.node}`;
	return "unknown/unknown";
}

/** @internal The User-Agent the SDK sends. */
export const USER_AGENT = `pdfconversionapi-node/${VERSION} ${runtimeToken()}`;

/** @internal The parts of Node's filesystem API the SDK uses. */
export interface NodeFs {
	fs: typeof FsPromises;
	openAsBlob: ((path: string | URL) => Promise<Blob>) | undefined;
	path: typeof PathModule;
}

let nodeFs: Promise<NodeFs> | undefined;

/** @internal Loads node:fs and node:path on first use; fails with a clear message where they don't exist. */
export function loadFs(): Promise<NodeFs> {
	nodeFs ??= (async (): Promise<NodeFs> => {
		const get = g.process?.getBuiltinModule;
		let fs = typeof get === "function" ? (get("node:fs/promises") as typeof FsPromises | undefined) : undefined;
		let fsSync = typeof get === "function" ? (get("node:fs") as typeof FsModule | undefined) : undefined;
		let path = typeof get === "function" ? (get("node:path") as typeof PathModule | undefined) : undefined;
		if (!fs || !fsSync || !path) {
			// A computed specifier keeps bundlers (wrangler, esbuild, webpack) from trying to
			// resolve these modules for runtimes that don't have them.
			const id = (name: string) => `node:${name}`;
			[fs, fsSync, path] = await Promise.all([
				import(/* webpackIgnore: true */ /* @vite-ignore */ id("fs/promises")) as Promise<typeof FsPromises>,
				import(/* webpackIgnore: true */ /* @vite-ignore */ id("fs")) as Promise<typeof FsModule>,
				import(/* webpackIgnore: true */ /* @vite-ignore */ id("path")) as Promise<typeof PathModule>,
			]);
		}
		// A file-backed Blob streams large uploads without holding them in memory. Only Node.js:
		// Bun 1.3 drops the file's bytes when such a Blob is put inside another Blob.
		const openAsBlob = IS_NODE ? (fsSync as { openAsBlob?: NodeFs["openAsBlob"] }).openAsBlob : undefined;
		return { fs, path, openAsBlob: typeof openAsBlob === "function" ? openAsBlob : undefined };
	})().catch((cause: unknown) => {
		nodeFs = undefined;
		throw new PdfConversionApiError(
			"file paths need a filesystem (node:fs), which this runtime doesn't provide; pass the file's bytes, a Blob or a stream instead",
			{ cause },
		);
	});
	return nodeFs;
}

/** @internal A random hex string, from crypto.getRandomValues where available. */
export function randomHex(length: number): string {
	const bytes = new Uint8Array(Math.ceil(length / 2));
	const crypto = (globalThis as { crypto?: { getRandomValues?(array: Uint8Array): Uint8Array } }).crypto;
	if (typeof crypto?.getRandomValues === "function") {
		crypto.getRandomValues(bytes);
	} else {
		for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	}
	let out = "";
	for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
	return out.slice(0, length);
}
