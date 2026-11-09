// Unit tests with a fake fetch: request encoding, response parsing, error mapping, retry
// decisions and names on disk. Needs `npm run build` first.

import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { inspect } from "node:util";
import * as sdk from "../dist/index.js";

const { PdfConversionApi, UploadFile } = sdk;
const here = dirname(fileURLToPath(import.meta.url));
const KEY = "sk-unit-test-secret-0123456789";
const BASE = "https://api.example.test";
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const temps = [];
async function tempDir() {
	const dir = await mkdtemp(join(tmpdir(), "pdfconversionapi-unit-"));
	temps.push(dir);
	return dir;
}
after(async () => {
	for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

const b64 = (text) => Buffer.from(text).toString("base64");

function json(status, body, headers = {}) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", "x-request-id": "req-1", ...headers },
	});
}

function ok(files = [{ FileName: "out.pdf", FileExt: "pdf", FileSize: 5, FileData: b64("hello") }]) {
	return json(200, { ConversionCost: 1, ConversionTime: 0.25, Files: files });
}

function apiError(status, message, headers = {}) {
	return json(status, { Code: status, Message: message }, headers);
}

/** A fetch that answers from a list (the last entry repeats) and records each call. */
function fakeFetch(...answers) {
	const calls = [];
	const fn = async (url, init) => {
		// Read the body now, as a real fetch would during the attempt.
		if (init.body) init = { ...init, body: new Blob([await init.body.arrayBuffer()]) };
		calls.push({ url, init });
		const answer = answers[Math.min(calls.length - 1, answers.length - 1)];
		return typeof answer === "function" ? answer(url, init) : answer.clone();
	};
	fn.calls = calls;
	return fn;
}

function client(fetch, options = {}) {
	const sleeps = [];
	const api = new PdfConversionApi({
		apiKey: KEY,
		baseUrl: BASE,
		fetch,
		sleep: async (ms) => {
			sleeps.push(ms / 1000);
		},
		...options,
	});
	return { api, sleeps };
}

/** Parses a multipart body we sent: [{ headers, name, filename, data, text }]. */
async function parts(init) {
	const contentType = init.headers["Content-Type"];
	const boundary = /boundary=(.+)$/.exec(contentType)[1];
	const body = new Uint8Array(await init.body.arrayBuffer());
	const text = Buffer.from(body).toString("latin1");
	const sections = text.split(`--${boundary}`);
	assert.equal(sections.at(-1), "--\r\n", "closing boundary");
	return sections.slice(1, -1).map((section) => {
		assert.ok(section.startsWith("\r\n") && section.endsWith("\r\n"));
		const raw = section.slice(2, -2);
		const split = raw.indexOf("\r\n\r\n");
		const headerText = Buffer.from(raw.slice(0, split), "latin1").toString("utf8");
		const data = Buffer.from(raw.slice(split + 4), "latin1");
		const disposition = /Content-Disposition: (.*)/.exec(headerText)[1];
		return {
			headers: headerText,
			name: /name="([^"]*)"/.exec(disposition)[1],
			filename: /filename="([^"]*)"/.exec(disposition)?.[1] ?? null,
			data: new Uint8Array(data),
			text: data.toString("utf8"),
		};
	});
}

async function rejection(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail("expected a rejection");
}

