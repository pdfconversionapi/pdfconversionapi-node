// Every client option, and a per-call timeout. Times are in milliseconds.
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
