export const textEncodings = {
	'utf-8': 'UTF-8',
	'utf-16le': 'UTF-16 LE',
	'utf-16be': 'UTF-16 BE',
	gb18030: 'GB18030',
	gbk: 'GBK',
	big5: 'Big5',
	shift_jis: 'Shift JIS',
	'windows-1252': 'Windows-1252',
} as const;

export type TextEncoding = keyof typeof textEncodings;

export type EncodingChoice = 'auto' | TextEncoding;

export class UnrepresentableTextError extends Error {}

function decode(bytes: Uint8Array<ArrayBuffer>, encoding: TextEncoding, bom = false) {
	const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
	if (text.includes('\0')) throw new TypeError('Binary file');
	return { text, encoding, bom };
}

export async function decodeText(buffer: ArrayBuffer, choice: EncodingChoice) {
	const bytes = new Uint8Array(buffer);
	const [a, b, c] = bytes;
	const signature =
		a === 0xff && b === 0xfe
			? 'utf-16le'
			: a === 0xfe && b === 0xff
				? 'utf-16be'
				: a === 0xef && b === 0xbb && c === 0xbf
					? 'utf-8'
					: undefined;
	if (choice !== 'auto') return decode(bytes, choice, signature === choice);
	if (signature) return decode(bytes, signature, true);
	if (bytes.includes(0)) throw new TypeError('Binary file');
	try {
		return decode(bytes, 'utf-8');
	} catch {
		// Only non-Unicode input needs statistical detection.
	}
	try {
		const { default: detector } = await import('jschardet');
		const { encoding } = detector.detect(bytes.subarray(0, 256 * 1024), {
			detectEncodings: ['GB18030', 'GB2312', 'GBK', 'Big5', 'SHIFT_JIS', 'windows-1252'],
		});
		const detected = encoding?.toLowerCase();
		const normalized = detected === 'gbk' || detected === 'gb2312' ? 'gb18030' : detected;
		if (normalized && Object.hasOwn(textEncodings, normalized)) return decode(bytes, normalized as TextEncoding);
	} catch {
		// Statistical detection can pick an encoding that rejects valid GBK bytes.
	}
	return decode(bytes, 'gb18030');
}

export async function encodeText(text: string, encoding: TextEncoding, bom: boolean): Promise<Uint8Array<ArrayBuffer>> {
	const source = bom ? '\uFEFF' + text : text;
	if (source.includes('\0')) throw new UnrepresentableTextError();
	const bytes =
		encoding === 'utf-8'
			? new TextEncoder().encode(source)
			: Uint8Array.from((await import('@vscode/iconv-lite-umd')).default.encode(source, encoding));
	// A legacy codec can silently substitute characters that it cannot represent.
	let decoded: string;
	try {
		decoded = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new UnrepresentableTextError();
	}
	if (decoded !== source) throw new UnrepresentableTextError();
	return bytes;
}
