// Live tests against the real API (SPEC section 12.3). They read PDFCONVERSIONAPI_LOCAL_BASE_URL
// and PDFCONVERSIONAPI_LOCAL_KEY from ../conformance/.local-api.env (the API running locally), else
// PDFCONVERSIONAPI_LIVE_BASE_URL and PDFCONVERSIONAPI_KEY from the environment (the release
// workflow's run against the production API), and are skipped without either. The key alone
// doesn't start them, and it is never printed. The input files are in ../conformance/samples.
// 10 requests, 7 of them successful conversions; the tests run one at a time.
//
//   npm run build && npm run test:live

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import * as sdk from "../dist/index.js";
import { conformanceDir } from "./conformance-lib.mjs";

const envFile = join(conformanceDir, ".local-api.env");
const samples = resolve(process.env.PDFCONVERSIONAPI_SAMPLES_DIR || join(conformanceDir, "samples"));

function readEnvFile(path) {
	const values = {};
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const index = line.indexOf("=");
		if (index > 0 && !line.trimStart().startsWith("#"))
			values[line.slice(0, index).trim()] = line.slice(index + 1).trim();
	}
	return values;
}

const local = existsSync(envFile) ? readEnvFile(envFile) : null;
const baseUrl = local ? local.PDFCONVERSIONAPI_LOCAL_BASE_URL : process.env.PDFCONVERSIONAPI_LIVE_BASE_URL;
const apiKey = local ? local.PDFCONVERSIONAPI_LOCAL_KEY : process.env.PDFCONVERSIONAPI_KEY;
const skip =
	baseUrl && apiKey
		? false
		: local
			? `${envFile} lacks the base URL or the key`
			: `no ${envFile}, and PDFCONVERSIONAPI_LIVE_BASE_URL or PDFCONVERSIONAPI_KEY is not set`;
const client = skip ? null : new sdk.PdfConversionApi({ apiKey, baseUrl });

