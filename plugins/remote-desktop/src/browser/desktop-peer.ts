import type { z } from 'zod';
import type { DesktopDisplay, NativeSessionSchema } from '../shared/desktop-session';

export type RemoteDesktopDisplay = DesktopDisplay;

export type RemoteDesktopSession = z.infer<typeof NativeSessionSchema> & { socketUrl: string };

export type RemoteDesktopState = 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'error';

export type RemoteTouchMode = 'direct' | 'touchpad';

export class RemoteDesktopFailure extends Error {
	constructor(
		readonly code:
			'remote_unavailable' | 'input_failed' | 'cleanup_failed' | 'conflict' | 'cancelled' | 'protocol_failure',
		readonly outcome: 'not_dispatched' | 'confirmed' | 'unknown',
		options?: ErrorOptions,
	) {
		super('Remote desktop operation failed', options);
		this.name = 'RemoteDesktopFailure';
	}
}

export interface RemoteDesktopPeer {
	readonly element: HTMLElement;
	readonly fileClipboard?: RemoteDesktopFileClipboard;
	connect(session: RemoteDesktopSession, display: RemoteDesktopDisplay): void;
	resize(display: RemoteDesktopDisplay): void;
	focus(): void;
	setTouchMode(mode: RemoteTouchMode): void;
	setTextInputActive(active: boolean): void;
	syncClipboard(): Promise<void>;
	sendText(text: string): void;
	close(): void;
}

export interface RemoteDesktopClipboardFile {
	id: string;
	name: string;
	path: string;
	size: number;
	isDirectory: boolean;
}

export interface RemoteDesktopClipboardProgress {
	transferred: number;
	total: number;
}

export interface RemoteDesktopFileClipboardState {
	files: RemoteDesktopClipboardFile[];
	canUpload: boolean;
	upload: (RemoteDesktopClipboardProgress & { waiting: boolean }) | null;
	downloads: (RemoteDesktopClipboardProgress & { id: string })[];
}

export interface RemoteDesktopFileClipboard {
	subscribe(listener: (state: RemoteDesktopFileClipboardState) => void): () => void;
	upload(files: File[]): Promise<void>;
	download(id: string): Promise<Blob>;
}

export interface RemoteDesktopPeerOptions {
	hasTouch: boolean;
	fillViewport?: boolean;
	touchMode: RemoteTouchMode;
	mobileInput: HTMLTextAreaElement | null;
	onState(state: RemoteDesktopState): void;
	onFailure(failure: RemoteDesktopFailure): void;
	onDiagnostic?(code: 'DESKTOP_CLEANUP_FAILED'): void;
}

export type RemoteDesktopPeerFactory = (options: RemoteDesktopPeerOptions) => RemoteDesktopPeer;
