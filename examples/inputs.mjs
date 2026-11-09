// Inputs from memory: bytes and streams need a name (a plain string is always a path).
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
