// The shared conformance cases (../../conformance/cases.json) run against the SDK, without a test
// framework, so the same code runs under Node.js (node:test wrapper), Bun and Deno.
//
// The suite is read from PDFCONVERSIONAPI_CONFORMANCE_DIR, else ../conformance next to this
// package (the monorepo layout), else ./conformance inside it (a standalone repository).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const conformanceDir = findConformanceDir();
export const fixturesDir = join(conformanceDir, "fixtures");

function findConformanceDir() {
	const fromEnv = process.env.PDFCONVERSIONAPI_CONFORMANCE_DIR;
	if (fromEnv) return resolve(fromEnv);
	const sibling = resolve(here, "..", "..", "conformance");
	const inside = resolve(here, "..", "conformance");
	return existsSync(join(sibling, "cases.json")) || !existsSync(join(inside, "cases.json")) ? sibling : inside;
}

export async function loadCases() {
	return JSON.parse(await readFile(join(conformanceDir, "cases.json"), "utf8"));
}

/** Starts the mock on a random port; resolves to { url, stop }. */
export function startMock() {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.env.NODE_BINARY ?? "node", [join(conformanceDir, "mock-server.mjs"), "--port", "0"], {
			stdio: ["ignore", "pipe", "inherit"],
		});
		let buffer = "";
		const onData = (chunk) => {
			buffer += chunk.toString();
			const line = buffer.split("\n")[0];
			const match = /^LISTENING (http:\/\/\S+)/.exec(line);
			if (match) {
				child.stdout.off("data", onData);
				resolvePromise({
					url: match[1],
					stop: () =>
						new Promise((done) => {
							child.once("exit", () => done());
							child.kill("SIGTERM");
						}),
				});
			}
		};
		child.stdout.on("data", onData);
		child.once("error", reject);
		child.once("exit", (code) => reject(new Error(`mock server exited early (${code})`)));
	});
}

const fixture = (name) => join(fixturesDir, name);

async function toInput(sdk, descriptor) {
	const { UploadFile } = sdk;
	if ("path" in descriptor) return fixture(descriptor.path);
	if ("bytes" in descriptor) {
		const bytes = new Uint8Array(await readFile(fixture(descriptor.bytes)));
		return descriptor.name === undefined ? bytes : UploadFile.fromBytes(bytes, descriptor.name);
	}
	if ("stream" in descriptor) {
		return UploadFile.fromStream(createReadStream(fixture(descriptor.stream)), descriptor.name);
	}
	if ("bytes_utf8" in descriptor) {
		return UploadFile.fromBytes(new TextEncoder().encode(descriptor.bytes_utf8), descriptor.name);
	}
	throw new Error(`unknown file descriptor ${JSON.stringify(descriptor)}`);
}

/** A params value that is a descriptor is a named file; a path one goes through UploadFile, since a string is text. */
async function toParam(sdk, value) {
	if (value === null || typeof value !== "object") return value;
	const input = await toInput(sdk, value);
	return typeof input === "string" ? sdk.UploadFile.fromPath(input) : input;
}

function checkType(sdk, error, type) {
	if (type === "ArgumentError") {
		assert.ok(
			error instanceof TypeError || error instanceof RangeError,
			`expected TypeError or RangeError, got ${error}`,
		);
		assert.ok(!(error instanceof sdk.PdfConversionApiError), "argument errors are standard errors");
		return;
	}
	assert.ok(typeof sdk[type] === "function", `the SDK has no ${type}`);
	assert.ok(error instanceof sdk[type], `expected ${type}, got ${error?.name}: ${error?.message}`);
	assert.ok(error instanceof sdk.PdfConversionApiError, `${type} extends PdfConversionApiError`);
	assert.equal(error.name, type);
}

async function expectThrows(sdk, promiseFactory, type) {
	let caught;
	try {
		await promiseFactory();
	} catch (error) {
		caught = error;
	}
	assert.ok(caught !== undefined, `expected ${type}, but nothing was thrown`);
	checkType(sdk, caught, type);
	return caught;
}

