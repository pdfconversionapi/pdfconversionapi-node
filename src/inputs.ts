// Input files: what callers may pass, and how each form becomes bytes and a name to upload.

import { loadFs, randomHex } from "./runtime.js";

/** A stream of bytes: a web `ReadableStream`, or any async iterable such as a Node.js `Readable`. */
export type StreamInput = ReadableStream<Uint8Array> | AsyncIterable<Uint8Array | string>;

/**
 * An input file. A plain **string is a path** on disk (as is a `file:` URL). Bytes, Blobs and
 * streams are uploaded as they are; wrap them in {@link UploadFile} to give them a name (a
 * `File` brings its own). Unnamed inputs are uploaded as `file`.
 */
export type FileInput = string | URL | Uint8Array | ArrayBuffer | Blob | StreamInput | UploadFile;

type Source =
	| { readonly kind: "path"; readonly path: string | URL }
	| { readonly kind: "bytes"; readonly data: Uint8Array | ArrayBuffer }
	| { readonly kind: "blob"; readonly blob: Blob }
	| { readonly kind: "stream"; readonly stream: StreamInput };

/**
 * An input file with an explicit form and, optionally, the name to upload it under.
 *
 * ```ts
 * UploadFile.fromPath("report.docx");
 * UploadFile.fromBytes(bytes, "report.docx");
 * UploadFile.fromStream(fs.createReadStream("big.pdf"), "big.pdf");
 * UploadFile.fromBlob(blob, "photo.jpg");
 * ```
 */
export class UploadFile {
	/** The name given to the factory, if any. */
	readonly name: string | undefined;
	readonly #source: Source;
	#materialized: Promise<Blob> | undefined;

	private constructor(source: Source, name: string | undefined) {
		if (name !== undefined && typeof name !== "string") throw new TypeError("the file name must be a string");
		this.#source = source;
		this.name = name;
	}

	/** A file on disk. It is read again for each attempt; the name sent is the path's last part unless `name` is given. */
	static fromPath(path: string | URL, name?: string): UploadFile {
		checkPath(path);
		return new UploadFile({ kind: "path", path }, name);
	}

	/** Bytes in memory. They are copied when the request is built. */
	static fromBytes(data: Uint8Array | ArrayBuffer, name?: string): UploadFile {
		if (!(ArrayBuffer.isView(data) || isArrayBuffer(data))) {
			throw new TypeError("UploadFile.fromBytes() takes a Uint8Array, Buffer or ArrayBuffer");
		}
		return new UploadFile({ kind: "bytes", data }, name);
	}

	/** A Blob or File. A File's own name is used unless `name` is given. */
	static fromBlob(blob: Blob, name?: string): UploadFile {
		if (!isBlobLike(blob)) throw new TypeError("UploadFile.fromBlob() takes a Blob or File");
		return new UploadFile({ kind: "blob", blob }, name);
	}

	/**
	 * A stream (web `ReadableStream`, Node.js `Readable`, or any async iterable of bytes). It is read
	 * into memory once, before the first attempt, so retries send the same bytes; the UploadFile
	 * keeps those bytes and can be used again.
	 */
	static fromStream(stream: StreamInput, name?: string): UploadFile {
		if (!isStream(stream)) throw new TypeError("UploadFile.fromStream() takes a ReadableStream or an async iterable");
		return new UploadFile({ kind: "stream", stream }, name);
	}

