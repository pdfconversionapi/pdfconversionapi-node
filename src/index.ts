/**
 * The official JavaScript and TypeScript client for the PDF Conversion API.
 *
 * Docs: https://pdfconversionapi.com/docs. Keys: https://app.pdfconversionapi.com.
 * @packageDocumentation
 */

export {
	type ClientOptions,
	type ConvertOptions,
	DEFAULT_BASE_URL,
	type Params,
	type ParamValue,
	PdfConversionApi,
} from "./client.js";
export {
	ApiError,
	type ApiErrorInit,
	AuthenticationError,
	BadRequestError,
	ConnectionError,
	GatewayTimeoutError,
	InternalServerError,
	InvalidResponseError,
	MissingApiKeyError,
	NotFoundError,
	PayloadTooLargeError,
	PdfConversionApiError,
	PermissionDeniedError,
	RateLimitError,
	ServiceUnavailableError,
	StoredFileError,
	TimeoutError,
	UnprocessableEntityError,
} from "./errors.js";
export type { FetchFunction, RequestOptions, SleepFunction } from "./http.js";
export { type FileInput, type StreamInput, UploadFile } from "./inputs.js";
export { type Conversion, ConversionResult, OutputFile, type Usage } from "./results.js";
export { VERSION } from "./version.js";
