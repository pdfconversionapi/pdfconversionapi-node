// A conversion that takes no input file: params come third.
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi();
const result = await client.convert("data", "qrcode", { Data: "https://pdfconversionapi.com" });
console.log(result.file.name, result.file.size, "bytes");
await result.saveAll("out");
