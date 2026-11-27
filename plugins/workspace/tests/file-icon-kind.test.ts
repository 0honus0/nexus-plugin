import { expect, it } from 'vitest';
import { fileIconKind } from '../src/browser/files/file-icon-kind';

it('uses directory and link types before extensions and supports the parent row', () => {
	expect(fileIconKind('photo.png', 'directory')).toBe('folder');
	expect(fileIconKind('photo.png', 'link')).toBe('link');
	expect(fileIconKind('photo.png', 'other')).toBe('file');
});

it.each([
	['PHOTO.JPG', 'image'],
	['a.mp4', 'video'],
	['a.flac', 'audio'],
	['a.docx', 'document'],
	['a.xlsx', 'spreadsheet'],
	['a.pptx', 'presentation'],
	['a.tar.gz', 'archive'],
	['a.ts', 'code'],
	['.bashrc', 'config'],
	['.env.local', 'shield'],
	['Dockerfile', 'container'],
	['pnpm-lock.yaml', 'package'],
	['README.md', 'book'],
	['LICENSE', 'license'],
	['.gitignore', 'git'],
	['a.sqlite', 'database'],
	['id.pem', 'key'],
	['a.sh', 'terminal'],
	['a.woff2', 'font'],
	['a.iso', 'disk'],
	['unknown', 'file'],
])('classifies %s as %s', (name, kind) => {
	expect(fileIconKind(name, 'file')).toBe(kind);
});
