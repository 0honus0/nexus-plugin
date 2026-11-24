import { effectScope, ref } from 'vue';
import type { PluginContextApi, PluginWindowApi } from 'nexus-terminal/browser';
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SessionInfo } from '../src/shared/workspace-types';
import { useWorkspaceSessions } from '../src/browser/use-workspace-sessions';

it('clears the catalog when an older host invalidates Connections before notifying consumers', () => {
	const dependency = new AbortController();
	const loaded = ref(true);
	const catalog = ref({ connections: [] });
	let valid = true;

	function assertLive() {
		if (!valid) throw Object.assign(new Error('Service expired'), { code: 'PLUGIN_SERVICE_EXPIRED' });
	}

	const client = {
		get loaded() {
			assertLive();
			return loaded;
		},

		get catalog() {
			assertLive();
			return catalog;
		},

		async refresh() {},
	};
	const dispose = new Set<() => void>();
	const scope = effectScope();
	const model = scope.run(() =>
		useWorkspaceSessions({
			ctx: {
				signal: new AbortController().signal,
				app: { state: { subscribe: () => () => {} } },

				use(_selection: unknown, bind: (context: object) => void) {
					bind({
						signal: dependency.signal,
						plugin: { connections: client },
						onDispose: dispose.add.bind(dispose),
					});
					return () => {};
				},
			} as unknown as PluginContextApi,
			view: {
				signal: new AbortController().signal,

				onBeforeClose: () => () => {},

				onDispose: () => () => {},
			} as unknown as PluginWindowApi,
		}),
	)!;

	try {
		expect(model.connectionsLoaded.value).toBe(true);
		valid = false;
		loaded.value = false;
		catalog.value = { connections: [] };
		expect(model.connectionsLoaded.value).toBe(false);
		expect(model.savedConnections.value).toEqual([]);

		dependency.abort();
		expect(model.connections.value).toBeUndefined();
	} finally {
		for (const cleanup of dispose) cleanup();
		scope.stop();
	}
});

it('does not delete a suspended session until confirmation and releases marked tabs before window closure', async () => {
	const scope = effectScope();
	const suspended: SessionInfo = {
		id: randomUUID(),
		connectionId: randomUUID(),
		name: 'Suspended',
		state: 'suspended',
		markedForSuspend: true,
		terminal: 'running',
		transfers: 0,
		createdAt: 1,
	};
	let update!: (value: { items: SessionInfo[] }) => void;
	let beforeClose!: (event: { preventDefault(): void }) => Promise<void>;
	const json = vi.fn(async (path: string) => {
		if (path.endsWith('/suspended')) update({ items: [] });
		return {};
	});
	const model = scope.run(() =>
		useWorkspaceSessions({
			ctx: {
				signal: new AbortController().signal,
				app: {
					state: {
						subscribe: (_topic: string, _schema: unknown, observer: { updated: typeof update }) => {
							update = observer.updated;
							return () => {};
						},
					},
					http: { json },
					log: { report: vi.fn() },
				},

				use: () => () => {},
			} as unknown as PluginContextApi,
			view: {
				signal: new AbortController().signal,

				onBeforeClose: (fn: typeof beforeClose) => {
					beforeClose = fn;
					return () => {};
				},
			} as unknown as PluginWindowApi,
		}),
	)!;
	try {
		update({ items: [suspended] });
		model.requestCloseSuspended(suspended.id);
		expect(model.suspendedClose.value?.id).toBe(suspended.id);
		expect(json).not.toHaveBeenCalled();
		model.cancelCloseSuspended();
		expect(model.suspendedClose.value).toBeUndefined();
		expect(json).not.toHaveBeenCalled();
		model.requestCloseSuspended(suspended.id);
		await model.confirmCloseSuspended();
		expect(json).toHaveBeenCalledWith(
			'sessions/' + suspended.id + '/suspended',
			expect.anything(),
			expect.objectContaining({ method: 'DELETE' }),
		);
		expect(model.suspended.value).toEqual([]);
		update({ items: [suspended] });
		model.add(suspended);
		update({ items: [suspended] });
		expect(model.tabs.value).toHaveLength(1);
		expect(model.suspended.value).toEqual([]);
		update({ items: [{ ...suspended, state: 'attached' }] });
		const event = { preventDefault: vi.fn() };
		await beforeClose(event);
		expect(event.preventDefault).not.toHaveBeenCalled();
		expect(json).toHaveBeenCalledWith(
			'sessions/' + suspended.id + '/release',
			expect.anything(),
			expect.objectContaining({ method: 'POST' }),
		);
		expect(model.tabs.value).toEqual([]);
	} finally {
		scope.stop();
	}
});

it('applies the confirmed suspend mark without waiting for a state frame, preserving newer session metadata', async () => {
	const scope = effectScope();
	const session: SessionInfo = {
		id: randomUUID(),
		connectionId: randomUUID(),
		name: 'Attached',
		state: 'attached',
		markedForSuspend: false,
		terminal: 'running',
		transfers: 0,
		createdAt: 1,
	};
	let update!: (value: { items: SessionInfo[] }) => void;
	const report = vi.fn();
	const json = vi.fn();
	const model = scope.run(() =>
		useWorkspaceSessions({
			ctx: {
				signal: new AbortController().signal,
				app: {
					state: {
						subscribe: (_topic: string, _schema: unknown, observer: { updated: typeof update }) => {
							update = observer.updated;
							return () => {};
						},
					},
					http: { json },
					log: { report },
				},

				use: () => () => {},
			} as unknown as PluginContextApi,
			view: {
				signal: new AbortController().signal,

				onBeforeClose: () => () => {},
			} as unknown as PluginWindowApi,
		}),
	)!;
	try {
		update({ items: [session] });
		model.add(session);
		const marked = Promise.withResolvers<SessionInfo>();
		json.mockReturnValueOnce(marked.promise);
		const marking = model.toggleSuspend(session.id);
		expect(model.marking.value).toBe(session.id);
		expect(model.tabs.value[0]?.markedForSuspend).toBe(false);
		update({ items: [{ ...session, transfers: 2 }] });
		marked.resolve({ ...session, markedForSuspend: true });
		await marking;
		expect(model.tabs.value[0]).toMatchObject({ markedForSuspend: true, transfers: 2 });
		expect(model.marking.value).toBeUndefined();
		json.mockRejectedValueOnce(new Error('fixture request failure'));
		await model.toggleSuspend(session.id);
		expect(model.tabs.value[0]?.markedForSuspend).toBe(true);
		expect(report).toHaveBeenCalledOnce();
		json.mockResolvedValueOnce({ ...session, markedForSuspend: false });
		await model.toggleSuspend(session.id);
		expect(model.tabs.value[0]).toMatchObject({ markedForSuspend: false, transfers: 2 });
		expect(JSON.parse(json.mock.calls[2]![2].body)).toEqual({ marked: false });
		const retired = Promise.withResolvers<SessionInfo>();
		json.mockReturnValueOnce(retired.promise);
		const pending = model.toggleSuspend(session.id);
		update({ items: [] });
		retired.resolve({ ...session, markedForSuspend: true });
		await pending;
		expect(model.tabs.value).toEqual([]);
	} finally {
		scope.stop();
	}
});
