// This month's count and the plan's limits.
import { PdfConversionApi } from "pdfconversionapi";

const client = new PdfConversionApi();
const usage = await client.usage();
console.log(`${usage.plan}: ${usage.used} of ${usage.included} used, ${usage.remaining} left`);
console.log(`up to ${usage.concurrentLimit} at once, ${usage.maxUploadMb} MB per request`);
console.log(`the count starts again at ${usage.periodEnd.toISOString()}`);
