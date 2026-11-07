import {
	atob,
	btoa,
	TextEncoder_encode,
	String_fromCharCode,
	Uint8Array_fromBase64,
	Uint8Array_prototype_toBase64,
	Uint8Array_ctor,
} from "@/shared/snapshot";

// String.fromCharCode has an argument count limit; stay well under it
const CHUNK = 0x8000;

function bytesToBase64Fallback(bytes: Uint8Array): string {
	let binString = "";
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binString += String_fromCharCode(
			...(bytes.subarray(i, i + CHUNK) as unknown as number[])
		);
	}

	return btoa(binString);
}

export const bytesToBase64: (bytes: Uint8Array) => string =
	typeof Uint8Array_prototype_toBase64 === "function"
		? (bytes) => Uint8Array_prototype_toBase64.call(bytes)
		: bytesToBase64Fallback;

function base64ToBytesFallback(base64: string): Uint8Array {
	const binString = atob(base64);
	const len = binString.length;
	const bytes = new Uint8Array_ctor(len);
	for (let i = 0; i < len; i++) bytes[i] = binString.charCodeAt(i);

	return bytes;
}

export const base64ToBytes: (base64: string) => Uint8Array =
	Uint8Array_fromBase64 ?? base64ToBytesFallback;

export function base64Encode(text: string) {
	return bytesToBase64(TextEncoder_encode(text));
}
