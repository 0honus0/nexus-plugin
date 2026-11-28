import type { FileEntry } from '../../shared/workspace-file-types';

const extensions = {
	image: 'jpg jpeg png gif bmp svg webp ico tiff avif',
	video: 'mp4 mkv avi mov webm',
	audio: 'mp3 wav ogg flac m4a',
	document: 'doc docx pdf txt text log rtf odt',
	spreadsheet: 'xls xlsx csv tsv ods',
	presentation: 'ppt pptx odp',
	archive: 'zip rar tar gz tgz 7z bz2 tbz2 xz zst',
	disk: 'iso',
	code: 'js mjs cjs jsx ts tsx vue py java jar go rs c h cpp rb php html htm css scss sass less json xml',
	config: 'yml yaml ini conf toml bashrc zshrc profile',
	book: 'md markdown',
	database: 'sql db sqlite sqlite3',
	key: 'key pem pub',
	terminal: 'sh bash zsh fish bat cmd ps1',
	font: 'ttf otf woff woff2',
	git: 'gitconfig',
} as const;

const byExtension = new Map(
	Object.entries(extensions).flatMap(([kind, names]) =>
		names.split(' ').map((name) => [name, kind as keyof typeof extensions] as const),
	),
);

/** Match file types locally, like the previous file manager, without loading icon assets. */
export function fileIconKind(name: string, kind: FileEntry['kind']) {
	if (kind === 'directory') return name === '..' ? 'parent' : 'folder';
	if (kind === 'link') return 'link';
	if (kind !== 'file') return 'file';
	const lower = name.toLowerCase();
	if (lower === 'makefile') return 'config';
	if (lower === 'dockerfile' || /docker-compose\.ya?ml$/u.test(lower)) return 'container';
	if (
		[
			'package.json',
			'package-lock.json',
			'pnpm-lock.yaml',
			'yarn.lock',
			'composer.json',
			'composer.lock',
			'gemfile',
			'gemfile.lock',
		].includes(lower)
	)
		return 'package';
	if (lower.startsWith('.env')) return 'shield';
	if (['.git', '.gitignore', '.gitattributes', '.gitmodules'].includes(lower)) return 'git';
	if (lower === 'readme' || lower.startsWith('readme.')) return 'book';
	if (lower === 'license' || lower.startsWith('license.')) return 'license';
	const dot = lower.lastIndexOf('.');
	return (dot >= 0 ? byExtension.get(lower.slice(dot + 1)) : undefined) ?? 'file';
}
