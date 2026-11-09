// What calls return: conversion results and their files, usage, and the list of conversions.

import { decodeBase64 } from "./base64.js";
import { InvalidResponseError, StoredFileError } from "./errors.js";
import { type Http, type RequestOptions, readBody } from "./http.js";
import { lastPart } from "./inputs.js";
import { loadFs, randomHex } from "./runtime.js";

/** One output file of a conversion. */
export class OutputFile {
	/** The file's name, extension included, for example `report.pdf`. */
	readonly name: string;
	/** The extension in lower case, without the dot. */
	readonly ext: string;
	/** The size in bytes. */
	readonly size: number;
	/** Whether the API stored the file (`storeFile: true`) instead of sending its data. */
	readonly stored: boolean;
	/** The download link of a stored file (it works for 3 hours and needs no key), else `null`. */
	readonly url: string | null;
	/** The id of a stored file (32 hex characters), for `deleteStoredFile()`, else `null`. */
	readonly fileId: string | null;
	readonly #data: Uint8Array | null;
	readonly #http: Http;

	/** @internal */
	constructor(
		init: {
			name: string;
			ext: string;
			size: number;
			data: Uint8Array | null;
			url: string | null;
			fileId: string | null;
		},
		http: Http,
	) {
		this.name = init.name;
		this.ext = init.ext;
		this.size = init.size;
		this.stored = init.data === null;
		this.url = init.url;
		this.fileId = init.fileId;
		this.#data = init.data;
		this.#http = http;
	}

	/** The file's bytes. Throws StoredFileError for a stored file: use `download()` instead. */
	get data(): Uint8Array {
		if (this.#data === null) {
			throw new StoredFileError(
				`${this.name} is a stored file, so the response has no data for it; call download() or save() to fetch it`,
			);
		}
		return this.#data;
	}

	/** The file's bytes, like `data`. Throws StoredFileError for a stored file. */
	bytes(): Uint8Array {
		return this.data;
	}