async function checkResult(sdk, result, expected) {
	if (expected.conversion_cost !== undefined) assert.equal(result.conversionCost, expected.conversion_cost);
	if (expected.request_id === true) assert.ok(typeof result.requestId === "string" && result.requestId.length > 0);
	if (!expected.files) return;
	assert.equal(result.files.length, expected.files.length, "number of files");
	assert.equal(result.file, result.files[0]);
	for (const [index, want] of expected.files.entries()) {
		const file = result.files[index];
		if (want.name !== undefined) assert.equal(file.name, want.name);
		if (want.ext !== undefined) assert.equal(file.ext, want.ext);
		if (want.size !== undefined) assert.equal(file.size, want.size);
		if (want.data_fixture !== undefined) {
			assert.deepEqual(file.data, new Uint8Array(await readFile(fixture(want.data_fixture))));
		}
		if (want.data_utf8 !== undefined) assert.deepEqual(file.data, new TextEncoder().encode(want.data_utf8));
		if (want.stored === true) {
			assert.equal(file.stored, true);
			assert.ok(typeof file.url === "string" && file.url.length > 0, "url is set");
			assert.ok(typeof file.fileId === "string" && /^[0-9a-f]{32}$/.test(file.fileId), "fileId is set");
			await expectThrows(sdk, async () => file.data, "StoredFileError");
			await expectThrows(sdk, async () => file.bytes(), "StoredFileError");
		}
	}
}

async function checkEcho(result, expected) {
	const echo = JSON.parse(new TextDecoder().decode(await result.files[0].download()));
	for (const key of ["method", "path", "query"])
		if (expected[key] !== undefined) assert.equal(echo[key], expected[key], key);
	if (expected.authorization !== undefined) assert.equal(echo.headers.authorization, expected.authorization);
	if (expected.user_agent_prefix !== undefined)
		assert.ok(echo.headers["user-agent"]?.startsWith(expected.user_agent_prefix));
	if (expected.content_type_prefix !== undefined) {
		assert.ok(echo.headers["content-type"]?.startsWith(expected.content_type_prefix), echo.headers["content-type"]);
	}
	if (expected.fields) {
		let from = 0;
		for (const want of expected.fields) {
			const index = echo.fields.findIndex(
				(field, i) => i >= from && Object.entries(want).every(([k, v]) => field[k] === v),
			);
			assert.ok(index >= 0, `field ${JSON.stringify(want)} in order; got ${JSON.stringify(echo.fields)}`);
			from = index + 1;
		}
	}
	for (const name of expected.absent_fields ?? []) {
		assert.ok(!echo.fields.some((field) => field.name === name), `field ${name} is absent`);
	}
}

async function attempts(mockUrl, mockId) {
	const response = await fetch(`${mockUrl}/__mock/attempts/${encodeURIComponent(mockId)}`);
	return (await response.json()).attempts;
}

