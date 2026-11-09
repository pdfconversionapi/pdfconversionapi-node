// One input, several outputs: each page of a PDF as a JPG, with parameters.
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi();
const result = await client.convert("pdf", "jpg", "season-guide.pdf", {
	PageRange: "1-2",
	ImageResolution: 72,
});
for (const file of result.files) console.log(file.name, file.size, "bytes");
await result.saveAll("out");
