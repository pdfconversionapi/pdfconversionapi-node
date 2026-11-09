// The client: one object per API key, safe to share between concurrent calls.

import { type FetchFunction, Http, type RequestOptions, realSleep, type SleepFunction } from "./http.js";
import { buildMultipart, type FileInput, type FormField, isFileValue, prepareInput } from "./inputs.js";
import {
	type Conversion,
	type ConversionResult,
	downloadBytes,
	downloadToFile,
	parseConversion,
	parseConversions,
	parseUsage,
	type Usage,
} from "./results.js";
import { readEnv } from "./runtime.js";

/** The API's address unless `baseUrl` or `PDFCONVERSIONAPI_BASE_URL` says otherwise. */
export const DEFAULT_BASE_URL = "https://api.pdfconversionapi.com";

/** Settings for {@link PdfConversionApi}. Times are in milliseconds. */
export interface ClientOptions {
	/** The API key. Defaults to the `PDFCONVERSIONAPI_KEY` environment variable. */
	apiKey?: string | undefined;
	/** Defaults to `PDFCONVERSIONAPI_BASE_URL`, else `https://api.pdfconversionapi.com`. */
	baseUrl?: string | undefined;
	/** Time allowed for each attempt, the whole response included. Default 240 000 (240 s). */
	timeout?: number | undefined;
	/** Retries after a dropped connection, a 429, a 503 or a first 500. Default 4 (5 attempts); 0 turns retries off. */
	maxRetries?: number | undefined;
	/** The longest `Retry-After` to wait for; a longer one is thrown at once. Default 60 000 (60 s). */
	maxRetryWait?: number | undefined;
	/** The `fetch` to use. Defaults to the global `fetch`. */
	fetch?: FetchFunction | undefined;
	/** Replaces the wait between retries (for tests). */
	sleep?: SleepFunction | undefined;
}

/** Options for a conversion. */
export interface ConvertOptions extends RequestOptions {
	/** The output's name without the extension (sent as `FileName`). */
	fileName?: string | undefined;
	/** `true` stores the outputs and returns links instead of data (sent as `StoreFile=true`). */
	storeFile?: boolean | undefined;
}

/** A parameter value: text, a number, a boolean, a file (sent as a named file field), or null/undefined (left out). */
export type ParamValue = string | number | bigint | boolean | null | undefined | Exclude<FileInput, string>;

/** Conversion parameters by name, for example `{ PageRange: "1-3", ImageResolution: 150 }`. */
export type Params = Readonly<Record<string, ParamValue>>;

const FORMAT = /^[A-Za-z0-9-]{1,20}$/;
const FILE_ID = /^[0-9a-fA-F]{32}$/;
const MAX_TIMER = 2_147_483_647;

/**
 * The PDF Conversion API client.
 *
 * ```ts
 * const client = new PdfConversionApi(); // reads PDFCONVERSIONAPI_KEY
 * const result = await client.convertFile("report.docx", "pdf");
 * await result.saveAll("out");
 * ```
 */
export class PdfConversionApi {
	readonly #http: Http;