describe("request encoding", () => {
	test("headers, URL and the File field", async () => {
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		await api.convert("DOCX", "Pdf", UploadFile.fromBytes(encoder.encode("abc"), "report.docx"));
		const { url, init } = fetch.calls[0];
		assert.equal(url, `${BASE}/v2/convert/docx/to/pdf`);
		assert.equal(init.method, "POST");
		assert.equal(init.redirect, "manual");
		assert.equal(init.headers.Authorization, `Bearer ${KEY}`);
		assert.equal(init.headers.Accept, "application/json");
		assert.match(init.headers["User-Agent"], /^pdfconversionapi-node\/0\.1\.0 node\/\d+\.\d+\.\d+$/);
		assert.match(init.headers["Content-Type"], /^multipart\/form-data; boundary=----pdfconversionapi-[0-9a-f]{32}$/);
		const [part] = await parts(init);
		assert.equal(part.name, "File");
		assert.equal(part.filename, "report.docx");
		assert.match(part.headers, /Content-Type: application\/octet-stream/);
		assert.equal(part.text, "abc");
	});

	test("file names: raw UTF-8, quotes and line breaks as _, folders dropped", async () => {
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		await api.convert("pdf", "merge", [
			UploadFile.fromBytes(encoder.encode("1"), 'Résumé "final"\r\n(1).txt'),
			UploadFile.fromBytes(encoder.encode("2"), "C:\\Users\\me\\a.txt"),
			UploadFile.fromBytes(encoder.encode("3"), "../../etc/passwd"),
			encoder.encode("4"),
			UploadFile.fromBytes(encoder.encode("5"), "dir/"),
		]);
		const sent = await parts(fetch.calls[0].init);
		assert.deepEqual(
			sent.map((p) => [p.name, p.filename]),
			[
				["Files", "Résumé _final___(1).txt"],
				["Files", "a.txt"],
				["Files", "passwd"],
				["Files", "file"],
				["Files", "file"],
			],
		);
		assert.ok(!sent[0].headers.includes("filename*"), "no filename*");
	});

	test("parameters: plain decimals, booleans, text as given, null left out, order kept", async () => {
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		await api.convert("txt", "pdf", encoder.encode("x"), {
			A: 72,
			B: 1.5,
			C: 1e21,
			D: 1e-7,
			E: -0,
			F: -2.5e-8,
			G: 12345678901234567890n,
			H: true,
			I: false,
			J: "line 1\nline 2",
			K: null,
			L: undefined,
			M: "",
		});
		const sent = await parts(fetch.calls[0].init);
		assert.deepEqual(
			sent.slice(1).map((p) => [p.name, p.text]),
			[
				["A", "72"],
				["B", "1.5"],
				["C", "1000000000000000000000"],
				["D", "0.0000001"],
				["E", "0"],
				["F", "-0.000000025"],
				["G", "12345678901234567890"],
				["H", "true"],
				["I", "false"],
				["J", "line 1\nline 2"],
				["M", ""],
			],
		);
	});

	test("bad parameter values are TypeError or RangeError, before sending", async () => {
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		const file = encoder.encode("x");
		assert.ok((await rejection(api.convert("txt", "pdf", file, { A: Number.NaN }))) instanceof RangeError);
		assert.ok(
			(await rejection(api.convert("txt", "pdf", file, { A: Number.POSITIVE_INFINITY }))) instanceof RangeError,
		);
		assert.ok((await rejection(api.convert("txt", "pdf", file, { A: [1, 2] }))) instanceof TypeError);
		assert.ok((await rejection(api.convert("txt", "pdf", file, { A: { b: 1 } }))) instanceof TypeError);
		assert.ok((await rejection(api.convert("txt", "pdf", file, { A: new Date() }))) instanceof TypeError);
		assert.ok((await rejection(api.convert("txt", "pdf", file, "params"))) instanceof TypeError);
		assert.equal(fetch.calls.length, 0);
	});

	test("typed options win over FileName and StoreFile in params, in any case", async () => {
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		await api.convert(
			"txt",
			"pdf",
			encoder.encode("x"),
			{ filename: "from-params", STOREFILE: true, Other: 1 },
			{ fileName: "typed", storeFile: false },
		);
		const sent = await parts(fetch.calls[0].init);
		assert.deepEqual(
			sent.slice(1).map((p) => [p.name, p.text]),
			[
				["Other", "1"],
				["FileName", "typed"],
			],
		);
	});

	test("named file fields from params; strings in params are text", async () => {
		const dir = await tempDir();
		const logo = join(dir, "logo.png");
		await writeFile(logo, "PNG");
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		await api.convert("pdf", "image-watermark", encoder.encode("%PDF"), {
			ImageFile: UploadFile.fromPath(logo),
			OverlayFile: pathToFileURL(logo),
			Text: logo,
		});
		const sent = await parts(fetch.calls[0].init);
		assert.deepEqual(
			sent.map((p) => [p.name, p.filename, p.text]),
			[
				["File", "file", "%PDF"],
				["ImageFile", "logo.png", "PNG"],
				["OverlayFile", "logo.png", "PNG"],
				["Text", null, logo],
			],
		);
	});

	test("no files: omitted, null or empty sends no file field", async () => {
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		await api.convert("data", "qrcode", { Data: "hello" });
		await api.convert("data", "qrcode", { Data: "hello" }, { fileName: "code" });
		await api.convert("data", "qrcode", null, { Data: "hello" });
		await api.convert("data", "qrcode", [], { Data: "hello" });
		await api.convert("data", "qrcode");
		const sent = await Promise.all(fetch.calls.map((call) => parts(call.init)));
		assert.deepEqual(
			sent.map((list) => list.map((p) => `${p.name}=${p.text}`)),
			[["Data=hello"], ["Data=hello", "FileName=code"], ["Data=hello"], ["Data=hello"], []],
		);
	});

	test("every input form", async () => {
		const dir = await tempDir();
		const path = join(dir, "from-path.txt");
		await writeFile(path, "path");
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		const buffer = Buffer.from("xxsubarrayxx");
		async function* generator() {
			yield "gen";
			yield encoder.encode("-bytes");
		}
		const inputs = [
			path,
			pathToFileURL(path),
			UploadFile.fromPath(path, "renamed.txt"),
			encoder.encode("u8"),
			buffer.subarray(2, 10),
			encoder.encode("ab").buffer,
			new Blob(["blob"]),
			UploadFile.fromBlob(new Blob(["named blob"]), "blob.txt"),
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode("web "));
					controller.enqueue(encoder.encode("stream"));
					controller.close();
				},
			}),
			generator(),
			createReadStream(path),
			UploadFile.fromStream(createReadStream(path), "stream.txt"),
		];
		await api.convert("pdf", "merge", inputs);
		const sent = await parts(fetch.calls[0].init);
		assert.deepEqual(
			sent.map((p) => [p.filename, p.text]),
			[
				["from-path.txt", "path"],
				["from-path.txt", "path"],
				["renamed.txt", "path"],
				["file", "u8"],
				["file", "subarray"],
				["file", "ab"],
				["file", "blob"],
				["blob.txt", "named blob"],
				["file", "web stream"],
				["file", "gen-bytes"],
				["from-path.txt", "path"],
				["stream.txt", "path"],
			],
		);
	});

	test("a File keeps its own name", { skip: typeof File === "undefined" && "no global File (Node 18)" }, async () => {
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		await api.convert("txt", "pdf", new File(["f"], "own-name.txt"));
		const [part] = await parts(fetch.calls[0].init);
		assert.equal(part.filename, "own-name.txt");
	});

	test("unsupported inputs and URLs other than file: are rejected", async () => {
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		assert.ok((await rejection(api.convert("txt", "pdf", 42))) instanceof TypeError);
		assert.ok((await rejection(api.convert("txt", "pdf", new URL("https://example.com/a.pdf")))) instanceof TypeError);
		assert.ok((await rejection(api.convert("txt", "pdf", [encoder.encode("a"), {}]))) instanceof TypeError);
		assert.ok((await rejection(api.convert("txt", "pdf", ""))) instanceof RangeError);
		assert.throws(() => UploadFile.fromBytes("text"), TypeError);
		assert.throws(() => UploadFile.fromStream("text"), TypeError);
		assert.equal(fetch.calls.length, 0);
	});

	test("a missing path fails before anything is sent", async () => {
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		const error = await rejection(api.convert("txt", "pdf", join(here, "no-such-file.txt")));
		assert.equal(error.code, "ENOENT");
		assert.equal(fetch.calls.length, 0);
	});

	test("a path is read again for each attempt; a stream is read once", async () => {
		const dir = await tempDir();
		const path = join(dir, "changing.txt");
		await writeFile(path, "first");
		const fetch = fakeFetch(apiError(503, "busy", { "retry-after": "1" }), ok());
		const api = new PdfConversionApi({
			apiKey: KEY,
			baseUrl: BASE,
			fetch,
			sleep: async () => {
				await writeFile(path, "second");
			},
		});
		const stream = UploadFile.fromStream(createReadStream(path), "s.txt");
		await api.convert("pdf", "merge", [path, stream]);
		const first = await parts(fetch.calls[0].init);
		const second = await parts(fetch.calls[1].init);
		assert.deepEqual(
			first.map((p) => p.text),
			["first", "first"],
		);
		assert.deepEqual(
			second.map((p) => p.text),
			["second", "first"],
		);
		// The UploadFile kept the stream's bytes, so it can be used again.
		await api.convert("txt", "pdf", stream);
		assert.equal((await parts(fetch.calls[2].init))[0].text, "first");
	});
});

