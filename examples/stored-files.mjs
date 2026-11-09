// storeFile: links instead of data. Download each file (no key is sent), then delete it early.
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi();
const result = await client.convert("pdf", "jpg", "season-guide.pdf", { ImageResolution: 72 }, { storeFile: true });
const first = await result.files[0].download(); // bytes, fetched from the link
console.log(result.files[0].name, first.length, "bytes downloaded");
await result.saveAll("out"); // downloads every stored file to disk
for (const file of result.files) {
	console.log(file.name, "deleted:", await client.deleteStoredFile(file.fileId));
}
