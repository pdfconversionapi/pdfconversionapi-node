// A named file field: stamp logo.png on every page at 30% opacity.
import { PdfConversionApi, UploadFile } from "pdfconversionapi";

const client = new PdfConversionApi();
const result = await client.convert("pdf", "image-watermark", "proposal.pdf", {
	ImageFile: UploadFile.fromPath("logo.png"),
	Opacity: 30,
});
console.log(result.file.name, result.file.size, "bytes");
await result.saveAll("out");
