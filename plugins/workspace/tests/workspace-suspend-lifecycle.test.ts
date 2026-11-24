import { EventEmitter } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { WorkspaceService } from '../src/node/workspace-service';
import { sessionTabStatus } from '../src/browser/session-tab-status';
import type { SessionInfo } from '../src/shared/workspace-types';

vi.mock('../src/node/workspace-storage.js', () => ({
	WorkspaceStorage: class {
		getHostKey() {
			return {
				fingerprint:
					'SHA256:' + createHash('sha256').update('fixture-key').digest('base64').replace(/=+$/u, ''),
			};
		}
	},
}));

class Socket extends EventEmitter {
	readyState = 1;
	bufferedAmount = 0;
	send = vi.fn();
	ping = vi.fn();

	close(code = 1000) {
		if (this.readyState !== 1) return;
		this.readyState = 3;
		this.emit('close', code);
	}

	terminate() {
		this.close(1006);
	}
}

function fixture() {
	const id = randomUUID();
	const channel = Object.assign(new EventEmitter(), {
		pause: vi.fn(),
		resume: vi.fn(),
		destroy: vi.fn(),
		write: vi.fn(),
		setWindow: vi.fn(),
	});
	const connection = {
		shell: async () => channel,

		close: vi.fn(),
		onStateChange: vi.fn(),
	};
	const remote = {
		resetStatus: vi.fn(),

		openShell: () => ({
			ensureHook: async () => {},

			filterOutput: (data: Buffer) => data,

			onAttachmentReleased: vi.fn(),
			close: vi.fn(),
		}),
	};
	const args = [
		{},
		{
			get: async () => ({
				id,
				host: 'fixture',
				port: 22,
				name: 'Fixture',
				type: 'ssh',
				credentialId: randomUUID(),
			}),
		},
		{ resolve: async () => ({ type: 'password', username: 'fixture', password: 'fixture' }) },
		{
			connect: async (options: { hostVerifier: (key: Buffer) => boolean }) => {
				expect(options.hostVerifier(Buffer.from('fixture-key'))).toBe(true);
				return connection;
			},
		},
		new AbortController().signal,
		{ report: vi.fn() },
		{ bind: () => remote },
	] as unknown as ConstructorParameters<typeof WorkspaceService>;
	const service = new WorkspaceService(...args);

	async function attach(sessionId: string) {
		const socket = new Socket();
		await service.attach(sessionId, socket as unknown as WebSocket);
		return socket;
	}

	return {
		service,
		connection,
		channel,
		attach,

		create: () => service.create({ connectionId: id }),
	};
}

it('marks without closing, preserves SSH on release, resumes with mark, and unmarks before normal closure', async () => {
	const f = fixture();
	try {
		const session = await f.create();
		const socket = await f.attach(session.id);
		expect(f.service.markForSuspend(session.id, true)).toMatchObject({ state: 'attached', markedForSuspend: true });
		expect(socket.readyState).toBe(1);
		expect(f.connection.close).not.toHaveBeenCalled();
		await expect(Promise.resolve().then(() => f.service.closeSuspended(session.id))).rejects.toMatchObject({
			code: 'WORKSPACE_SESSION_BUSY',
		});
		await f.service.release(session.id);
		expect(socket.readyState).toBe(3);
		expect(f.service.list()).toEqual([expect.objectContaining({ state: 'suspended', markedForSuspend: true })]);
		expect(f.connection.close).not.toHaveBeenCalled();
		await f.service.release(session.id); // duplicate release must not terminate detached session
		const resumed = await f.attach(session.id);
		expect(resumed.send).toHaveBeenCalledWith(expect.stringContaining('"type":"snapshot"'));
		expect(f.service.list()).toEqual([expect.objectContaining({ state: 'attached', markedForSuspend: true })]);
		expect(f.service.markForSuspend(session.id, false)).toMatchObject({ markedForSuspend: false });
		await f.service.release(session.id);
		expect(f.service.list()).toEqual([]);
		expect(f.connection.close).toHaveBeenCalledOnce();
	} finally {
		await f.service.dispose();
	}
});
it('retains a marked session after ordinary socket close and reconnect grace expiration', async () => {
	const f = fixture();
	vi.useFakeTimers();
	try {
		const session = await f.create();
		let socket = await f.attach(session.id);
		f.service.markForSuspend(session.id, true);
		socket.close();
		await vi.advanceTimersByTimeAsync(1);
		expect(f.service.list()[0]).toMatchObject({ state: 'suspended', markedForSuspend: true });
		socket = await f.attach(session.id);
		socket.terminate();
		expect(f.service.list()[0].state).toBe('disconnected');
		await vi.advanceTimersByTimeAsync(9999);
		expect(f.service.list()[0].state).toBe('disconnected');
		await vi.advanceTimersByTimeAsync(1);
		expect(f.service.list()[0]).toMatchObject({ state: 'suspended', markedForSuspend: true });
		expect(f.connection.close).not.toHaveBeenCalled();
		await f.service.closeSuspended(session.id);
		expect(f.service.list()).toEqual([]);
		expect(f.connection.close).toHaveBeenCalledOnce();
	} finally {
		await f.service.dispose();
		vi.useRealTimers();
	}
});
it('uses attachment acknowledgement, marked state and release status instead of active tab selection', () => {
	const session = { state: 'attached', terminal: 'running' } as SessionInfo;
	expect(sessionTabStatus(session, undefined, false)).toMatchObject({ key: 'connecting', busy: true });
	expect(sessionTabStatus(session, 'connected', false)).toMatchObject({ key: 'connected', tone: 'success' });
	expect(sessionTabStatus({ ...session, markedForSuspend: true }, 'connected', false)).toMatchObject({
		key: 'marked',
		tone: 'info',
	});
	expect(sessionTabStatus({ ...session, markedForSuspend: true }, 'connected', true)).toMatchObject({
		key: 'suspending',
		busy: true,
	});
	expect(sessionTabStatus({ ...session, state: 'suspended' }, 'connecting', false)).toMatchObject({
		key: 'resuming',
		busy: true,
	});
	expect(sessionTabStatus(session, 'reconnecting', false)).toMatchObject({ key: 'reconnecting' });
	expect(sessionTabStatus({ ...session, terminal: 'closed' }, 'connected', false)).toMatchObject({
		key: 'disconnected',
		tone: 'danger',
	});
});