	/** @internal */
	async prepare(): Promise<PreparedFile> {
		const source = this.#source;
		if (source.kind === "path")
			return { name: uploadName(this.name ?? lastPart(pathText(source.path))), path: source.path };
		if (source.kind === "blob") {
			const own = (source.blob as { name?: unknown }).name;
			return {
				name: uploadName(this.name ?? (typeof own === "string" ? own : undefined)),
				blob: await toNativeBlob(source.blob),
			};
		}
		if (source.kind === "bytes") return { name: uploadName(this.name), blob: bytesToBlob(source.data) };
		this.#materialized ??= readStream(source.stream);
		return { name: uploadName(this.name ?? streamPathName(source.stream)), blob: await this.#materialized };
	}
}

/** @internal An input ready to send: a name, and either a path (re-read each attempt) or a Blob. */
export type PreparedFile =
	| { name: string; path: string | URL; blob?: undefined }
	| { name: string; blob: Blob; path?: undefined };

/** @internal Turns any accepted input into a prepared file. Throws TypeError for anything else. */
export async function prepareInput(input: unknown): Promise<PreparedFile> {
	if (input instanceof UploadFile) return input.prepare();
	if (typeof input === "string" || isUrl(input)) return UploadFile.fromPath(input).prepare();
	if (ArrayBuffer.isView(input) || isArrayBuffer(input)) return UploadFile.fromBytes(input as Uint8Array).prepare();
	if (isBlobLike(input)) return UploadFile.fromBlob(input).prepare();
	if (isStream(input)) return UploadFile.fromStream(input).prepare();
	throw new TypeError(
		`unsupported input file (${describe(input)}): pass a path string, a file: URL, a Uint8Array, an ArrayBuffer, a Blob, a stream or an UploadFile`,
	);
}

/** @internal Whether a value is a file input (anything but a string, which in params is text). */
export function isFileValue(value: unknown): boolean {
	return (
		value instanceof UploadFile ||
		isUrl(value) ||
		ArrayBuffer.isView(value) ||
		isArrayBuffer(value) ||
		isBlobLike(value) ||
		isStream(value)
	);
}

/** @internal Reads a path into a Blob (a file-backed one where the runtime supports it). */
export async function readPath(path: string | URL): Promise<Blob> {
	const { fs, openAsBlob } = await loadFs();
	// stat first: it fails with the usual ENOENT/EACCES, where openAsBlob's own error is vague.
	const stat = await fs.stat(path);
	if (openAsBlob && stat.isFile()) return openAsBlob(path);
	return bytesToBlob(await fs.readFile(path));
}

/** @internal The file's own name: anything up to the last `/` or `\` removed. */
export function lastPart(name: string): string {
	return name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1);
}

function uploadName(name: string | undefined): string {
	const own = name === undefined ? "" : lastPart(name);
	return own === "" ? "file" : own;
}

function pathText(path: string | URL): string {
	if (typeof path === "string") return path;
	try {
		return decodeURIComponent(path.pathname);
	} catch {
		return path.pathname;
	}
}

function checkPath(path: unknown): asserts path is string | URL {
	if (typeof path === "string") {
		if (path === "") throw new RangeError("the path is empty");
		return;
	}
	if (isUrl(path)) {
		if (path.protocol !== "file:") {
			throw new TypeError(
				`only file: URLs can be uploaded, not ${path.protocol} URLs; the API doesn't fetch URLs, so download the file and pass its bytes`,
			);
		}
		return;
	}
	throw new TypeError("a path must be a string or a file: URL");
}

function streamPathName(stream: StreamInput): string | undefined {
	// fs.createReadStream() keeps its path; use its last part as the default name.
	const path = (stream as { path?: unknown }).path;
	return typeof path === "string" ? lastPart(path) : undefined;
}

async function readStream(stream: StreamInput): Promise<Blob> {
	const chunks: Uint8Array[] = [];
	const encoder = new TextEncoder();
	const add = (chunk: unknown) => {
		if (typeof chunk === "string") chunks.push(encoder.encode(chunk));
		else if (ArrayBuffer.isView(chunk)) chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		else if (isArrayBuffer(chunk)) chunks.push(new Uint8Array(chunk));
		else throw new TypeError(`a stream gave a ${describe(chunk)} chunk; streams must give bytes or strings`);
	};
	if (typeof (stream as ReadableStream).getReader === "function") {
		const reader = (stream as ReadableStream<unknown>).getReader();
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				add(value);
			}
		} finally {
			reader.releaseLock();
		}
	} else {
		for await (const chunk of stream as AsyncIterable<unknown>) add(chunk);
	}
	return new Blob(chunks);
}

