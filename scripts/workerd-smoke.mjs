// Loads the ES module build in workerd (through Miniflare, without the nodejs_compat flag) and
// runs a few calls against the mock API from inside a Worker.
//
//   node scripts/workerd-smoke.mjs
//
// Uses the `miniflare` package if it is installed (npm install --no-save miniflare), else the
// one inside a global `wrangler` install.

import { execSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMock } from "../tests/conformance-lib.mjs";

async function loadMiniflare() {
	try {
		return await import("miniflare");
	} catch {
		const root = execSync("npm root -g", { encoding: "utf8" }).trim();
		const entry = createRequire(join(root, "wrangler", "package.json")).resolve("miniflare");
		return import(pathToFileURL(entry).href);
	}
}

const worker = `
import * as sdk from "./index.js";
const { PdfConversionApi, UploadFile } = sdk;
const text = (bytes) => new TextDecoder().decode(bytes);
async function caught(promise) {
	try { await promise; return "no error"; } catch (error) { return String(error); }
}
export default {
	async fetch(request, env) {
		const sleeps = [];
		const client = new PdfConversionApi({ apiKey: "test-key", baseUrl: env.MOCK_URL, sleep: async (ms) => { sleeps.push(ms); } });
		const out = {};
		out.conversions = (await client.conversions()).length;
		const bytes = await client.convert("txt", "pdf", UploadFile.fromBytes(new TextEncoder().encode("from workerd"), "Grüße \\"w\\".txt"));
		out.bytes = [bytes.file.name, text(bytes.file.data)];
		const stream = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("web stream")); c.close(); } });
		const streamed = await client.convert("txt", "pdf", UploadFile.fromStream(stream, "s.txt"));
		out.stream = [streamed.file.name, text(streamed.file.data)];
		const echo = JSON.parse(text((await client.convert("txt", "pdf", new Blob(["b"]), { MockScenario: "echo" })).file.data));
		out.userAgent = echo.headers["user-agent"];
		out.authorization = echo.headers.authorization === "Bearer test-key";
		const stored = await client.convert("txt", "pdf", new Uint8Array([104, 105]), {}, { storeFile: true });
		out.stored = [text(await stored.file.download()), await client.deleteStoredFile(stored.file.fileId), await client.deleteStoredFile(stored.file.fileId)];
		out.retried = (await client.convert("txt", "pdf", new Uint8Array([1]), { MockScenario: "503-busy", MockFailures: 1, MockId: crypto.randomUUID() })).file.name;
		out.sleeps = sleeps.length;
		out.badRequest = await caught(client.convert("txt", "pdf", new Uint8Array([1]), { MockScenario: "400" }));
		out.timeout = await caught(new PdfConversionApi({ apiKey: "test-key", baseUrl: env.MOCK_URL, timeout: 300 }).convert("txt", "pdf", new Uint8Array([1]), { MockDelayMs: 1500 }));
		out.qrcode = text((await client.convert("data", "qrcode", { Data: "hello-workerd" })).file.data);
		out.path = await caught(client.convert("txt", "pdf", "/etc/hosts"));
		out.version = sdk.VERSION;
		return Response.json(out);
	},
};`;

const here = dirname(fileURLToPath(import.meta.url));
const { Miniflare } = await loadMiniflare();
const workerOptions = {
	name: "smoke",
	modules: [
		{ type: "ESModule", path: "worker.mjs", contents: worker },
		{ type: "ESModule", path: "index.js", contents: await readFile(join(here, "..", "dist", "index.js"), "utf8") },
	],
	compatibilityDate: "2025-09-01",
};
const mock = await startMock();
let mf;
try {
	mf = new Miniflare({ workers: [{ ...workerOptions, bindings: { MOCK_URL: mock.url } }] });
	const response = await mf.dispatchFetch("http://localhost/");
	const body = await response.text();
	if (response.status !== 200) throw new Error(`worker answered ${response.status}: ${body}`);
	const out = JSON.parse(body);
	console.log(JSON.stringify(out, null, 2));
	const checks = [
		out.conversions === 5,
		out.bytes[0] === "Grüße _w_.pdf" && out.bytes[1] === "from workerd",
		out.stream[1] === "web stream",
		out.userAgent.startsWith("pdfconversionapi-node/") && out.userAgent.includes(" workerd/"),
		out.authorization,
		out.stored.join() === "hi,true,false",
		out.retried === "file.pdf" && out.sleeps === 1,
		out.badRequest.startsWith("BadRequestError: HTTP 400: PageRange '3-1' is not valid"),
		out.timeout.startsWith("TimeoutError: the request timed out after 0.3 s"),
		out.qrcode === "hello-workerd",
		out.path.includes("file paths need a filesystem"),
	];
	const failed = checks.map((ok, i) => (ok ? null : i)).filter((i) => i !== null);
	console.log(
		failed.length ? `workerd: FAILED checks ${failed.join(", ")}` : `workerd: all ${checks.length} checks passed`,
	);
	process.exitCode = failed.length ? 1 : 0;
} finally {
	await mf?.dispose();
	await mock.stop();
}