describe("responses", () => {
	test("result fields and base64 decoding (every padding length)", async () => {
		const files = ["", "a", "ab", "abc", "abcd", "\u0000\u00ff binary"].map((text, i) => ({
			FileName: `f${i}.bin`,
			FileExt: "bin",
			FileSize: Buffer.byteLength(text),
			FileData: b64(text),
		}));
		const { api } = client(fakeFetch(ok(files)));
		const result = await api.convert("txt", "pdf", encoder.encode("x"));
		assert.equal(result.conversionCost, 1);
		assert.equal(result.conversionTime, 0.25);
		assert.equal(result.requestId, "req-1");
		assert.equal(result.file, result.files[0]);
		assert.deepEqual(
			result.files.map((f) => decoder.decode(f.data)),
			["", "a", "ab", "abc", "abcd", "\u0000\u00ff binary"],
		);
		assert.deepEqual(result.files[5].bytes(), new Uint8Array(Buffer.from("\u0000\u00ff binary")));
		assert.equal(result.files[1].stored, false);
		assert.equal(result.files[1].url, null);
		assert.equal(result.files[1].fileId, null);
		assert.deepEqual(await result.files[2].download(), encoder.encode("ab"));
	});

	test("unusable 200 responses are InvalidResponseError", async () => {
		const bad = [
			new Response("{not json", { status: 200, headers: { "x-request-id": "r" } }),
			json(200, { Files: [] }),
			json(200, { NoFiles: true }),
			json(200, [1, 2]),
			ok([{ FileName: "a", FileExt: "pdf", FileSize: 3, FileData: "YWJj=" }]),
			ok([{ FileName: "a", FileExt: "pdf", FileSize: 3, FileData: "YW Jj" }]),
			ok([{ FileName: "a", FileExt: "pdf", FileSize: 3, FileData: "YW=j" }]),
			ok([{ FileName: "a", FileExt: "pdf", FileSize: 3, FileData: "YWJ\u00e9" }]),
			ok([{ FileName: "a", FileExt: "pdf", FileSize: 4, FileData: b64("abc") }]),
			ok([{ FileName: "a", FileExt: "pdf", FileData: b64("abc") }]),
			ok([{ FileExt: "pdf", FileSize: 3, FileData: b64("abc") }]),
			ok([{ FileName: "a", FileExt: "pdf", FileSize: 3 }]),
		];
		for (const response of bad) {
			const { api } = client(fakeFetch(response));
			const error = await rejection(api.convert("txt", "pdf", encoder.encode("x")));
			assert.ok(error instanceof sdk.InvalidResponseError, `${error}`);
			assert.ok(error instanceof sdk.PdfConversionApiError);
		}
	});

	test("usage, with remaining null", async () => {
		const fetch = fakeFetch(
			json(200, {
				Plan: "Pro",
				Included: 5000,
				Used: 10,
				Remaining: null,
				Overage: false,
				Running: 1,
				ConcurrentLimit: 4,
				MaxUploadMB: 100,
				PeriodStart: "2026-11-01T00:00:00.000Z",
				PeriodEnd: "2026-12-01T00:00:00.000Z",
			}),
		);
		const { api } = client(fetch);
		const usage = await api.usage();
		assert.equal(usage.remaining, null);
		assert.equal(usage.maxUploadMb, 100);
		assert.equal(usage.periodEnd.toISOString(), "2026-12-01T00:00:00.000Z");
		assert.equal(fetch.calls[0].url, `${BASE}/v2/usage`);
		assert.equal(fetch.calls[0].init.headers.Authorization, `Bearer ${KEY}`);
	});

	test("conversions() sends no key; downloads send no key and no JSON Accept", async () => {
		const fetch = fakeFetch(
			json(200, [{ From: "docx", To: "pdf", Title: "DOCX to PDF", Category: "Document", Inputs: "one" }]),
			new Response("file bytes", { status: 200 }),
		);
		const { api } = client(fetch);
		assert.deepEqual(await api.conversions(), [
			{ from: "docx", to: "pdf", title: "DOCX to PDF", category: "Document", inputs: "one" },
		]);
		assert.deepEqual(await api.download("https://files.example.test/v2/d/abc/x.pdf"), encoder.encode("file bytes"));
		for (const { init } of fetch.calls) assert.equal(init.headers.Authorization, undefined);
		assert.equal(fetch.calls[1].init.headers.Accept, undefined);
		assert.equal(fetch.calls[1].init.redirect, "manual");
	});

	test("deleteStoredFile: 204 true, 404 false, other errors thrown, bad ids refused", async () => {
		const id = "0123456789abcdef0123456789ABCDEF";
		const fetch = fakeFetch(
			new Response(null, { status: 204 }),
			apiError(404, "not found"),
			apiError(401, "a valid API key is required"),
		);
		const { api } = client(fetch);
		assert.equal(await api.deleteStoredFile(id), true);
		assert.equal(fetch.calls[0].init.method, "DELETE");
		assert.equal(fetch.calls[0].url, `${BASE}/v2/d/${id}`);
		assert.equal(await api.deleteStoredFile(id), false);
		assert.ok((await rejection(api.deleteStoredFile(id))) instanceof sdk.AuthenticationError);
		for (const bad of ["", "abc", `${id}0`, "../../v2/usage/00000000000000000", 42]) {
			assert.ok((await rejection(api.deleteStoredFile(bad))) instanceof RangeError);
		}
		assert.equal(fetch.calls.length, 3);
	});
});