function bytesToBlob(data: ArrayBufferView | ArrayBuffer): Blob {
	// Copies the bytes, so later changes to the caller's buffer don't change a retry.
	const view = ArrayBuffer.isView(data)
		? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
		: new Uint8Array(data);
	return new Blob([view.slice()]);
}

async function toNativeBlob(blob: Blob): Promise<Blob> {
	if (typeof Blob === "function" && blob instanceof Blob) return blob;
	return new Blob([new Uint8Array(await blob.arrayBuffer())]);
}

function isArrayBuffer(value: unknown): value is ArrayBuffer {
	return (
		value instanceof ArrayBuffer ||
		Object.prototype.toString.call(value) === "[object ArrayBuffer]" ||
		Object.prototype.toString.call(value) === "[object SharedArrayBuffer]"
	);
}

function isUrl(value: unknown): value is URL {
	return (
		(typeof URL === "function" && value instanceof URL) ||
		(value !== null &&
			typeof value === "object" &&
			Object.prototype.toString.call(value) === "[object URL]" &&
			typeof (value as URL).href === "string")
	);
}

function isBlobLike(value: unknown): value is Blob {
	if (typeof Blob === "function" && value instanceof Blob) return true;
	return (
		value !== null &&
		typeof value === "object" &&
		typeof (value as Blob).arrayBuffer === "function" &&
		typeof (value as Blob).size === "number" &&
		typeof (value as Blob).stream === "function"
	);
}

function isStream(value: unknown): value is StreamInput {
	return (
		value !== null &&
		typeof value === "object" &&
		(typeof (value as ReadableStream).getReader === "function" ||
			typeof (value as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function")
	);
}

function describe(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "an array";
	if (typeof value === "object") return (value as object).constructor?.name ?? "object";
	return typeof value;
}

// ---- multipart/form-data ----------------------------------------------------------------------

/** @internal One field of the form: a file or a text value. */
export type FormField = { name: string; file: PreparedFile } | { name: string; value: string };

/** @internal Escapes a field name inside `name="..."` the way HTML forms do. */
export function escapeQuoted(text: string): string {
	return text.replace(/"/g, "%22").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}

/**
 * @internal A file name for `filename="..."`: `"`, CR and LF become `_` (SPEC 1.2). The API reads
 * `%22` literally, and turns a quote into `_` itself when it cleans the name.
 */
export function quotedFileName(name: string): string {
	return name.replace(/["\r\n]/g, "_");
}

/**
 * @internal Builds a multipart/form-data body. Built by hand rather than with FormData so every
 * runtime sends the same bytes: file names as raw UTF-8 in `filename="..."` (the API reads only
 * that), with `"`, CR and LF replaced by `_`, and text values exactly as given.
 * Path inputs are read here, so each attempt reads the file again.
 */
export async function buildMultipart(fields: readonly FormField[]): Promise<{ body: Blob; contentType: string }> {
	const boundary = `----pdfconversionapi-${randomHex(32)}`;
	const parts: Array<string | Blob> = [];
	for (const field of fields) {
		if ("file" in field) {
			const blob = field.file.blob ?? (await readPath(field.file.path));
			parts.push(
				`--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(field.name)}"; filename="${quotedFileName(field.file.name)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
				blob,
				"\r\n",
			);
		} else {
			parts.push(
				`--${boundary}\r\nContent-Disposition: form-data; name="${escapeQuoted(field.name)}"\r\n\r\n`,
				field.value,
				"\r\n",
			);
		}
	}
	parts.push(`--${boundary}--\r\n`);
	return { body: new Blob(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}
