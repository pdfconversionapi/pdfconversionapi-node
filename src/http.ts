// One request loop for every call, downloads included: timeouts, retries and error mapping
// (SPEC sections 8 to 10).

import {
	apiErrorFor,
	ConnectionError,
	errorMessage,
	MissingApiKeyError,
	PdfConversionApiError,
	TimeoutError,
} from "./errors.js";
import { IS_BUN, USER_AGENT } from "./runtime.js";

/** A `fetch` function: the global one, or one you pass in (for a proxy, a mock, or instrumentation). */
export type FetchFunction = (input: string, init: RequestInit) => Promise<Response>;

/** Waits between retries. `ms` is the wait in milliseconds; reject when `signal` aborts. */
export type SleepFunction = (ms: number, signal?: AbortSignal) => Promise<void>;

/** @internal */
export interface HttpConfig {
	apiKey: string | undefined;
	baseUrl: string;
	timeout: number;
	maxRetries: number;
	maxRetryWait: number;
	fetch: FetchFunction | undefined;
	sleep: SleepFunction;
}

/** Options for one request. */
export interface RequestOptions {
	/** Time allowed for each attempt of this call, in milliseconds. Overrides the client's `timeout`. */
	timeout?: number | undefined;
	/** Cancels the call (and any wait between retries). */
	signal?: AbortSignal | undefined;
}

/** @internal What one call sends and how its success is read. */
export interface Call<T> extends RequestOptions {
	method: "GET" | "POST" | "DELETE";
	url: string;
	/** Send the API key. */
	auth: boolean;
	/** An API call (Accept: application/json), as opposed to a download. */
	api: boolean;
	/** Builds the body for each attempt. */
	body?: () => Promise<{ body: Blob; contentType: string }>;
	/** Statuses that `read` handles; every other status is an error. */
	ok: (status: number) => boolean;
	read: (response: Response) => Promise<T>;
}

/** @internal No response arrived (refused, reset or dropped before a status line): retried. */
class NoResponse {
	constructor(readonly cause: unknown) {}
}

/** @internal The connection failed after the status line arrived: raised at once, never retried. */
export class BodyFailure {
	constructor(readonly cause: unknown) {}
}

/**
 * @internal Awaits a read of the response body, tagging a failure as a BodyFailure. Such a
 * failure is never retried: a 200 may already have counted a conversion (SPEC 8, step 3a).
 */
export async function readBody<T>(operation: Promise<T>): Promise<T> {
	try {
		return await operation;
	} catch (cause) {
		throw new BodyFailure(cause);
	}
}

/** @internal The default sleep: a timer that an abort signal can cut short. */
export const realSleep: SleepFunction = (ms, signal) =>
	new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});

/** @internal `Retry-After` as whole seconds; null when missing or unreadable. */
export function parseRetryAfter(header: string | null): number | null {
	if (header === null || !/^\s*\d+\s*$/.test(header)) return null;
	const seconds = Number(header.trim());
	return Number.isSafeInteger(seconds) ? seconds : null;
}

/** @internal Uniformly random seconds in [0, 2^attempt). */
export function jitter(attempt: number): number {
	return Math.random() * 2 ** attempt;
}

/** One attempt's timeout and abort wiring. */
class AttemptScope {
	readonly controller = new AbortController();
	timedOut = false;
	readonly #timer: ReturnType<typeof setTimeout>;
	readonly #signal: AbortSignal | undefined;
	readonly #onAbort: () => void;

	constructor(timeout: number, signal: AbortSignal | undefined) {
		this.#signal = signal;
		this.#onAbort = () => this.controller.abort(signal?.reason);
		this.#timer = setTimeout(() => {
			this.timedOut = true;
			this.controller.abort();
		}, timeout);
		if (signal) {
			if (signal.aborted) this.controller.abort(signal.reason);
			else signal.addEventListener("abort", this.#onAbort, { once: true });
		}
	}

	done(): void {
		clearTimeout(this.#timer);
		this.#signal?.removeEventListener("abort", this.#onAbort);
	}
}

type Outcome<T> = { value: T } | { wait: number };

/** @internal Holds the client's settings, including the key, in private fields. */
export class Http {
	readonly #apiKey: string | undefined;
	readonly baseUrl: string;
	readonly timeout: number;
	readonly maxRetries: number;
	readonly maxRetryWait: number;
	readonly #fetch: FetchFunction | undefined;
	readonly #sleep: SleepFunction;

	constructor(config: HttpConfig) {
		this.#apiKey = config.apiKey;
		this.baseUrl = config.baseUrl;
		this.timeout = config.timeout;
		this.maxRetries = config.maxRetries;
		this.maxRetryWait = config.maxRetryWait;
		this.#fetch = config.fetch;
		this.#sleep = config.sleep;
	}