	/** The file's bytes: fetched from `url` for a stored file (without the API key), else `data`. */
	async download(options: RequestOptions = {}): Promise<Uint8Array> {
		if (this.#data !== null) return this.#data;
		return downloadBytes(this.#http, this.#storedUrl(), options);
	}

	/** Writes the file to exactly `path` (a stored file is streamed to disk). Returns the path. */
	async downloadTo(path: string, options: RequestOptions = {}): Promise<string> {
		checkOutputPath(path);
		if (this.#data !== null) {
			const { fs } = await loadFs();
			await fs.writeFile(path, this.#data);
			return path;
		}
		return downloadToFile(this.#http, this.#storedUrl(), path, options);
	}

	/**
	 * Writes the file to `path`, or inside `path` under its own name when `path` is an existing
	 * folder. Overwrites an existing file. A stored file is downloaded (streamed) first. Returns
	 * the path written.
	 */
	async save(path: string, options: RequestOptions = {}): Promise<string> {
		checkOutputPath(path);
		const { fs, path: paths } = await loadFs();
		const stat = await fs.stat(path).catch(() => null);
		const target = stat?.isDirectory() ? paths.join(path, safeName(this.name)) : path;
		return this.downloadTo(target, options);
	}

	#storedUrl(): string {
		if (this.url === null) throw new InvalidResponseError(`${this.name} has neither data nor a link`, null);
		return this.url;
	}
}

/** The result of a conversion. */
export class ConversionResult {
	/** Every output file, in the API's order. */
	readonly files: readonly OutputFile[];
	/** Conversions counted for this request (always 1). */
	readonly conversionCost: number;
	/** Seconds the conversion took on the API's side. */
	readonly conversionTime: number;
	/** The response's `x-request-id`; send it with any question about this request. */
	readonly requestId: string | null;

	/** @internal */
	constructor(files: OutputFile[], conversionCost: number, conversionTime: number, requestId: string | null) {
		this.files = Object.freeze(files);
		this.conversionCost = conversionCost;
		this.conversionTime = conversionTime;
		this.requestId = requestId;
	}

	/** The first output file: the only one for most conversions. */
	get file(): OutputFile {
		return this.files[0] as OutputFile;
	}

	/**
	 * Writes every file into `dir` under its own name, creating the folder if needed and
	 * overwriting files already there. Stored files are downloaded. Returns the paths written.
	 */
	async saveAll(dir: string, options: RequestOptions = {}): Promise<string[]> {
		checkOutputPath(dir);
		const { fs, path } = await loadFs();
		await fs.mkdir(dir, { recursive: true });
		const written: string[] = [];
		for (const file of this.files) {
			written.push(await file.downloadTo(path.join(dir, safeName(file.name)), options));
		}
		return written;
	}
}

/** Your plan, its limits and this month's count (`GET /v2/usage`). */
export interface Usage {
	/** The plan's name, for example `Free`. */
	readonly plan: string;
	/** Successful conversions included each month. */
	readonly included: number;
	/** Successful conversions so far this month. */
	readonly used: number;
	/** What is left of `included` this month, or `null` when the API doesn't say. */
	readonly remaining: number | null;
	/** Whether the plan keeps converting past `included`. */
	readonly overage: boolean;
	/** Conversions running for the account right now. */
	readonly running: number;
	/** How many conversions the plan runs at the same time. */
	readonly concurrentLimit: number;
	/** The largest request the plan accepts, all files together, in MB. */
	readonly maxUploadMb: number;
	/** Start of this month's count (UTC). */
	readonly periodStart: Date;
	/** End of this month's count (UTC); the count starts again then. */
	readonly periodEnd: Date;
}

/** One conversion the API offers (`GET /v2/info`). */
export interface Conversion {
	/** The input format, as in `/v2/convert/{from}/to/{to}`. */
	readonly from: string;
	/** The output format or tool name. */
	readonly to: string;
	/** For example `DOCX to PDF`. */
	readonly title: string;
	/** For example `Document` or `PDF Tools`. */
	readonly category: string;
	/** How many files it takes: `one`, `many` or `optional`. */
	readonly inputs: "one" | "many" | "optional" | (string & {});
}

// ---- parsing ------------------------------------------------------------------------------------

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
	value !== null && typeof value === "object" && !Array.isArray(value);

async function readJson(response: Response): Promise<{ json: unknown; requestId: string | null }> {
	const requestId = response.headers.get("x-request-id");
	const text = await readBody(response.text());
	try {
		return { json: JSON.parse(text), requestId };
	} catch {
		throw new InvalidResponseError("the API answered 200 with a body that isn't JSON", requestId);
	}
}

/** @internal Parses a conversion response; decodes every FileData and checks its size. */
export async function parseConversion(response: Response, http: Http): Promise<ConversionResult> {
	const { json, requestId } = await readJson(response);
	const invalid = (message: string) => new InvalidResponseError(message, requestId);
	if (!isObject(json) || !Array.isArray(json.Files)) throw invalid("the response has no Files array");
	if (json.Files.length === 0) throw invalid("the response's Files array is empty");
	const files = json.Files.map((entry: unknown, index: number) => {
		if (!isObject(entry)) throw invalid(`Files[${index}] is not an object`);
		const { FileName: name, FileExt: ext, FileSize: size, FileData: data, Url: url, FileId: fileId } = entry;
		if (typeof name !== "string") throw invalid(`Files[${index}] has no FileName`);
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
			throw invalid(`Files[${index}] (${name}) has no valid FileSize`);
		}
		const extension = typeof ext === "string" ? ext : name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : "";
		if (typeof data === "string") {
			const bytes = decodeBase64(data);
			if (bytes === null) throw invalid(`Files[${index}] (${name}) has FileData that isn't valid base64`);
			if (bytes.length !== size) {
				throw invalid(`Files[${index}] (${name}) decodes to ${bytes.length} bytes, but FileSize says ${size}`);
			}
			const link = typeof url === "string" ? url : null;
			const id = typeof fileId === "string" ? fileId : null;
			return new OutputFile({ name, ext: extension, size, data: bytes, url: link, fileId: id }, http);
		}
		if (typeof url !== "string" || typeof fileId !== "string") {
			throw invalid(`Files[${index}] (${name}) has neither FileData nor Url and FileId`);
		}
		return new OutputFile({ name, ext: extension, size, data: null, url, fileId }, http);
	});
	const cost = json.ConversionCost ?? 0;
	const time = json.ConversionTime ?? 0;
	if (typeof cost !== "number" || typeof time !== "number")
		throw invalid("ConversionCost or ConversionTime is not a number");
	return new ConversionResult(files, cost, time, requestId);
}

/** @internal */
export async function parseUsage(response: Response): Promise<Usage> {
	const { json, requestId } = await readJson(response);
	const invalid = (field: string) => new InvalidResponseError(`the usage response has no valid ${field}`, requestId);
	if (!isObject(json)) throw invalid("body");
	const num = (field: string): number => {
		const value = json[field];
		if (typeof value !== "number") throw invalid(field);
		return value;
	};
	const date = (field: string): Date => {
		const value = json[field];
		const parsed = typeof value === "string" ? new Date(value) : new Date(Number.NaN);
		if (Number.isNaN(parsed.getTime())) throw invalid(field);
		return parsed;
	};
	if (typeof json.Plan !== "string") throw invalid("Plan");
	if (typeof json.Overage !== "boolean") throw invalid("Overage");
	const remaining = json.Remaining;
	if (remaining !== null && remaining !== undefined && typeof remaining !== "number") throw invalid("Remaining");
	return {
		plan: json.Plan,
		included: num("Included"),
		used: num("Used"),
		remaining: typeof remaining === "number" ? remaining : null,
		overage: json.Overage,
		running: num("Running"),
		concurrentLimit: num("ConcurrentLimit"),
		maxUploadMb: num("MaxUploadMB"),
		periodStart: date("PeriodStart"),
		periodEnd: date("PeriodEnd"),
	};
}

/** @internal */
export async function parseConversions(response: Response): Promise<Conversion[]> {
	const { json, requestId } = await readJson(response);
	if (!Array.isArray(json)) throw new InvalidResponseError("the list of conversions is not a JSON array", requestId);
	return json.map((entry: unknown, index: number): Conversion => {
		if (
			!isObject(entry) ||
			typeof entry.From !== "string" ||
			typeof entry.To !== "string" ||
			typeof entry.Title !== "string" ||
			typeof entry.Category !== "string" ||
			typeof entry.Inputs !== "string"
		) {
			throw new InvalidResponseError(`conversion ${index} is missing From, To, Title, Category or Inputs`, requestId);
		}
		return { from: entry.From, to: entry.To, title: entry.Title, category: entry.Category, inputs: entry.Inputs };
	});
}

// ---- downloads ----------------------------------------------------------------------------------

/** @internal GET a stored file's bytes, without the key. */
export function downloadBytes(http: Http, url: string, options: RequestOptions): Promise<Uint8Array> {
	return http.request({
		method: "GET",
		url: checkDownloadUrl(url),
		auth: false,
		api: false,
		ok: (status) => status === 200,
		read: async (response) => new Uint8Array(await readBody(response.arrayBuffer())),
		timeout: options.timeout,
		signal: options.signal,
	});
}

/** @internal GET a stored file into `path`, streamed through a temporary file in the same folder. */
export async function downloadToFile(http: Http, url: string, path: string, options: RequestOptions): Promise<string> {
	checkOutputPath(path);
	const checkedUrl = checkDownloadUrl(url);
	const { fs } = await loadFs();
	await http.request({
		method: "GET",
		url: checkedUrl,
		auth: false,
		api: false,
		ok: (status) => status === 200,
		read: async (response) => {
			const temporary = `${path}.${randomHex(12)}.part`;
			try {
				const handle = await fs.open(temporary, "w");
				try {
					const reader = response.body?.getReader();
					if (reader) {
						for (;;) {
							const { done, value } = await readBody(reader.read());
							if (done) break;
							await handle.write(value);
						}
					}
				} finally {
					await handle.close();
				}
				await fs.rename(temporary, path);
			} catch (error) {
				await fs.rm(temporary, { force: true }).catch(() => {});
				throw error;
			}
		},
		timeout: options.timeout,
		signal: options.signal,
	});
	return path;
}

function checkDownloadUrl(url: unknown): string {
	const text = typeof url === "string" ? url : url instanceof URL ? url.href : undefined;
	if (text === undefined) throw new TypeError("the download URL must be a string");
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		throw new RangeError("the download URL is not a valid absolute URL; use the url of a stored file as returned");
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new RangeError("the download URL must be an http or https URL");
	}
	return text;
}

function checkOutputPath(path: unknown): asserts path is string {
	if (typeof path !== "string") throw new TypeError("the output path must be a string");
	if (path === "") throw new RangeError("the output path is empty");
}

/** @internal The name to write a file under: its own name only, refusing `.`, `..` and empty names. */
export function safeName(name: string): string {
	const own = lastPart(name);
	if (own === "" || own === "." || own === ".." || own.includes("\0")) {
		throw new InvalidResponseError(`refusing to write a file named ${JSON.stringify(name)}`, null);
	}
	return own;
}
