# PDF Conversion API for JavaScript and TypeScript

The official client for the [PDF Conversion API](https://pdfconversionapi.com/docs): convert
documents, images and PDFs with one call, and get typed results and typed errors back.

- No runtime dependencies. ESM and CommonJS, with bundled TypeScript types.
- Node.js 18 or later. The package also loads in Bun, Deno and Cloudflare Workers (workerd).
- Retries, timeouts and the API's error format are handled for you.

```bash
npm install pdfconversionapi
```

## API key

Create a key in the [dashboard](https://app.pdfconversionapi.com) and put it in the
`PDFCONVERSIONAPI_KEY` environment variable, or pass it as `apiKey`. Keep it on your server: the
key is secret, and the API sends no CORS headers, so this package is for servers, scripts and
CLIs, not browsers. Plans and limits are on the [pricing page](https://pdfconversionapi.com/pricing).

## Quick start

```js
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi(); // reads PDFCONVERSIONAPI_KEY
const result = await client.convertFile("report.docx", "pdf");
const paths = await result.saveAll("out");
console.log(paths);
```

```text
[ 'out/report.pdf' ]
```

`convertFile()` reads the input format from the extension. `convert(from, to, files, params, options)`
names it yourself, and takes one input or a list of them.

**A plain string is always a path** on disk, whether it is an input or the folder to save into.
To send bytes or a stream, wrap them in `UploadFile` (see [Inputs](#inputs)).

## Several outputs: PDF to JPG, with parameters

Parameters go in the fourth argument, as the API names them. Numbers and booleans are sent as
text (`72`, `true`); `null` and `undefined` values are left out.

```js
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi();
const result = await client.convert("pdf", "jpg", "season-guide.pdf", {
	PageRange: "1-2",
	ImageResolution: 72,
});
for (const file of result.files) console.log(file.name, file.size, "bytes");
await result.saveAll("out");
```

```text
season-guide-1.jpg 65272 bytes
season-guide-2.jpg 66627 bytes
```

The parameters each conversion reads are listed on its page, for example
[PDF to JPG](https://pdfconversionapi.com/convert/pdf-to-jpg).

## Several inputs: merge

A list of inputs is sent in order. The `fileName` option names the output (without extension).

```js
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi();
const result = await client.convert(
	"pdf",
	"merge",
	["invoice.pdf", "terms.pdf", "timesheet.pdf"],
	{},
	{ fileName: "october-billing" },
);
console.log(result.file.name, result.file.size, "bytes");
await result.saveAll("out");
```

```text
october-billing.pdf 107308 bytes
```

## A named file: image watermark

A parameter whose value is a file (anything but a string) is sent as a file field with that name.

```js
import { PdfConversionApi, UploadFile } from "pdfconversionapi";

const client = new PdfConversionApi();
const result = await client.convert("pdf", "image-watermark", "proposal.pdf", {
	ImageFile: UploadFile.fromPath("logo.png"),
	Opacity: 30,
});
console.log(result.file.name, result.file.size, "bytes");
await result.saveAll("out");
```

```text
proposal.pdf 56434 bytes
```

## No input file

A few conversions, such as `data/to/qrcode`, take parameters only. Pass them third:

```js
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi();
const result = await client.convert("data", "qrcode", { Data: "https://pdfconversionapi.com" });
console.log(result.file.name, result.file.size, "bytes");
await result.saveAll("out");
```

```text
qrcode.svg 9912 bytes
```

## Inputs

| You pass                                                         | Sent as                                                               |
| ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| a string, or a `file:` URL                                       | the file at that path, under its own name (read again for each retry) |
| `UploadFile.fromPath(path, name?)`                               | the same, optionally under another name                               |
| `Uint8Array`, `Buffer`, `ArrayBuffer`                            | those bytes, named `file`                                             |
| `UploadFile.fromBytes(bytes, name)`                              | those bytes, under `name`                                             |
| `Blob`, or `File` (keeps its name)                               | its contents                                                          |
| a web `ReadableStream`, a Node.js `Readable`, any async iterable | its bytes, read into memory once before the first attempt             |
| `UploadFile.fromStream(stream, name)`                            | the same, under `name`                                                |

```js
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { PdfConversionApi, UploadFile } from "pdfconversionapi";

const client = new PdfConversionApi();

const bytes = await readFile("report.docx");
const fromBytes = await client.convert("docx", "pdf", UploadFile.fromBytes(bytes, "report.docx"));
console.log(fromBytes.file.name, fromBytes.file.data.length, "bytes");

const stream = createReadStream("season-guide.pdf");
const fromStream = await client.convert("pdf", "jpg", UploadFile.fromStream(stream, "season-guide.pdf"), {
	PageRange: "1",
	ImageResolution: 72,
});
console.log(fromStream.file.name, fromStream.file.data.length, "bytes");
```

```text
report.pdf 82830 bytes
season-guide-1.jpg 65272 bytes
```

The name you send becomes the output's name with the new extension. Only the file's own name is
sent, never its folders.

## Results

`convert()` returns a `ConversionResult`:

| Field                              |                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------- |
| `files`                            | every output, in order (`OutputFile`)                                                           |
| `file`                             | the first output: the only one for most conversions                                             |
| `conversionCost`, `conversionTime` | conversions counted (1) and seconds spent on the API's side                                     |
| `requestId`                        | the response's `x-request-id`; send it with any question about the request                      |
| `saveAll(dir)`                     | writes every file into `dir` (created if needed, existing files overwritten); returns the paths |

Each `OutputFile` has `name`, `ext`, `size`, `data` (a `Uint8Array`; also `bytes()`), `stored`,
`url` and `fileId`, and `save(path)` (inside `path` when it is a folder), `download()` and
`downloadTo(path)`.

**The whole response is held in memory**, since the API sends files as base64 inside JSON (a
100 MB result arrives as about 133 MB of JSON). For large outputs, use `storeFile` and stream each
file to disk with `downloadTo()` or `saveAll()`.

## Stored files: download and delete

With `storeFile: true` the API keeps each output for 3 hours behind a link, and sends `url` and
`fileId` instead of data. Reading `data` then throws `StoredFileError`; `download()`, `save()` and
`saveAll()` fetch the file (without sending your key), and `deleteStoredFile()` removes it early.

```js
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi();
const result = await client.convert("pdf", "jpg", "season-guide.pdf", { ImageResolution: 72 }, { storeFile: true });
const first = await result.files[0].download(); // bytes, fetched from the link
console.log(result.files[0].name, first.length, "bytes downloaded");
await result.saveAll("out"); // downloads every stored file to disk
for (const file of result.files) {
	console.log(file.name, "deleted:", await client.deleteStoredFile(file.fileId));
}
```

```text
season-guide-1.jpg 65272 bytes downloaded
season-guide-1.jpg deleted: true
season-guide-2.jpg deleted: true
```

`deleteStoredFile()` returns `false` when there was nothing to delete. `client.download(url)` and
`client.downloadTo(url, path)` take a link as returned.

## Usage

```js
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi();
const usage = await client.usage();
console.log(`${usage.plan}: ${usage.used} of ${usage.included} used, ${usage.remaining} left`);
console.log(`up to ${usage.concurrentLimit} at once, ${usage.maxUploadMb} MB per request`);
console.log(`the count starts again at ${usage.periodEnd.toISOString()}`);
```

```text
Free: 12 of 250 used, 238 left
up to 1 at once, 10 MB per request
the count starts again at 2026-12-01T00:00:00.000Z
```

`client.conversions()` lists every conversion (`from`, `to`, `title`, `category`, `inputs`) and
needs no key.

## Errors and retries

Every error the client creates extends `PdfConversionApiError`. An error status from the API is an
`ApiError` with `status`, `message` (the API's own text), `requestId`, `retryAfter` and `body`:

| Class                      | Status                                                               |
| -------------------------- | -------------------------------------------------------------------- |
| `BadRequestError`          | 400                                                                  |
| `AuthenticationError`      | 401                                                                  |
| `PermissionDeniedError`    | 403                                                                  |
| `NotFoundError`            | 404: an unsupported conversion, or an expired or deleted stored file |
| `PayloadTooLargeError`     | 413                                                                  |
| `UnprocessableEntityError` | 422: the file can't be read or converted as asked                    |
| `RateLimitError`           | 429                                                                  |
| `InternalServerError`      | 500                                                                  |
| `ServiceUnavailableError`  | 503                                                                  |
| `GatewayTimeoutError`      | 504                                                                  |
| `ApiError`                 | any other status                                                     |

The others are `MissingApiKeyError` (a call that needs a key, raised before sending),
`ConnectionError` (no response), `TimeoutError` (the client's own timeout), `InvalidResponseError`
(a 200 the client can't use) and `StoredFileError`. Bad arguments throw the standard `TypeError` or
`RangeError`.

```js
import {
	ApiError,
	ConnectionError,
	NotFoundError,
	PdfConversionApi,
	RateLimitError,
	TimeoutError,
} from "pdfconversionapi";

const client = new PdfConversionApi();
try {
	await client.convertFile("report.docx", "dwg");
} catch (error) {
	if (error instanceof NotFoundError) {
		console.log(error.status, error.message);
		console.log(String(error));
	} else if (error instanceof RateLimitError) {
		console.log(`limit reached; retry in ${error.retryAfter} s: ${error.message}`);
	} else if (error instanceof ApiError) {
		console.log(`HTTP ${error.status}: ${error.message} (request id: ${error.requestId})`);
	} else if (error instanceof TimeoutError || error instanceof ConnectionError) {
		console.log(error.message);
	} else {
		throw error;
	}
}
```

```text
404 conversion from docx to dwg is not supported
NotFoundError: HTTP 404: conversion from docx to dwg is not supported (request id: 99eddc4e107d51eb)
```

**Retries happen inside each call**, downloads included, up to `maxRetries` (4) times:

- **429 and 503** are retried after `Retry-After` seconds plus a random delay (jitter) of up to 2,
  4, 8 and 16 seconds. A `Retry-After` longer than `maxRetryWait` (60 s), such as a used-up month
  or paused conversions, is thrown at once with `retryAfter` set.
- **A 500** is retried once per call.
- **No response** (a refused or reset connection, one closed before any answer) is retried with
  jitter, then thrown as `ConnectionError`.
- Never retried: **400, 401, 403, 404, 413, 422 and 504**, a connection that fails after the
  response started (the conversion may already have counted), and the client's own timeout.

Retrying is safe: a conversion changes nothing on the API's side, and only successful conversions
count toward your month. The key never appears in errors, logs or the client's printed form.

## Timeouts

Each attempt may take `timeout` milliseconds (240 000 by default) for the whole response, upload
and download included. When it runs out the call throws `TimeoutError` and is **not** retried: the
conversion may still be running and counts toward your month if it succeeds. To wait longer, raise
`timeout` on the client or on one call (see the next section), and cancel a call with an
`AbortSignal` in `signal`.

## Configuration

Every client option, and a per-call timeout. Times are in milliseconds.

```js
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi({
	apiKey: process.env.PDFCONVERSIONAPI_KEY, // the default
	baseUrl: process.env.PDFCONVERSIONAPI_BASE_URL, // default https://api.pdfconversionapi.com
	timeout: 300_000, // per attempt, the whole response included (default 240 000)
	maxRetries: 2, // default 4; 0 turns retries off
	maxRetryWait: 30_000, // a longer Retry-After is thrown at once (default 60 000)
});
const conversions = await client.conversions({ timeout: 30_000 });
const toPdf = conversions.filter((c) => c.to === "pdf");
console.log(conversions.length, "conversions,", toPdf.length, "of them to PDF");
```

```text
556 conversions, 61 of them to PDF
```

Every method takes `{ timeout, signal }` as its last argument; `convert()` and `convertFile()`
also take `fileName` and `storeFile` there. Two more client options exist: `fetch`, to use your
own `fetch` function, and `sleep`, which replaces the wait between retries in tests.

## Runtimes

- **Node.js 18 or later**, through the global `fetch`.
- **Bun and Deno** run the same build. Deno needs `--allow-net`, plus `--allow-env` to read the key
  from the environment and `--allow-read`/`--allow-write` for paths.
- **Cloudflare Workers (workerd)** load the package without `nodejs_compat`. Pass the key from your
  Worker's secrets as `apiKey`, and pass bytes, Blobs or streams: paths need a filesystem.

The [examples](examples) folder holds every snippet above as a runnable program.

## Links

- Docs: https://pdfconversionapi.com/docs
- API keys and usage: https://app.pdfconversionapi.com
- Pricing: https://pdfconversionapi.com/pricing

MIT License. Copyright (c) 2026 Zeel Shekhaliya.