describe("errors", () => {
	const cases = [
		[400, "BadRequestError"],
		[401, "AuthenticationError"],
		[403, "PermissionDeniedError"],
		[404, "NotFoundError"],
		[413, "PayloadTooLargeError"],
		[422, "UnprocessableEntityError"],
		[429, "RateLimitError"],
		[500, "InternalServerError"],
		[503, "ServiceUnavailableError"],
		[504, "GatewayTimeoutError"],
		[402, "ApiError"],
		[302, "ApiError"],
	];
	for (const [status, name] of cases) {
		test(`${status} is ${name}`, async () => {
			const { api } = client(fakeFetch(apiError(status, `message ${status}`, { "retry-after": "999" })), {
				maxRetries: 0,
			});
			const error = await rejection(api.convert("txt", "pdf", encoder.encode("x")));
			assert.ok(error instanceof sdk[name]);
			assert.ok(error instanceof sdk.ApiError);
			assert.equal(error.name, name);
			assert.equal(error.status, status);
			assert.equal(error.message, `message ${status}`);
			assert.equal(error.requestId, "req-1");
			assert.equal(error.retryAfter, 999);
			assert.equal(String(error), `${name}: HTTP ${status}: message ${status} (request id: req-1)`);
			assert.ok(error.stack.startsWith(`${name}: HTTP ${status}: message ${status} (request id: req-1)\n`));
		});
	}

	test("messages of bodies that aren't our JSON", async () => {
		const long = "x".repeat(1001);
		const bodies = [
			[new Response("", { status: 504, headers: { "content-type": "application/json" } }), "empty response"],
			[new Response("  \n", { status: 502 }), "empty response"],
			[
				new Response("  plain words \n", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } }),
				"plain words",
			],
			[
				new Response(long, { status: 400, headers: { "content-type": "text/plain" } }),
				"non-JSON response (text/plain)",
			],
			[
				new Response("<html></html>", { status: 502, headers: { "content-type": "text/html; charset=UTF-8" } }),
				"non-JSON response (text/html)",
			],
			[new Response(encoder.encode("<html></html>"), { status: 520 }), "non-JSON response (no content type)"],
			[json(500, { Code: 500 }), "non-JSON response (application/json)"],
		];
		for (const [response, message] of bodies) {
			const { api } = client(fakeFetch(response), { maxRetries: 0 });
			const error = await rejection(api.convert("txt", "pdf", encoder.encode("x")));
			assert.ok(error instanceof sdk.ApiError);
			assert.equal(error.message, message);
			assert.equal(error.requestId, response.headers.get("x-request-id"));
			assert.equal(typeof error.body, "string");
			assert.ok(!Object.keys(error).includes("body"), "body is not enumerable");
		}
	});

	test("without a request id the string form has none", async () => {
		const { api } = client(
			fakeFetch(new Response("<html>", { status: 413, headers: { "content-type": "text/html" } })),
		);
		const error = await rejection(api.convert("txt", "pdf", encoder.encode("x")));
		assert.equal(error.requestId, null);
		assert.equal(String(error), "PayloadTooLargeError: HTTP 413: non-JSON response (text/html)");
	});

	test("the key never appears in errors or in the client", async () => {
		const errors = [];
		const { api } = client(fakeFetch(apiError(401, "a valid API key is required")));
		errors.push(await rejection(api.convert("txt", "pdf", encoder.encode("x"))));
		const failing = client(async () => {
			throw new TypeError("fetch failed", { cause: new Error("connect ECONNREFUSED") });
		}).api;
		errors.push(await rejection(failing.convert("txt", "pdf", encoder.encode("x"))));
		for (const error of errors) {
			for (const text of [error.message, String(error), error.stack, inspect(error, { depth: 5 })]) {
				assert.ok(!text.includes(KEY));
			}
		}
		for (const text of [inspect(api, { depth: 10, showHidden: true }), JSON.stringify(api), String(api)]) {
			assert.ok(!text.includes(KEY));
		}
	});

	test("no key: MissingApiKeyError before sending; the environment is read", async () => {
		const saved = process.env.PDFCONVERSIONAPI_KEY;
		try {
			delete process.env.PDFCONVERSIONAPI_KEY;
			const fetch = fakeFetch(ok());
			const api = new PdfConversionApi({ baseUrl: BASE, fetch });
			for (const call of [
				() => api.convert("txt", "pdf", encoder.encode("x")),
				() => api.usage(),
				() => api.deleteStoredFile("0".repeat(32)),
			]) {
				const error = await rejection(call());
				assert.ok(error instanceof sdk.MissingApiKeyError);
				assert.ok(error.message.includes("PDFCONVERSIONAPI_KEY"));
			}
			assert.equal(fetch.calls.length, 0);
			process.env.PDFCONVERSIONAPI_KEY = "from-env";
			await new PdfConversionApi({ baseUrl: BASE, fetch }).convert("txt", "pdf", encoder.encode("x"));
			assert.equal(fetch.calls[0].init.headers.Authorization, "Bearer from-env");
		} finally {
			if (saved === undefined) delete process.env.PDFCONVERSIONAPI_KEY;
			else process.env.PDFCONVERSIONAPI_KEY = saved;
		}
	});
});

