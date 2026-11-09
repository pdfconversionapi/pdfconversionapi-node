// The CommonJS entry loads with require() and exports the same names as the ES module entry.
// Needs `npm run build` first.

const assert = require("node:assert/strict");
const { test } = require("node:test");

test("require('pdfconversionapi') matches the ES module entry", async () => {
	const cjs = require("pdfconversionapi");
	const esm = await import("pdfconversionapi");
	assert.deepEqual(Object.keys(cjs).sort(), Object.keys(esm).sort());
	for (const name of ["PdfConversionApi", "UploadFile", "ApiError", "TimeoutError", "ConnectionError", "VERSION"]) {
		assert.ok(name in cjs, name);
	}
	assert.equal(cjs.VERSION, require("../package.json").version);
	assert.equal(typeof new cjs.PdfConversionApi({ apiKey: "k" }).convert, "function");
});

test("error classes keep their names", () => {
	const sdk = require("pdfconversionapi");
	const error = new sdk.RateLimitError({
		status: 429,
		message: "slow down",
		requestId: "id",
		retryAfter: 10,
		body: "",
	});
	assert.ok(error instanceof sdk.ApiError);
	assert.ok(error instanceof sdk.PdfConversionApiError);
	assert.ok(error instanceof Error);
	assert.equal(error.name, "RateLimitError");
	assert.equal(String(error), "RateLimitError: HTTP 429: slow down (request id: id)");
});