/** Runs one case; throws an AssertionError when it fails. */
export async function runCase(sdk, mockUrl, testCase, key) {
	const sleeps = [];
	const client = testCase.client ?? {};
	const options = {
		baseUrl: mockUrl + (client.base_url_suffix ?? ""),
		sleep: async (ms) => {
			sleeps.push(ms / 1000);
		},
	};
	const savedKey = process.env.PDFCONVERSIONAPI_KEY;
	if ("api_key" in client && client.api_key === null) delete process.env.PDFCONVERSIONAPI_KEY;
	else options.apiKey = client.api_key ?? key;
	if (client.max_retries !== undefined) options.maxRetries = client.max_retries;
	if (client.timeout_seconds !== undefined) options.timeout = client.timeout_seconds * 1000;

	try {
		const api = new sdk.PdfConversionApi(options);
		const expect = testCase.expect;
		const mockId = `${testCase.id}-${Math.random().toString(36).slice(2, 10)}`;
		const files = await Promise.all((testCase.files ?? []).map((d) => toInput(sdk, d)));
		const hasFiles = testCase.files !== undefined;
		const filesArg = testCase.files?.length === 1 ? files[0] : files;
		const params = {};
		for (const [name, value] of Object.entries(testCase.params ?? {})) params[name] = await toParam(sdk, value);
		if (testCase.call === "convert" || testCase.call === "stored_file_flow") params.MockId = mockId;
		const convertOptions = {};
		if (testCase.options?.file_name !== undefined) convertOptions.fileName = testCase.options.file_name;
		if (testCase.options?.store_file !== undefined) convertOptions.storeFile = testCase.options.store_file;

		let run;
		switch (testCase.call) {
			case "convert":
			case "stored_file_flow":
				// No files key: call without files at all (the params-only form).
				run = hasFiles
					? () => api.convert(testCase.from, testCase.to, filesArg, params, convertOptions)
					: () => api.convert(testCase.from, testCase.to, params, convertOptions);
				break;
			case "usage":
				run = () => api.usage();
				break;
			case "conversions":
				run = () => api.conversions();
				break;
			case "delete_stored_file":
				run = () => api.deleteStoredFile(testCase.file_id);
				break;
			default:
				throw new Error(`unknown call ${testCase.call}`);
		}

		if (expect.error) {
			const error = await expectThrows(sdk, run, expect.error.type);
			const want = expect.error;
			if (want.status !== undefined) assert.equal(error.status, want.status);
			if (want.message !== undefined) assert.equal(error.message, want.message);
			if (want.message_contains !== undefined) assert.ok(error.message.includes(want.message_contains), error.message);
			if (want.retry_after !== undefined) assert.equal(error.retryAfter, want.retry_after);
			if (want.request_id === true) assert.ok(typeof error.requestId === "string" && error.requestId.length > 0);
			if (want.request_id === false) assert.equal(error.requestId, null);
		} else {
			const value = await run();
			if (expect.result) await checkResult(sdk, value, expect.result);
			if (expect.echo) await checkEcho(value, expect.echo);
			if (expect.save_all) {
				const dir = await mkdtemp(join(tmpdir(), "pdfconversionapi-"));
				try {
					const target = join(dir, "out");
					const written = await value.saveAll(target);
					assert.deepEqual([...(await readdir(target))].sort(), Object.keys(expect.save_all).sort());
					assert.equal(written.length, Object.keys(expect.save_all).length);
					for (const [name, text] of Object.entries(expect.save_all)) {
						assert.equal(await readFile(join(target, name), "utf8"), text);
					}
				} finally {
					await rm(dir, { recursive: true, force: true });
				}
			}
			if (expect.conversions) {
				assert.equal(value.length, expect.conversions.count);
				for (const [k, v] of Object.entries(expect.conversions.first)) assert.equal(value[0][k], v, k);
			}
			if (expect.usage) {
				const names = { concurrent_limit: "concurrentLimit", max_upload_mb: "maxUploadMb" };
				for (const [k, v] of Object.entries(expect.usage)) {
					if (k === "period_start" || k === "period_end") {
						const field = k === "period_start" ? value.periodStart : value.periodEnd;
						assert.ok(field instanceof Date);
						assert.equal(field.getTime(), new Date(v).getTime(), k);
					} else {
						assert.equal(value[names[k] ?? k], v, k);
					}
				}
			}
			if (expect.deleted !== undefined) assert.equal(value, expect.deleted);
			if (testCase.call === "stored_file_flow") {
				const file = value.files[0];
				await expectThrows(sdk, async () => file.data, expect.data_access_error);
				assert.deepEqual(await file.download(), new Uint8Array(await readFile(fixture(expect.download_fixture))));
				assert.equal(await api.deleteStoredFile(file.fileId), expect.first_delete);
				assert.equal(await api.deleteStoredFile(file.fileId), expect.second_delete);
				await expectThrows(sdk, () => file.download(), expect.download_after_delete_error);
			}
		}
		if (expect.attempts !== undefined) assert.equal(await attempts(mockUrl, mockId), expect.attempts, "attempts");
		if (expect.min_sleeps !== undefined) {
			assert.equal(sleeps.length, expect.min_sleeps.length, `sleeps ${JSON.stringify(sleeps)}`);
			for (const [i, min] of expect.min_sleeps.entries())
				assert.ok(sleeps[i] >= min, `sleep ${i}: ${sleeps[i]} >= ${min}`);
		}
	} finally {
		if (savedKey === undefined) delete process.env.PDFCONVERSIONAPI_KEY;
		else process.env.PDFCONVERSIONAPI_KEY = savedKey;
	}
}