const isPdf = (bytes) => new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-";
const isJpeg = (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

describe("live", { skip, concurrency: 1 }, () => {
	const dirs = [];
	const tempDir = async () => {
		const dir = await mkdtemp(join(tmpdir(), "pdfconversionapi-live-"));
		dirs.push(dir);
		return dir;
	};
	after(async () => {
		for (const dir of dirs) await rm(dir, { recursive: true, force: true });
	});

	test("conversions() lists docx to pdf, without a key", async () => {
		const list = await new sdk.PdfConversionApi({ baseUrl, apiKey: "" }).conversions();
		assert.ok(list.length > 100, `${list.length} conversions`);
		assert.ok(list.some((c) => c.from === "docx" && c.to === "pdf" && c.inputs === "one"));
	});

	test("DOCX to PDF from a path, saved with saveAll", async () => {
		const result = await client.convertFile(join(samples, "docx-to-pdf", "input-quarterly-report.docx"), "pdf");
		assert.equal(result.files.length, 1);
		assert.equal(result.file.name, "input-quarterly-report.pdf");
		assert.equal(result.file.ext, "pdf");
		assert.equal(result.file.size, result.file.data.length);
		assert.ok(isPdf(result.file.data));
		assert.equal(result.conversionCost, 1);
		assert.ok(result.conversionTime > 0);
		assert.ok(result.requestId);
		const dir = await tempDir();
		const [written] = await result.saveAll(join(dir, "out"));
		assert.equal(written, join(dir, "out", "input-quarterly-report.pdf"));
		assert.deepEqual(new Uint8Array(await readFile(written)), result.file.data);
	});

	test("PDF to JPG gives two pages at 72 DPI", async () => {
		const result = await client.convert(
			"pdf",
			"jpg",
			join(samples, "pdf-to-jpg", "input-season-guide.pdf"),
			{ ImageResolution: 72 },
			{ fileName: "season-guide" },
		);
		assert.deepEqual(
			result.files.map((f) => f.name),
			["season-guide-1.jpg", "season-guide-2.jpg"],
		);
		for (const file of result.files) {
			assert.ok(isJpeg(file.data));
			assert.equal(file.data.length, file.size);
		}
	});

	test("merge of three PDFs, from bytes and a stream", async () => {
		const { createReadStream } = await import("node:fs");
		const dir = join(samples, "merge");
		const result = await client.convert(
			"pdf",
			"merge",
			[
				join(dir, "input-invoice.pdf"),
				sdk.UploadFile.fromBytes(await readFile(join(dir, "input-terms.pdf")), "terms.pdf"),
				sdk.UploadFile.fromStream(createReadStream(join(dir, "input-timesheet.pdf")), "timesheet.pdf"),
			],
			{},
			{ fileName: "october-billing" },
		);
		assert.equal(result.files.length, 1);
		assert.equal(result.file.name, "october-billing.pdf");
		assert.ok(isPdf(result.file.data));
		assert.ok(result.file.size > 100_000, `${result.file.size} bytes`);
	});

	test("UTF-8 and quoted file names come back as the docs promise", async () => {
		const text = new TextEncoder().encode("Grüße\n");
		const utf8 = await client.convert("txt", "pdf", sdk.UploadFile.fromBytes(text, "Résumé final (1).txt"));
		assert.equal(utf8.file.name, "Résumé final _1_.pdf");
		const quoted = await client.convert("txt", "pdf", sdk.UploadFile.fromBytes(text, 'say "hi".txt'));
		assert.equal(quoted.file.name, "say _hi_.pdf");
	});

	test("storeFile: download (no key), downloadTo, delete twice, then 404", async () => {
		const result = await client.convert(
			"pdf",
			"jpg",
			join(samples, "pdf-to-jpg", "input-season-guide.pdf"),
			{ ImageResolution: 72, PageRange: "1" },
			{ storeFile: true },
		);
		const file = result.file;
		assert.equal(file.stored, true);
		assert.match(file.fileId, /^[0-9a-f]{32}$/);
		assert.ok(file.url.startsWith("http"));
		assert.throws(() => file.data, sdk.StoredFileError);
		const bytes = await file.download();
		assert.ok(isJpeg(bytes));
		assert.equal(bytes.length, file.size);
		const dir = await tempDir();
		const path = await client.downloadTo(file.url, join(dir, "page.jpg"));
		assert.deepEqual(new Uint8Array(await readFile(path)), bytes);
		const saved = await file.save(dir);
		assert.equal(saved, join(dir, file.name));
		assert.equal(await client.deleteStoredFile(file.fileId), true);
		assert.equal(await client.deleteStoredFile(file.fileId), false);
		await assert.rejects(file.download(), sdk.NotFoundError);
	});

	test("an unsupported pair is a NotFoundError", async () => {
		const error = await client.convertFile(join(samples, "docx-to-pdf", "input-quarterly-report.docx"), "dwg").then(
			() => null,
			(e) => e,
		);
		assert.ok(error instanceof sdk.NotFoundError, String(error));
		assert.equal(error.status, 404);
		assert.equal(error.message, "conversion from docx to dwg is not supported");
		assert.ok(error.requestId);
		assert.ok(String(error).includes("HTTP 404: conversion from docx to dwg is not supported (request id: "));
	});

	test("a wrong key is an AuthenticationError and the key is never in the error", async () => {
		const wrong = "wrong-key-for-live-test";
		const error = await new sdk.PdfConversionApi({ apiKey: wrong, baseUrl })
			.convertFile(join(samples, "docx-to-pdf", "input-quarterly-report.docx"), "pdf")
			.then(
				() => null,
				(e) => e,
			);
		assert.ok(error instanceof sdk.AuthenticationError, String(error));
		assert.equal(error.status, 401);
		for (const text of [error.message, String(error), error.stack, error.body]) assert.ok(!text.includes(wrong));
	});

	test("a bad PageRange is a BadRequestError, not retried", async () => {
		const error = await client
			.convert("pdf", "jpg", join(samples, "pdf-to-jpg", "input-season-guide.pdf"), { PageRange: "3-1" })
			.then(
				() => null,
				(e) => e,
			);
		assert.ok(error instanceof sdk.BadRequestError, String(error));
		assert.equal(error.status, 400);
		assert.equal(error.message, "PageRange '3-1' is not valid (example: 1-3,5)");
		for (const text of [error.message, String(error), error.stack, error.body]) assert.ok(!text.includes(apiKey));
	});
});
