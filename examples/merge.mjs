// Several inputs: merge three PDFs, in order, into october-billing.pdf.
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