describe("retries", () => {
	test("429 and 503 wait Retry-After plus jitter; missing or unreadable means 1", async () => {
		const fetch = fakeFetch(
			apiError(429, "slow down", { "retry-after": "5" }),
			apiError(503, "busy"),
			apiError(503, "busy", { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
			ok(),
		);
		const { api, sleeps } = client(fetch);
		await api.convert("txt", "pdf", encoder.encode("x"));
		assert.equal(fetch.calls.length, 4);
		const bounds = [
			[5, 5 + 2],
			[1, 1 + 4],
			[1, 1 + 8],
		];
		assert.equal(sleeps.length, 3);
		for (const [i, [min, max]] of bounds.entries()) assert.ok(sleeps[i] >= min && sleeps[i] < max, `${sleeps[i]}`);
	});

	test("a Retry-After above maxRetryWait is thrown at once with retryAfter", async () => {
		const fetch = fakeFetch(apiError(429, "used up", { "retry-after": "61" }));
		const { api, sleeps } = client(fetch);
		const error = await rejection(api.convert("txt", "pdf", encoder.encode("x")));
		assert.ok(error instanceof sdk.RateLimitError);
		assert.equal(error.retryAfter, 61);
		assert.equal(fetch.calls.length, 1);
		assert.equal(sleeps.length, 0);
		const lenient = client(fakeFetch(apiError(429, "used up", { "retry-after": "61" }), ok()), {
			maxRetryWait: 61_000,
		});
		await lenient.api.convert("txt", "pdf", encoder.encode("x"));
		assert.equal(lenient.sleeps.length, 1);
	});

	test("500 is retried once per call; a second 500 is thrown", async () => {
		const fetch = fakeFetch(
			apiError(500, "internal error"),
			apiError(503, "busy", { "retry-after": "1" }),
			apiError(500, "again"),
		);
		const { api, sleeps } = client(fetch);
		const error = await rejection(api.convert("txt", "pdf", encoder.encode("x")));
		assert.ok(error instanceof sdk.InternalServerError);
		assert.equal(error.message, "again");
		assert.equal(fetch.calls.length, 3);
		assert.ok(sleeps[0] >= 1 && sleeps[0] < 3);
	});

	test("400, 401, 403, 404, 413, 422 and 504 are never retried", async () => {
		for (const status of [400, 401, 403, 404, 413, 422, 504]) {
			const fetch = fakeFetch(apiError(status, "no"), ok());
			const { api } = client(fetch);
			await rejection(api.convert("txt", "pdf", encoder.encode("x")));
			assert.equal(fetch.calls.length, 1, `${status}`);
		}
	});

	test("no response is retried with jitter, then ConnectionError", async () => {
		const failure = async () => {
			throw new TypeError("fetch failed", { cause: new Error("read ECONNRESET") });
		};
		const { api, sleeps } = client(fakeFetch(failure), { maxRetries: 2 });
		const error = await rejection(api.convert("txt", "pdf", encoder.encode("x")));
		assert.ok(error instanceof sdk.ConnectionError);
		assert.equal(error.attempts, 3);
		assert.match(
			error.message,
			/^no response from api\.example\.test after 3 attempts \(fetch failed: read ECONNRESET\)$/,
		);
		assert.ok(error.cause instanceof TypeError);
		assert.equal(sleeps.length, 2);
		assert.ok(sleeps[0] < 2 && sleeps[1] < 4);
	});

	test("a failure after the status line is ConnectionError at once, not retried", async () => {
		const truncated = () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode('{"Files":[{"FileName":"a.pdf"'));
						controller.error(new TypeError("terminated"));
					},
				}),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		const fetch = fakeFetch(truncated, ok());
		const { api } = client(fetch);
		const error = await rejection(api.convert("txt", "pdf", encoder.encode("x")));
		assert.ok(error instanceof sdk.ConnectionError);
		assert.match(error.message, /while reading the response/);
		assert.equal(fetch.calls.length, 1);
	});

	test("the client timeout is TimeoutError, never retried; per-call timeout wins", async () => {
		const hang = (_url, init) =>
			new Promise((_resolve, reject) => {
				init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		const fetch = fakeFetch(hang);
		const { api } = client(fetch, { timeout: 30 });
		const error = await rejection(api.convert("txt", "pdf", encoder.encode("x")));
		assert.ok(error instanceof sdk.TimeoutError);
		assert.equal(error.timeout, 30);
		assert.match(error.message, /may still be running/);
		assert.equal(fetch.calls.length, 1);
		const started = Date.now();
		const perCall = await rejection(api.conversions({ timeout: 10 }));
		assert.ok(perCall instanceof sdk.TimeoutError);
		assert.equal(perCall.timeout, 10);
		assert.ok(Date.now() - started < 1000);
	});

	test("an abort signal cancels the call and the wait between retries", async () => {
		const controller = new AbortController();
		const fetch = fakeFetch(apiError(503, "busy", { "retry-after": "30" }));
		const api = new PdfConversionApi({ apiKey: KEY, baseUrl: BASE, fetch });
		const pending = api.convert("txt", "pdf", encoder.encode("x"), {}, { signal: controller.signal });
		setTimeout(() => controller.abort(), 20);
		const error = await rejection(pending);
		assert.equal(error.name, "AbortError");
		assert.equal(fetch.calls.length, 1);
		const already = await rejection(api.usage({ signal: AbortSignal.abort() }));
		assert.equal(already.name, "AbortError");
	});

	test("downloads go through the same loop", async () => {
		const fetch = fakeFetch(apiError(503, "busy", { "retry-after": "1" }), new Response("bytes", { status: 200 }));
		const { api, sleeps } = client(fetch);
		assert.deepEqual(await api.download("https://files.example.test/v2/d/x/y.pdf"), encoder.encode("bytes"));
		assert.equal(sleeps.length, 1);
	});
});

