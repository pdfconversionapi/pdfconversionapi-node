// Compile-only checks of the published types, imported by package name as a user would.
// Run by `npm run typecheck` (after `npm run build`).

import { createReadStream } from "node:fs";
import {
	ApiError,
	type Conversion,
	type ConversionResult,
	type OutputFile,
	PdfConversionApi,
	RateLimitError,
	UploadFile,
	type Usage,
} from "pdfconversionapi";

declare const bytes: Uint8Array;
declare const blob: Blob;

export async function examples(): Promise<void> {
	const client = new PdfConversionApi({ timeout: 300_000, maxRetries: 2 });
	const one: ConversionResult = await client.convertFile("report.docx", "pdf");
	const file: OutputFile = one.file;
	const data: Uint8Array = file.data;
	const paths: string[] = await one.saveAll("out");
	await client.convert("pdf", "jpg", "a.pdf", { ImageResolution: 150, PageRange: "1-2", MultiPage: false });
	await client.convert("pdf", "merge", [
		"a.pdf",
		bytes,
		blob,
		UploadFile.fromStream(createReadStream("c.pdf"), "c.pdf"),
	]);
	await client.convert("pdf", "image-watermark", "a.pdf", { ImageFile: UploadFile.fromPath("logo.png"), Opacity: 30 });
	await client.convert("data", "qrcode", { Data: "https://example.com" });
	await client.convert("data", "qrcode", { Data: "x" }, { fileName: "code", storeFile: true });
	await client.convert("txt", "pdf", null, { Data: "x" });
	await client.convert("txt", "pdf", bytes, {}, { timeout: 1000, signal: AbortSignal.timeout(5000) });
	const usage: Usage = await client.usage();
	const remaining: number | null = usage.remaining;
	const start: Date = usage.periodStart;
	const list: Conversion[] = await client.conversions();
	const downloaded: Uint8Array = await client.download(file.url ?? "");
	const deleted: boolean = await client.deleteStoredFile(file.fileId ?? "");
	try {
		await client.usage();
	} catch (error) {
		if (error instanceof RateLimitError) {
			const wait: number | null = error.retryAfter;
			void wait;
		} else if (error instanceof ApiError) {
			const status: number = error.status;
			const id: string | null = error.requestId;
			void status;
			void id;
		}
	}
	// @ts-expect-error a string in params is text, not a file; numbers are fine but objects are not
	await client.convert("pdf", "jpg", "a.pdf", { Bad: { nested: true } });
	// @ts-expect-error files must be inputs
	await client.convert("pdf", "jpg", 42);
	// @ts-expect-error storeFile is a boolean
	await client.convert("pdf", "jpg", "a.pdf", {}, { storeFile: "yes" });
	// @ts-expect-error UploadFile has no public constructor
	new UploadFile();
	void [data, paths, remaining, start, list, downloaded, deleted];
}
