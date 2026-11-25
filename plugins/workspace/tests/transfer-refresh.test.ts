import { effectScope } from 'vue';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { PluginContextApi, PluginWindowApi } from 'nexus-terminal/browser';
import { createWorkspaceTransfers } from '../src/browser/transfers/workspace-transfers';
import type { TransferTask, TransferKind } from '../src/shared/workspace-transfer-types';

it('refreshes once per mutation event, never for read-only downloads or repeated history', () => {
	const scope = effectScope();
	const signal = new AbortController().signal;
	const refresh = vi.fn();
	let receive!: (socket: unknown, event: { data: string }) => void;
	const ctx = {
		signal,
		app: {
			ws: {
				connect: (_path: string, options: { onMessage: typeof receive }) => {
					receive = options.onMessage;
				},
			},
			log: { report: vi.fn() },
		},
	} as unknown as PluginContextApi;
	const store = scope.run(() => createWorkspaceTransfers(ctx, { signal } as PluginWindowApi, refresh))!;

	const task = (kind: TransferKind): TransferTask => ({
		id: randomUUID(),
		kind,
		state: 'completed',
		label: 'fixture',
		source: '',
		destination: '',
		paths: ['/file'],
		destinationPath: '/',
		sessionIds: [randomUUID()],
		bytes: 10,
		totalBytes: 10,
		completedItems: 1,
		totalItems: 1,
		currentFile: '',
		speed: 0,
		fallback: false,
		createdAt: 1,
		updatedAt: 2,
		retryable: false,
	});

	const send = (tasks: TransferTask[]) =>
		receive(null, { data: JSON.stringify({ type: 'changed', tasks, removed: [] }) });

	try {
		const download = task('download');
		send([download]);
		expect(refresh).not.toHaveBeenCalled();
		const uploads = Array.from({ length: 3 }, () => task('upload'));
		send(uploads);
		expect(refresh).toHaveBeenCalledTimes(1);
		send([download, ...uploads]);
		expect(refresh).toHaveBeenCalledTimes(1);
		send([task('move')]);
		expect(refresh).toHaveBeenCalledTimes(2);
		expect(store.history.value).toHaveLength(5);
	} finally {
		scope.stop();
	}
});

it('clears a single failed local upload and releases its retry file', async () => {
	const scope = effectScope();
	const signal = new AbortController().signal;
	const request = vi.fn(async () => {
		throw new Error('fixture transport failure');
	});
	const json = vi.fn(async () => ({}));
	const report = vi.fn();
	let receive!: (socket: unknown, event: { data: string }) => void;
	const ctx = {
		signal,
		app: {
			ws: {
				connect: (_path: string, options: { onMessage: typeof receive }) => {
					receive = options.onMessage;
				},
			},
			http: { request, json },
			log: { report },
		},
	} as unknown as PluginContextApi;
	const store = scope.run(() => createWorkspaceTransfers(ctx, { signal } as PluginWindowApi, vi.fn()))!;
	try {
		store.upload(randomUUID(), '/', [new File(['fixture'], 'single.txt')]);
		await vi.waitFor(() => expect(store.history.value).toHaveLength(1));
		const task = store.history.value[0];
		expect(task.state).toBe('failed');
		expect(task.batchId).toBeDefined();
		expect(store.canRetry(task)).toBe(true);
		expect(report).toHaveBeenCalledOnce();
		receive(null, { data: JSON.stringify({ type: 'changed', tasks: [], removed: [] }) });
		expect(report).toHaveBeenCalledOnce();
		await store.clear();
		expect(json).toHaveBeenCalledWith(
			'transfers/history',
			expect.anything(),
			expect.objectContaining({ method: 'DELETE' }),
		);
		expect(store.history.value).toEqual([]);
		expect(store.canRetry(task)).toBe(false);
	} finally {
		scope.stop();
	}
});

it('keeps server-owned tasks until removal is confirmed and preserves uploads started during clear', async () => {
	const scope = effectScope();
	const signal = new AbortController().signal;
	const clear = Promise.withResolvers<unknown>();
	const pending = Promise.withResolvers<Response>();
	let receive!: (socket: unknown, event: { data: string }) => void;
	const ctx = {
		signal,
		app: {
			ws: {
				connect: (_path: string, options: { onMessage: typeof receive }) => {
					receive = options.onMessage;
				},
			},
			http: {
				request: () => pending.promise,

				json: () => clear.promise,
			},
			log: { report: vi.fn() },
		},
	} as unknown as PluginContextApi;
	const store = scope.run(() => createWorkspaceTransfers(ctx, { signal } as PluginWindowApi, vi.fn()))!;
	try {
		const finished: TransferTask = {
			id: randomUUID(),
			batchId: randomUUID(),
			kind: 'upload',
			state: 'completed',
			label: 'finished',
			source: '',
			destination: '',
			paths: ['/finished'],
			destinationPath: '/',
			sessionIds: [randomUUID()],
			bytes: 10,
			totalBytes: 10,
			completedItems: 1,
			totalItems: 1,
			currentFile: '',
			speed: 0,
			fallback: false,
			createdAt: 1,
			updatedAt: 2,
			retryable: false,
		};

		const send = (tasks: TransferTask[], removed: string[] = []) =>
			receive(null, { data: JSON.stringify({ type: 'changed', tasks, removed }) });

		send([finished]);
		const clearing = store.clear();
		const next = { ...finished, id: randomUUID(), state: 'transferring' as const, bytes: 1, completedItems: 0 };
		send([next]);
		store.upload(randomUUID(), '/', [new File(['new'], 'new.txt')]);
		clear.resolve({});
		await clearing;
		expect(store.tasks.value.map((task) => task.id)).toEqual(expect.arrayContaining([finished.id, next.id]));
		expect(store.active.value).toHaveLength(2);
		send([], [finished.id]);
		expect(store.tasks.value.some((task) => task.id === finished.id)).toBe(false);
		expect(store.active.value).toHaveLength(2);
	} finally {
		pending.resolve(new Response(null, { status: 204 }));
		scope.stop();
	}
});