describe("files on disk", () => {
	const stored = (name) => ({
		FileName: name,
		FileExt: "pdf",
		FileSize: 6,
		Url: `https://files.example.test/v2/d/${"a".repeat(32)}/${encodeURIComponent(name)}`,
		FileId: "a".repeat(32),
	});

	test("saveAll uses only each file's own name and refuses . and ..", async () => {
		const dir = await tempDir();
		const files = [
			{ FileName: "../escape.pdf", FileExt: "pdf", FileSize: 1, FileData: b64("1") },
			{ FileName: "a\\b\\inner.pdf", FileExt: "pdf", FileSize: 1, FileData: b64("2") },
		];
		const { api } = client(fakeFetch(ok(files)));
		const result = await api.convert("txt", "pdf", encoder.encode("x"));
		const out = join(dir, "deep", "out");
		const written = await result.saveAll(out);
		assert.deepEqual(written, [join(out, "escape.pdf"), join(out, "inner.pdf")]);
		assert.deepEqual((await readdir(out)).sort(), ["escape.pdf", "inner.pdf"]);
		assert.deepEqual((await readdir(join(dir, "deep"))).sort(), ["out"]);
		for (const name of ["..", ".", "", "dir/..", "x/"]) {
			const bad = client(fakeFetch(ok([{ FileName: name, FileExt: "pdf", FileSize: 0, FileData: "" }])));
			const res = await bad.api.convert("txt", "pdf", encoder.encode("x"));
			const error = await rejection(res.saveAll(join(dir, "bad")));
			assert.ok(error instanceof sdk.InvalidResponseError, `${JSON.stringify(name)}: ${error}`);
		}
	});

	test("save() writes inside an existing folder, or to the exact path; overwrites", async () => {
		const dir = await tempDir();
		const { api } = client(
			fakeFetch(ok([{ FileName: "report.pdf", FileExt: "pdf", FileSize: 3, FileData: b64("new") }])),
		);
		const result = await api.convert("txt", "pdf", encoder.encode("x"));
		assert.equal(await result.file.save(dir), join(dir, "report.pdf"));
		await writeFile(join(dir, "exact.pdf"), "old content");
		assert.equal(await result.file.save(join(dir, "exact.pdf")), join(dir, "exact.pdf"));
		assert.equal(await readFile(join(dir, "exact.pdf"), "utf8"), "new");
		assert.equal(await result.file.downloadTo(join(dir, "to.pdf")), join(dir, "to.pdf"));
		assert.equal(await readFile(join(dir, "to.pdf"), "utf8"), "new");
	});

	test("stored files: data throws, save and saveAll download without the key", async () => {
		const dir = await tempDir();
		const fetch = fakeFetch(ok([stored("report.pdf")]), new Response("stored", { status: 200 }));
		const { api } = client(fetch);
		const result = await api.convert("txt", "pdf", encoder.encode("x"), {}, { storeFile: true });
		const file = result.file;
		assert.equal(file.stored, true);
		assert.throws(() => file.data, sdk.StoredFileError);
		assert.throws(() => file.bytes(), /call download\(\) or save\(\)/);
		assert.deepEqual(await result.saveAll(dir), [join(dir, "report.pdf")]);
		assert.equal(await readFile(join(dir, "report.pdf"), "utf8"), "stored");
		assert.equal(fetch.calls[1].url, file.url);
		assert.equal(fetch.calls[1].init.headers.Authorization, undefined);
		const sent = await parts(fetch.calls[0].init);
		assert.deepEqual(sent.at(-1).name, "StoreFile");
		assert.deepEqual(sent.at(-1).text, "true");
	});

	test("a failed download leaves no partial file and keeps the old one", async () => {
		const dir = await tempDir();
		const target = join(dir, "kept.pdf");
		await writeFile(target, "old");
		const broken = () =>
			new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode("par"));
						controller.error(new TypeError("terminated"));
					},
				}),
				{ status: 200 },
			);
		const { api } = client(fakeFetch(broken));
		const error = await rejection(api.downloadTo("https://files.example.test/v2/d/a/kept.pdf", target));
		assert.ok(error instanceof sdk.ConnectionError);
		assert.deepEqual(await readdir(dir), ["kept.pdf"]);
		assert.equal(await readFile(target, "utf8"), "old");
		const missing = await rejection(api.downloadTo("https://files.example.test/x", join(dir, "nope", "x.pdf")));
		assert.ok(!(missing instanceof sdk.PdfConversionApiError), "a filesystem error is passed through");
	});
});

