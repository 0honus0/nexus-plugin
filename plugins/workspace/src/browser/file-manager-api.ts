import type { Component } from 'vue';

export interface FileManagerFile {
	readonly name: string;
	readonly path: string;
	readonly sessionId: string;
	readonly size: number;
	readonly mode: 'reuse' | 'new';
	read(maxBytes: number, signal: AbortSignal): Promise<ArrayBuffer>;
	save(body: Blob, expectedHash: string, signal: AbortSignal): Promise<void>;
	download(): Promise<void>;
}

export type FileManagerOpenFile = (file: FileManagerFile) => boolean;

export interface WorkspaceFileManagerApi {
	createView(openFile: FileManagerOpenFile): Component;
	registerFileOpener(openFile: FileManagerOpenFile): () => void;
}

declare module 'nexus-terminal/browser' {
	interface PluginServicesApi {
		readonly '@nexus-terminal/workspace': { readonly fileManager: WorkspaceFileManagerApi };
	}
}
