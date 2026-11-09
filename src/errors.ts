/**
 * Errors thrown by the SDK. Every error the SDK creates extends {@link PdfConversionApiError}.
 * Bad arguments throw the standard `TypeError` (wrong type) or `RangeError` (bad value) instead.
 */

/** The base class of every error the SDK creates. */
export class PdfConversionApiError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
	}
}

/** A call that needs an API key was made without one. Thrown before anything is sent. */
export class MissingApiKeyError extends PdfConversionApiError {
	constructor() {
		super(
			"no API key: pass apiKey to new PdfConversionApi() or set the PDFCONVERSIONAPI_KEY environment variable " +
				"(get a key at https://app.pdfconversionapi.com)",
		);
	}
}

/** The data of a stored file (`storeFile: true`) was read. Use `download()` or `save()` instead. */
export class StoredFileError extends PdfConversionApiError {}

/** No response arrived (DNS failure, refused or reset connection), after every retry. */
export class ConnectionError extends PdfConversionApiError {
	/** How many attempts were made. */
	readonly attempts: number;

	constructor(message: string, attempts: number, cause: unknown) {
		super(message, { cause });
		this.attempts = attempts;
	}
}

/**
 * The client's own timeout ran out. Never retried: the conversion may still be running on the
 * server, and it counts toward the month if it succeeds.
 */
export class TimeoutError extends PdfConversionApiError {
	/** The timeout that ran out, in milliseconds. */
	readonly timeout: number;

	constructor(timeout: number) {
		super(
			`the request timed out after ${formatSeconds(timeout)} and was not retried; the conversion may still be ` +
				"running on the server and counts toward this month's conversions if it succeeds (raise the timeout option to wait longer)",
		);
		this.timeout = timeout;
	}
}

/** The API answered 200 with a body the SDK can't use (bad JSON, missing `Files`, size mismatch). */
export class InvalidResponseError extends PdfConversionApiError {
	/** The response's `x-request-id`, or `null`. */
	readonly requestId: string | null;

	constructor(message: string, requestId: string | null) {
		super(requestId ? `${message} (request id: ${requestId})` : message);
		this.requestId = requestId;
	}
}

/** Details of an error response, used to build an {@link ApiError}. */
export interface ApiErrorInit {
	status: number;
	message: string;
	requestId: string | null;
	retryAfter: number | null;
	body: string;
}

/**
 * An error status from the API. `message` is the API's own message; `toString()` and the stack
 * trace add the status and the request id.
 */
export class ApiError extends PdfConversionApiError {
	/** The HTTP status. */
	readonly status: number;
	/** The response's `x-request-id`, or `null` (responses from the edge network have none). */
	readonly requestId: string | null;
	/** `Retry-After` in seconds on 429 and 503 (1 when the header is missing), else `null`. */
	readonly retryAfter: number | null;
	/** The raw response body, for debugging. */
	declare readonly body: string;

	constructor(init: ApiErrorInit) {
		super(init.message);
		this.status = init.status;
		this.requestId = init.requestId;
		this.retryAfter = init.retryAfter;
		Object.defineProperty(this, "body", { value: init.body, enumerable: false });
		// Put the status and request id in the first line of the stack trace, which is what an
		// uncaught error prints, while `message` stays the API's text.
		const stack = this.stack;
		const header = `${this.name}: ${this.message}`;
		if (typeof stack === "string" && stack.startsWith(header)) {
			this.stack = this.toString() + stack.slice(header.length);
		}
	}

	/** `BadRequestError: HTTP 400: <message> (request id: <id>)`. */
	override toString(): string {
		const id = this.requestId ? ` (request id: ${this.requestId})` : "";
		return `${this.name}: HTTP ${this.status}: ${this.message}${id}`;
	}
}

/** 400: the request is wrong (a parameter, the number of files, the body). */
export class BadRequestError extends ApiError {}
/** 401: the API key is missing or unknown. */
export class AuthenticationError extends ApiError {}
/** 403: the key's plan isn't set up. */
export class PermissionDeniedError extends ApiError {}
/** 404: an unsupported conversion, or an expired or deleted stored file. */
export class NotFoundError extends ApiError {}
/** 413: the upload, an image or a page is over a limit. */
export class PayloadTooLargeError extends ApiError {}
/** 422: the file can't be read or converted as asked. */
export class UnprocessableEntityError extends ApiError {}
/** 429: a rate, concurrency or monthly limit. `retryAfter` says how long to wait. */
export class RateLimitError extends ApiError {}
/** 500: an unexpected failure on the API's side. */
export class InternalServerError extends ApiError {}
/** 503: the API is busy, or conversions on the plan are paused. `retryAfter` says how long to wait. */
export class ServiceUnavailableError extends ApiError {}
/** 504: the conversion ran out of time on the API's side. */
export class GatewayTimeoutError extends ApiError {}

// Names are set on the prototypes, so they survive minifiers that rename classes and are already
// in place while a base constructor runs.
for (const [Ctor, name] of [
	[PdfConversionApiError, "PdfConversionApiError"],
	[MissingApiKeyError, "MissingApiKeyError"],
	[StoredFileError, "StoredFileError"],
	[ConnectionError, "ConnectionError"],
	[TimeoutError, "TimeoutError"],
	[InvalidResponseError, "InvalidResponseError"],
	[ApiError, "ApiError"],
	[BadRequestError, "BadRequestError"],
	[AuthenticationError, "AuthenticationError"],
	[PermissionDeniedError, "PermissionDeniedError"],
	[NotFoundError, "NotFoundError"],
	[PayloadTooLargeError, "PayloadTooLargeError"],
	[UnprocessableEntityError, "UnprocessableEntityError"],
	[RateLimitError, "RateLimitError"],
	[InternalServerError, "InternalServerError"],
	[ServiceUnavailableError, "ServiceUnavailableError"],
	[GatewayTimeoutError, "GatewayTimeoutError"],
] as const) {
	Object.defineProperty(Ctor.prototype, "name", { value: name, writable: true, configurable: true, enumerable: false });
}

const BY_STATUS: Record<number, new (init: ApiErrorInit) => ApiError> = {
	400: BadRequestError,
	401: AuthenticationError,
	403: PermissionDeniedError,
	404: NotFoundError,
	413: PayloadTooLargeError,
	422: UnprocessableEntityError,
	429: RateLimitError,
	500: InternalServerError,
	503: ServiceUnavailableError,
	504: GatewayTimeoutError,
};

/** @internal Builds the ApiError subclass for a status. */
export function apiErrorFor(init: ApiErrorInit): ApiError {
	const Ctor = BY_STATUS[init.status] ?? ApiError;
	return new Ctor(init);
}

/** @internal The message of an error response, from its body and content type (SPEC section 9). */
export function errorMessage(body: string, contentType: string | null): string {
	if (body.trim() === "") return "empty response";
	try {
		const parsed: unknown = JSON.parse(body);
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			typeof (parsed as { Message?: unknown }).Message === "string"
		) {
			return (parsed as { Message: string }).Message;
		}
	} catch {
		// not JSON
	}
	const type = contentType?.split(";")[0]?.trim().toLowerCase() || null;
	if (type === "text/plain" && body.length <= 1000) return body.trim();
	return type ? `non-JSON response (${type})` : "non-JSON response (no content type)";
}

function formatSeconds(ms: number): string {
	const seconds = ms / 1000;
	return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(3).replace(/0+$/, "")} s`;
}