describe("client options and arguments", () => {
	test("base URL: trailing slashes ignored, environment variable, validation", async () => {
		const fetch = fakeFetch(ok());
		await new PdfConversionApi({ apiKey: KEY, baseUrl: `${BASE}//`, fetch }).convert("txt", "pdf", encoder.encode("x"));
		assert.equal(fetch.calls[0].url, `${BASE}/v2/convert/txt/to/pdf`);
		const saved = process.env.PDFCONVERSIONAPI_BASE_URL;
		try {
			process.env.PDFCONVERSIONAPI_BASE_URL = "http://127.0.0.1:9/";
			assert.equal(new PdfConversionApi({ apiKey: KEY }).baseUrl, "http://127.0.0.1:9");
			delete process.env.PDFCONVERSIONAPI_BASE_URL;
			assert.equal(new PdfConversionApi({ apiKey: KEY }).baseUrl, "https://api.pdfconversionapi.com");
		} finally {
			if (saved === undefined) delete process.env.PDFCONVERSIONAPI_BASE_URL;
			else process.env.PDFCONVERSIONAPI_BASE_URL = saved;
		}
		for (const bad of ["not a url", "ftp://example.com", "https://example.com/?q=1"]) {
			assert.throws(() => new PdfConversionApi({ baseUrl: bad }), TypeError);
		}
	});

	test("option validation", () => {
		assert.throws(() => new PdfConversionApi({ timeout: 0 }), RangeError);
		assert.throws(() => new PdfConversionApi({ timeout: Number.POSITIVE_INFINITY }), RangeError);
		assert.throws(() => new PdfConversionApi({ maxRetries: -1 }), RangeError);
		assert.throws(() => new PdfConversionApi({ maxRetries: 1.5 }), RangeError);
		assert.throws(() => new PdfConversionApi({ maxRetryWait: -1 }), RangeError);
		assert.throws(() => new PdfConversionApi({ fetch: "fetch" }), TypeError);
		assert.throws(() => new PdfConversionApi({ apiKey: 42 }), TypeError);
	});

	test("formats are validated and lower-cased", async () => {
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		for (const bad of ["", "../etc", "a".repeat(21), "pdf?x=1", "pd f", "pdf/"]) {
			assert.ok((await rejection(api.convert(bad, "pdf", encoder.encode("x")))) instanceof RangeError, bad);
			assert.ok((await rejection(api.convert("pdf", bad, encoder.encode("x")))) instanceof RangeError, bad);
		}
		assert.ok((await rejection(api.convert(1, "pdf", encoder.encode("x")))) instanceof TypeError);
		await api.convert("Image-Watermark", "A".repeat(20), encoder.encode("x"));
		assert.equal(fetch.calls.length, 1);
		assert.equal(fetch.calls[0].url, `${BASE}/v2/convert/image-watermark/to/${"a".repeat(20)}`);
	});

	test("convertFile reads the format from the extension", async () => {
		const dir = await tempDir();
		await mkdir(join(dir, "a.b"));
		const path = join(dir, "a.b", "Report.Final.DOCX");
		await writeFile(path, "docx");
		const fetch = fakeFetch(ok());
		const { api } = client(fetch);
		await api.convertFile(path, "pdf");
		await api.convertFile(pathToFileURL(path), "pdf", { PageRange: "1" }, { fileName: "x" });
		assert.equal(fetch.calls[0].url, `${BASE}/v2/convert/docx/to/pdf`);
		assert.equal(fetch.calls[1].url, `${BASE}/v2/convert/docx/to/pdf`);
		assert.equal((await parts(fetch.calls[0].init))[0].filename, "Report.Final.DOCX");
		for (const bad of [join(dir, "a.b", "noext"), join(dir, ".bashrc"), join(dir, "trailing.")]) {
			assert.ok((await rejection(api.convertFile(bad, "pdf"))) instanceof RangeError, bad);
		}
		assert.equal(fetch.calls.length, 2);
	});

	test("VERSION matches package.json", async () => {
		const pkg = JSON.parse(await readFile(join(here, "..", "package.json"), "utf8"));
		assert.equal(sdk.VERSION, pkg.version);
	});
});
