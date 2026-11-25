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
