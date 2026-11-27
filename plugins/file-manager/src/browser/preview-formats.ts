const MiB = 1024 * 1024;
const imageTypes = new Map([
	['png', 'image/png'],
	['jpg', 'image/jpeg'],
	['jpeg', 'image/jpeg'],
	['gif', 'image/gif'],
	['webp', 'image/webp'],
	['bmp', 'image/bmp'],
	['ico', 'image/x-icon'],
	['avif', 'image/avif'],
]);
const languages: Readonly<Record<string, string>> = {
	css: 'css',
	html: 'html',
	htm: 'html',
	js: 'javascript',
	mjs: 'javascript',
	cjs: 'javascript',
	json: 'json',
	py: 'python',
	ts: 'typescript',
	mts: 'typescript',
};
const plainExtensions = new Set(['txt', 'log', 'yaml', 'yml', 'toml', 'ini', 'conf', 'xml', 'sh', 'sql']);
const textNames = new Set(['readme', 'license', 'dockerfile', 'makefile', '.gitignore', '.editorconfig']);

export type PreviewFormat =
	| { kind: 'text' | 'markdown' | 'csv'; maxBytes: number; language: string }
	| { kind: 'image' | 'pdf'; maxBytes: number; mime: string };

export function previewFormat(name: string): PreviewFormat | undefined {
	const normalized = name.toLowerCase();
	const extension = normalized.slice(normalized.lastIndexOf('.') + 1);
	const mime = imageTypes.get(extension);
	if (mime) return { kind: 'image', maxBytes: 16 * MiB, mime };
	if (extension === 'pdf') return { kind: 'pdf', maxBytes: 20 * MiB, mime: 'application/pdf' };
	if (extension === 'md' || extension === 'markdown')
		return { kind: 'markdown', maxBytes: 2 * MiB, language: 'markdown' };
	if (extension === 'csv' || extension === 'tsv') return { kind: 'csv', maxBytes: 2 * MiB, language: 'text' };
	if (Object.hasOwn(languages, extension) || plainExtensions.has(extension) || textNames.has(normalized))
		return { kind: 'text', maxBytes: 2 * MiB, language: languages[extension] ?? 'text' };
}
