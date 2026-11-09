// Every failure is a typed error. Retries for 429, 503, a first 500 and dropped connections
// already happened inside the call.
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
