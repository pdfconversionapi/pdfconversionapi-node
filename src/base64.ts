// Strict base64 decoding (standard alphabet, `=` padding) that needs no Buffer, so it works in
// every runtime. Returns null for anything that isn't valid base64.

const INVALID = 255;
const TABLE = new Uint8Array(128).fill(INVALID);
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
for (let i = 0; i < ALPHABET.length; i++) TABLE[ALPHABET.charCodeAt(i)] = i;

function value(text: string, index: number): number {
	const code = text.charCodeAt(index);
	return code < 128 ? (TABLE[code] as number) : INVALID;
}

/** @internal Decodes standard base64 with padding; returns null when the text isn't valid. */
export function decodeBase64(text: string): Uint8Array | null {
	const length = text.length;
	if (length % 4 !== 0) return null;
	if (length === 0) return new Uint8Array(0);
	let padding = 0;
	if (text.charCodeAt(length - 1) === 61) padding = text.charCodeAt(length - 2) === 61 ? 2 : 1;
	const out = new Uint8Array((length / 4) * 3 - padding);
	const fullEnd = padding === 0 ? length : length - 4;
	let o = 0;
	for (let i = 0; i < fullEnd; i += 4) {
		const a = value(text, i);
		const b = value(text, i + 1);
		const c = value(text, i + 2);
		const d = value(text, i + 3);
		if ((a | b | c | d) > 63) return null; // INVALID (255) sets bits above 63
		const n = (a << 18) | (b << 12) | (c << 6) | d;
		out[o++] = n >> 16;
		out[o++] = (n >> 8) & 255;
		out[o++] = n & 255;
	}
	if (padding > 0) {
		const a = value(text, length - 4);
		const b = value(text, length - 3);
		if (a === INVALID || b === INVALID) return null;
		if (padding === 2) {
			out[o] = (a << 2) | (b >> 4);
		} else {
			const c = value(text, length - 2);
			if (c === INVALID) return null;
			out[o++] = (a << 2) | (b >> 4);
			out[o] = ((b & 15) << 4) | (c >> 2);
		}
	}
	return out;
}
