import { reactive } from 'vue';
import type { FileManagerFile } from '@nexus-terminal/workspace/file-manager-api';
import type { PreviewFormat } from './preview-formats.js';
import type { EncodingChoice, TextEncoding } from './text-encoding.js';

export interface TextDocument {
	original: string;
	draft: string;
	hash: string;
	bom: boolean;
	encoding: TextEncoding;
	lineEnding: '\n' | '\r\n' | '\r';
}

export interface PreviewDocument {
	id: string;
	file: FileManagerFile;
	format: PreviewFormat;
	mode: 'preview' | 'edit' | 'split';
	encodingChoice: EncodingChoice;
	text?: TextDocument;
	saving: boolean;
}

function documentId(file: FileManagerFile) {
	return JSON.stringify([file.sessionId, file.path]);
}

export function createDocument(file: FileManagerFile, format: PreviewFormat): PreviewDocument {
	return reactive({
		id: documentId(file),
		file,
		format,
		mode: format.kind === 'text' ? 'edit' : 'preview',
		encodingChoice: 'language' in format ? (format.encodingHint ?? 'auto') : 'auto',
		saving: false,
	});
}

export function isDirty(document: PreviewDocument) {
	return !!document.text && document.text.draft !== document.text.original;
}