	/** Throws MissingApiKeyError when there is no key. */
	requireKey(): void {
		if (!this.#apiKey) throw new MissingApiKeyError();
	}

	async request<T>(call: Call<T>): Promise<T> {
		const fetchFn = this.#fetch ?? (globalThis as { fetch?: FetchFunction }).fetch;
		if (typeof fetchFn !== "function") {
			throw new PdfConversionApiError("no fetch function: use Node.js 18 or later, or pass fetch to the client");
		}
		if (call.auth) this.requireKey();
		const timeout = call.timeout ?? this.timeout;
		const attempts = this.maxRetries + 1;
		let retried500 = false;

		for (let attempt = 1; ; attempt++) {
			call.signal?.throwIfAborted();
			const canRetry = attempt < attempts;
			const payload = call.body ? await call.body() : undefined; // file errors here are not retried
			const scope = new AttemptScope(timeout, call.signal);
			let outcome: Outcome<T>;
			try {
				let response: Response;
				try {
					response = await fetchFn(call.url, this.#init(call, payload, scope.controller.signal));
				} catch (cause) {
					throw new NoResponse(cause);
				}
				outcome = await this.#handle(call, response, attempt, canRetry, retried500);
				if ("wait" in outcome && response.status === 500) retried500 = true;
			} catch (error) {
				if (scope.timedOut) throw new TimeoutError(timeout);
				if (call.signal?.aborted) throw call.signal.reason;
				if (error instanceof BodyFailure) throw connectionError(call.url, attempt, error.cause, true);
				if (!(error instanceof NoResponse)) throw error;
				if (!canRetry) throw connectionError(call.url, attempt, error.cause, false);
				outcome = { wait: jitter(attempt) };
			} finally {
				scope.done();
			}
			if ("value" in outcome) return outcome.value;
			await this.#sleep(outcome.wait * 1000, call.signal);
		}
	}

	#init(
		call: Call<unknown>,
		payload: { body: Blob; contentType: string } | undefined,
		signal: AbortSignal,
	): RequestInit {
		const headers: Record<string, string> = { "User-Agent": USER_AGENT };
		if (call.api) headers.Accept = "application/json";
		if (call.auth && this.#apiKey) headers.Authorization = `Bearer ${this.#apiKey}`;
		if (payload) headers["Content-Type"] = payload.contentType;
		// No redirects are followed: the API never redirects, and following one could carry the
		// key (or a download) to another host. A 3xx is raised as an ApiError.
		const init: RequestInit = { method: call.method, headers, signal, redirect: "manual" };
		if (payload) init.body = payload.body;
		// Bun 1.3 silently sends a request again when a pooled connection closes, even after a 200
		// status line arrived, which could run a conversion twice. Without pooling it sends once.
		if (IS_BUN) init.keepalive = false;
		return init;
	}

	async #handle<T>(
		call: Call<T>,
		response: Response,
		attempt: number,
		canRetry: boolean,
		retried500: boolean,
	): Promise<Outcome<T>> {
		const status = response.status;
		if (call.ok(status)) return { value: await call.read(response) };

		const headerRetryAfter = parseRetryAfter(response.headers.get("retry-after"));
		if (status === 429 || status === 503) {
			const retryAfter = headerRetryAfter ?? 1;
			if (canRetry && retryAfter * 1000 <= this.maxRetryWait) {
				await drain(response);
				return { wait: retryAfter + jitter(attempt) };
			}
			throw await errorFrom(response, retryAfter);
		}
		if (status === 500 && !retried500 && canRetry) {
			await drain(response);
			return { wait: 1 + jitter(attempt) };
		}
		throw await errorFrom(response, headerRetryAfter);
	}
}

async function errorFrom(response: Response, retryAfter: number | null) {
	const body = await readBody(response.text());
	return apiErrorFor({
		status: response.status,
		message: errorMessage(body, response.headers.get("content-type")),
		requestId: response.headers.get("x-request-id"),
		retryAfter,
		body,
	});
}

async function drain(response: Response): Promise<void> {
	try {
		await response.arrayBuffer();
	} catch {
		// the response is being discarded anyway
	}
}

function connectionError(url: string, attempts: number, cause: unknown, afterStatus: boolean): ConnectionError {
	let host = url;
	try {
		host = new URL(url).host;
	} catch {
		// keep the url
	}
	const detail = describeCause(cause);
	const suffix = detail ? ` (${detail})` : "";
	if (afterStatus) {
		return new ConnectionError(
			`the connection to ${host} failed while reading the response${suffix}; not retried, because the conversion may already have run and counted`,
			attempts,
			cause,
		);
	}
	const tries = attempts === 1 ? "1 attempt" : `${attempts} attempts`;
	return new ConnectionError(`no response from ${host} after ${tries}${suffix}`, attempts, cause);
}

function describeCause(cause: unknown): string {
	const parts: string[] = [];
	let current: unknown = cause;
	for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
		if (current.message && !parts.includes(current.message)) parts.push(current.message);
		current = current.cause;
	}
	return parts.join(": ");
}