	constructor(options: ClientOptions = {}) {
		if (options === null || typeof options !== "object") throw new TypeError("options must be an object");
		const apiKey = options.apiKey ?? readEnv("PDFCONVERSIONAPI_KEY");
		if (apiKey !== undefined && typeof apiKey !== "string") throw new TypeError("apiKey must be a string");
		const baseUrl = checkBaseUrl(options.baseUrl ?? readEnv("PDFCONVERSIONAPI_BASE_URL") ?? DEFAULT_BASE_URL);
		const timeout = checkTimeout(options.timeout ?? 240_000, "timeout");
		const maxRetries = options.maxRetries ?? 4;
		if (!Number.isSafeInteger(maxRetries) || maxRetries < 0)
			throw new RangeError("maxRetries must be a whole number, 0 or more");
		const maxRetryWait = options.maxRetryWait ?? 60_000;
		if (typeof maxRetryWait !== "number" || !Number.isFinite(maxRetryWait) || maxRetryWait < 0) {
			throw new RangeError("maxRetryWait must be a number of milliseconds, 0 or more");
		}
		if (options.fetch !== undefined && typeof options.fetch !== "function")
			throw new TypeError("fetch must be a function");
		if (options.sleep !== undefined && typeof options.sleep !== "function")
			throw new TypeError("sleep must be a function");
		this.#http = new Http({
			apiKey: apiKey?.trim() || undefined,
			baseUrl,
			timeout,
			maxRetries,
			maxRetryWait,
			fetch: options.fetch,
			sleep: options.sleep ?? realSleep,
		});
	}

	/** The API's base URL, without a trailing slash. */
	get baseUrl(): string {
		return this.#http.baseUrl;
	}

	/**
	 * Converts files from one format to another (`POST /v2/convert/{from}/to/{to}`).
	 *
	 * @param from The input format, such as `docx`; or `file`/`office` to read it from the file name.
	 * @param to The output format, or a tool such as `merge`, `split`, `compress` or `protect`.
	 * @param files One input, or several (sent as repeated `Files` fields, in order). A string is a
	 *   path. Omitted, null or empty, the request has no file (for `data/to/qrcode` and the like).
	 * @param params Conversion parameters. A file value (not a string) is sent as a named file
	 *   field, such as `ImageFile`.
	 */
	convert(
		from: string,
		to: string,
		files?: FileInput | readonly FileInput[] | null,
		params?: Params,
		options?: ConvertOptions,
	): Promise<ConversionResult>;
	/**
	 * Runs a conversion that takes no input file, such as `data/to/qrcode`:
	 * `convert("data", "qrcode", { Data: "https://example.com" })`.
	 */
	convert(from: string, to: string, params: Params, options?: ConvertOptions): Promise<ConversionResult>;
	async convert(
		from: string,
		to: string,
		filesOrParams?: FileInput | readonly FileInput[] | Params | null,
		paramsOrOptions?: Params | ConvertOptions,
		maybeOptions?: ConvertOptions,
	): Promise<ConversionResult> {
		const noFiles = isPlainObject(filesOrParams) && !isFileValue(filesOrParams);
		const files = noFiles ? undefined : filesOrParams;
		const params = ((noFiles ? filesOrParams : paramsOrOptions) ?? {}) as Params;
		const options = ((noFiles ? paramsOrOptions : maybeOptions) ?? {}) as ConvertOptions;
		const fromFormat = checkFormat(from, "from");
		const toFormat = checkFormat(to, "to");
		const inputs: readonly unknown[] =
			files === undefined || files === null ? [] : Array.isArray(files) ? files : [files];
		checkParams(params);
		checkConvertOptions(options);
		const timeout = options.timeout === undefined ? undefined : checkTimeout(options.timeout, "timeout");
		this.#http.requireKey();

		// Read streams (and copy bytes) once, before the first attempt, so retries send the same data.
		const fileField = inputs.length === 1 ? "File" : "Files";
		const fields: FormField[] = [];
		for (const input of inputs) fields.push({ name: fileField, file: await prepareInput(input) });
		const typed = new Set<string>();
		if (options.fileName !== undefined) typed.add("filename");
		if (options.storeFile !== undefined) typed.add("storefile");
		for (const [name, value] of Object.entries(params)) {
			if (value === null || value === undefined || typed.has(name.toLowerCase())) continue;
			if (isFileValue(value)) fields.push({ name, file: await prepareInput(value) });
			else fields.push({ name, value: paramText(name, value) });
		}
		if (options.fileName !== undefined) fields.push({ name: "FileName", value: options.fileName });
		if (options.storeFile === true) fields.push({ name: "StoreFile", value: "true" });

		const http = this.#http;
		return http.request({
			method: "POST",
			url: `${http.baseUrl}/v2/convert/${fromFormat}/to/${toFormat}`,
			auth: true,
			api: true,
			body: () => buildMultipart(fields),
			ok: (status) => status === 200,
			read: (response) => parseConversion(response, http),
			timeout,
			signal: options.signal,
		});
	}

	/**
	 * Converts one file on disk. The input format is the path's extension: `report.docx` is read
	 * as `docx`.
	 */
	async convertFile(
		path: string | URL,
		to: string,
		params: Params = {},
		options: ConvertOptions = {},
	): Promise<ConversionResult> {
		const text = typeof path === "string" ? path : path instanceof URL ? decodeURIComponent(path.pathname) : undefined;
		if (text === undefined) throw new TypeError("convertFile() takes a path string or a file: URL");
		const name = text.slice(Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\")) + 1);
		const dot = name.lastIndexOf(".");
		if (dot <= 0 || dot === name.length - 1) {
			throw new RangeError(
				`can't tell the input format of ${JSON.stringify(name)}: it has no extension; use convert() and name the format`,
			);
		}
		return this.convert(name.slice(dot + 1).toLowerCase(), to, path, params, options);
	}

	/** Your plan, its limits and this month's count (`GET /v2/usage`). */
	async usage(options: RequestOptions = {}): Promise<Usage> {
		const http = this.#http;
		return http.request({
			method: "GET",
			url: `${http.baseUrl}/v2/usage`,
			auth: true,
			api: true,
			ok: (status) => status === 200,
			read: parseUsage,
			...callOptions(options),
		});
	}

	/** Every conversion the API offers (`GET /v2/info`). Needs no key. */
	async conversions(options: RequestOptions = {}): Promise<Conversion[]> {
		const http = this.#http;
		return http.request({
			method: "GET",
			url: `${http.baseUrl}/v2/info`,
			auth: false,
			api: true,
			ok: (status) => status === 200,
			read: parseConversions,
			...callOptions(options),
		});
	}

	/** Downloads a stored file's `url` (as returned; no key is sent). */
	async download(url: string, options: RequestOptions = {}): Promise<Uint8Array> {
		return downloadBytes(this.#http, url, callOptions(options));
	}

	/** Downloads a stored file's `url` into `path`, streamed to disk. Returns the path. */
	async downloadTo(url: string, path: string, options: RequestOptions = {}): Promise<string> {
		return downloadToFile(this.#http, url, path, callOptions(options));
	}

	/**
	 * Deletes a stored file before its link expires (`DELETE /v2/d/{fileId}`). Returns `true` when
	 * it was deleted and `false` when there was nothing to delete.
	 */
	async deleteStoredFile(fileId: string, options: RequestOptions = {}): Promise<boolean> {
		if (typeof fileId !== "string" || !FILE_ID.test(fileId)) {
			throw new RangeError("fileId must be 32 hex characters, as in a stored file's fileId");
		}
		const http = this.#http;
		return http.request({
			method: "DELETE",
			url: `${http.baseUrl}/v2/d/${fileId}`,
			auth: true,
			api: true,
			ok: (status) => status === 204 || status === 404,
			read: async (response) => {
				try {
					await response.arrayBuffer();
				} catch {
					// the status is the answer
				}
				return response.status === 204;
			},
			...callOptions(options),
		});
	}
}

function callOptions(options: RequestOptions): RequestOptions {
	if (options === null || typeof options !== "object") throw new TypeError("options must be an object");
	return {
		timeout: options.timeout === undefined ? undefined : checkTimeout(options.timeout, "timeout"),
		signal: options.signal,
	};
}

function checkFormat(format: unknown, which: "from" | "to"): string {
	if (typeof format !== "string") throw new TypeError(`${which} must be a string`);
	if (!FORMAT.test(format)) {
		throw new RangeError(`invalid ${which} format ${JSON.stringify(format)}: use 1 to 20 letters, digits or hyphens`);
	}
	return format.toLowerCase();
}

function checkBaseUrl(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("baseUrl must be a string");
	const trimmed = value.trim().replace(/\/+$/, "");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new TypeError(`baseUrl ${JSON.stringify(value)} is not a valid URL`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:")
		throw new TypeError("baseUrl must be an http or https URL");
	if (url.search || url.hash) throw new TypeError("baseUrl must not have a query string or fragment");
	return trimmed;
}

function checkTimeout(value: unknown, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > MAX_TIMER) {
		throw new RangeError(`${name} must be a number of milliseconds above 0 (and at most ${MAX_TIMER})`);
	}
	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== "object") return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

function checkParams(params: unknown): void {
	if (params === null || typeof params !== "object" || Array.isArray(params) || isFileValue(params)) {
		throw new TypeError("params must be an object of parameter names and values");
	}
}

function checkConvertOptions(options: ConvertOptions): void {
	if (options === null || typeof options !== "object") throw new TypeError("options must be an object");
	if (options.fileName !== undefined && typeof options.fileName !== "string")
		throw new TypeError("fileName must be a string");
	if (options.storeFile !== undefined && typeof options.storeFile !== "boolean") {
		throw new TypeError("storeFile must be a boolean");
	}
}

/** @internal A parameter as form text: numbers in plain decimal, booleans as true/false. */
export function paramText(name: string, value: unknown): string {
	if (typeof value === "string") return value;
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new RangeError(`parameter ${name} must be a finite number`);
		return plainDecimal(value);
	}
	throw new TypeError(
		`parameter ${name} has an unsupported value (${Array.isArray(value) ? "an array" : typeof value}): use a string, number, boolean, null or a file`,
	);
}

/** Writes a finite number without exponent notation: 1e21 -> "1000000000000000000000", 1e-7 -> "0.0000001". */
function plainDecimal(value: number): string {
	if (Object.is(value, -0)) return "0";
	const text = String(value);
	const e = text.indexOf("e");
	if (e < 0) return text;
	const negative = text.startsWith("-");
	const mantissa = text.slice(negative ? 1 : 0, e);
	const exponent = Number(text.slice(e + 1));
	const dot = mantissa.indexOf(".");
	const digits = mantissa.replace(".", "");
	const point = (dot < 0 ? mantissa.length : dot) + exponent;
	let out: string;
	if (point <= 0) out = `0.${"0".repeat(-point)}${digits}`;
	else if (point >= digits.length) out = digits + "0".repeat(point - digits.length);
	else out = `${digits.slice(0, point)}.${digits.slice(point)}`;
	return negative ? `-${out}` : out;
}
