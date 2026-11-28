import { ref, shallowRef, computed, onScopeDispose, watch } from 'vue';
import { PluginHttpError, type PluginContextApi } from 'nexus-terminal/browser';
import type { PluginWindowApi } from 'nexus-terminal/browser';
import type { Connection, ConnectionsClientApi } from '@nexus-terminal/connections/connections-client-api';
import type { CredentialsClientApi } from '@nexus-terminal/credentials/credentials-client-api';
import {
	SessionListResponseSchema,
	SessionCreateResultSchema,
	SessionSchema,
	WorkspaceSessionsTopic,
	type SessionInfo,
} from '../shared/workspace-types';
import { createWorkspaceClient } from './workspace-client';
import type { WorkspaceSessionPresentation } from '../shared/workspace-layout-types';

/** View navigation never releases a session. Only close, suspend or view disposal changes ownership. */
export function useWorkspaceSessions(props: {
	ctx: PluginContextApi;
	view: PluginWindowApi;
	hasTransfers?: (id?: string) => boolean;
	prepareSuspend?: (id: string) => Promise<WorkspaceSessionPresentation | undefined>;
}) {
	const connections = shallowRef<ConnectionsClientApi>(),
		credentials = shallowRef<CredentialsClientApi>(),
		sessions = ref<SessionInfo[]>([]),
		tabs = ref<SessionInfo[]>([]),
		active = ref('home'),
		selected = ref(''),
		connecting = ref(false),
		suspending = ref<string>(),
		marking = ref<string>(),
		closingWindow = ref(false),
		host = ref<{ fingerprint: string; previousFingerprint?: string }>();
	const controller = new AbortController(),
		signal = AbortSignal.any([controller.signal, props.view.signal, props.ctx.signal]);
	const { request, report } = createWorkspaceClient(props.ctx, signal);

	const busySessions = ref<Record<string, boolean>>({});
	const connectionsLoaded = computed(() => readConnectionsState(false, (client) => client.loaded.value));
	const desktopAvailable = computed(() => readConnectionsState(false, (client) => client.desktopAvailable.value));
	const connectionsReadFailed = ref(false);
	let readConnections: (() => Promise<void>) | undefined;
	const confirmOpen = ref(false);
	const suspendedClose = ref<SessionInfo>();
	const removingSuspended = ref(false);
	let resolveConfirmation: ((value: boolean) => void) | undefined;
	let activateConnection = true;

	function readConnectionsState<Value>(fallback: Value, read: (client: ConnectionsClientApi) => Value): Value {
		const client = connections.value;
		if (!client) return fallback;
		try {
			return read(client);
		} catch (cause) {
			// The proxy can expire before the dependency binding is disposed.
			if (cause instanceof Error && 'code' in cause && cause.code === 'PLUGIN_SERVICE_EXPIRED') return fallback;
			throw cause;
		}
	}

	function hasTransfers(id?: string): boolean {
		const owned = id ? [id] : tabs.value.map((tab) => tab.id);
		return owned.some(
			(sessionId) =>
				props.hasTransfers?.(sessionId) ||
				busySessions.value[sessionId] ||
				sessions.value.some((session) => session.id === sessionId && session.transfers > 0),
		);
	}

	function confirmTransfers(id?: string) {
		if (!hasTransfers(id)) return Promise.resolve(true);
		if (resolveConfirmation) return Promise.resolve(false);
		confirmOpen.value = true;
		return new Promise<boolean>((resolve) => {
			resolveConfirmation = resolve;
		});
	}

	function answer(value: boolean) {
		confirmOpen.value = false;
		resolveConfirmation?.(value);
		resolveConfirmation = undefined;
	}

	const stopCloseCheck = props.view.onBeforeClose(async (event) => {
		if (
			suspending.value ||
			marking.value ||
			removingSuspended.value ||
			suspendedClose.value ||
			connecting.value ||
			closingWindow.value
		) {
			event.preventDefault();
			return;
		}
		closingWindow.value = true;
		try {
			if (!(await confirmTransfers()) || signal.aborted) {
				event.preventDefault();
				return;
			}
			// Acknowledge release before disposing the terminal or its presentation.
			for (const tab of [...tabs.value]) await releaseTab(tab.id);
		} catch (cause) {
			report(cause);
			event.preventDefault();
		} finally {
			closingWindow.value = false;
		}
	});
	// Forced disposal is handled by backend attachment close/grace. Never send a
	// late unconditional DELETE: a marked session may already have been resumed.
	const stop = props.ctx.use({ connections: ['@nexus-terminal/connections', 'connections'] }, (scope) => {
		const readSignal = AbortSignal.any([signal, scope.signal]);
		if (readSignal.aborted) return;
		const client = scope.plugin.connections;

		function forgetConnection() {
			if (connections.value !== client) return;
			readConnections = undefined;
			connectionsReadFailed.value = false;
			connections.value = undefined;
		}

		// Service proxies already reject reads when aborted. Drop the reference before
		// Vue evaluates a watcher, without waiting for asynchronous scope disposal.
		readSignal.addEventListener('abort', forgetConnection, { once: true });
		scope.onDispose(() => {
			readSignal.removeEventListener('abort', forgetConnection);
			forgetConnection();
		});
		connections.value = client;
		readConnections = async () => {
			if (readSignal.aborted) return;
			connectionsReadFailed.value = false;
			try {
				await client.refresh(readSignal);
			} catch (cause) {
				if (readSignal.aborted) return;
				connectionsReadFailed.value = true;
				report(cause);
			}
		};
		if (!client.loaded.value) void readConnections();
	});

	const stopCredentials = props.ctx.use({ credentials: ['@nexus-terminal/credentials', 'credentials'] }, (scope) => {
		const readSignal = AbortSignal.any([signal, scope.signal]);
		if (readSignal.aborted) return;
		const client = scope.plugin.credentials;

		function forgetCredentials() {
			if (credentials.value !== client) return;
			credentials.value = undefined;
		}

		readSignal.addEventListener('abort', forgetCredentials, { once: true });
		scope.onDispose(() => {
			readSignal.removeEventListener('abort', forgetCredentials);
			forgetCredentials();
		});
		credentials.value = client;
	});

	const canCreateConnection = computed(() =>
		readConnectionsState(false, (client) => typeof client.create === 'function'),
	);

	function retryConnections(): void {
		void readConnections?.();
	}

	function reconcileSessions(items: SessionInfo[]) {
		sessions.value = items;
		tabs.value = tabs.value.flatMap((tab) => {
			const current = items.find((session) => session.id === tab.id);
			// A resume can receive an older suspended snapshot before the terminal
			// attachment acknowledgement. Retain only locally requested resumes.
			return current && (current.state !== 'suspended' || tab.state === 'suspended') ? [current] : [];
		});
		busySessions.value = Object.fromEntries(
			Object.entries(busySessions.value).filter(([id]) => tabs.value.some((session) => session.id === id)),
		);
		if (active.value !== 'home' && !tabs.value.some((tab) => tab.id === active.value))
			active.value = tabs.value[0]?.id ?? 'home';
	}

	const stopState = props.ctx.app.state.subscribe(
		WorkspaceSessionsTopic,
		SessionListResponseSchema,
		{
			updated: ({ items }) => reconcileSessions(items),

			unconfirmed(reason) {
				// The server retires all sessions when the topic is withdrawn.
				// Preserve the tabs through an ordinary transport reconnect.
				if (reason === 'unavailable') reconcileSessions([]);
			},
		},
		signal,
	);
	onScopeDispose(() => {
		stop();
		stopCredentials();
		stopState();
		stopCloseCheck();
		answer(false);
		controller.abort();
	});
	const savedConnections = computed(() =>
		readConnectionsState<Connection[]>([], (client) =>
			client.catalog.value.connections.map((connection) => ({ ...connection, tags: [...connection.tags] })),
		),
	);
	const suspended = computed(() =>
		sessions.value.filter((s) => s.state === 'suspended' && !tabs.value.some((tab) => tab.id === s.id)),
	);
	watch(savedConnections, (items) => {
		if (selected.value && !items.some((c) => c.id === selected.value)) {
			selected.value = '';
			host.value = undefined;
		}
	});

	async function manage() {
		try {
			await connections.value?.openManager();
		} catch (e) {
			report(e);
		}
	}

	function start(id: string, activate = true) {
		if (connecting.value || closingWindow.value || suspending.value) return;
		const connection = savedConnections.value.find((c) => c.id === id);
		if (!connection || connection.type !== 'ssh') return;
		if (!connection.credentialId) {
			void editCredential(id);
			return;
		}
		selected.value = id;
		activateConnection = activate;
		void connect();
	}

	async function editCredential(connectionId: string) {
		props.ctx.app.log.report({
			level: 'warn',
			code: 'WORKSPACE_CREDENTIAL_REQUIRED',
			params: { connectionId },
		});
		try {
			await connections.value?.openEditor({ connectionId, reason: 'credential-required' });
		} catch (cause) {
			report(cause);
		}
	}

	function add(session: SessionInfo, activate = true) {
		if (closingWindow.value || suspending.value || removingSuspended.value || suspendedClose.value) return;
		if (!tabs.value.some((s) => s.id === session.id)) tabs.value.push(session);
		if (activate) active.value = session.id;
	}

	async function connect(fingerprint?: string) {
		if (!selected.value || connecting.value || closingWindow.value || suspending.value) return;
		connecting.value = true;
		try {
			const { result: value } = await request(
				'sessions',
				'POST',
				{
					connectionId: selected.value,
					...(fingerprint ? { hostKeyFingerprint: fingerprint } : {}),
				},
				SessionCreateResultSchema,
			);
			signal.throwIfAborted();
			if (value.state === 'confirm-host') {
				host.value = { fingerprint: value.fingerprint, previousFingerprint: value.previousFingerprint };
				return;
			}
			host.value = undefined;
			add(value.session, activateConnection);
		} catch (cause) {
			if (cause instanceof PluginHttpError && cause.code === 'WORKSPACE_CREDENTIAL_REQUIRED')
				await editCredential(selected.value);
			else report(cause);
		} finally {
			connecting.value = false;
		}
	}

	async function releaseTab(id: string) {
		const tab = tabs.value.find((item) => item.id === id);
		if (!tab) return;
		suspending.value = id;
		try {
			const presentation = await props.prepareSuspend?.(id);
			signal.throwIfAborted();
			// The backend decides whether to suspend using its confirmed mark.
			await request('sessions/' + id + '/release', 'POST', { presentation });
			signal.throwIfAborted();
			tabs.value = tabs.value.filter((item) => item.id !== id);
			if (active.value === id) active.value = tabs.value[0]?.id ?? 'home';
		} finally {
			suspending.value = undefined;
		}
	}

	async function close(id: string) {
		if (
			suspending.value ||
			marking.value ||
			closingWindow.value ||
			suspendedClose.value ||
			connecting.value ||
			!(await confirmTransfers(id)) ||
			signal.aborted
		)
			return;
		try {
			if (suspending.value || marking.value || closingWindow.value || connecting.value) return;
			await releaseTab(id);
		} catch (cause) {
			report(cause);
		}
	}

	function requestCloseSuspended(id: string) {
		if (suspending.value || marking.value || closingWindow.value || removingSuspended.value || suspendedClose.value)
			return;
		suspendedClose.value = suspended.value.find((session) => session.id === id);
	}

	async function confirmCloseSuspended() {
		const target = suspendedClose.value;
		if (!target || removingSuspended.value) return;
		removingSuspended.value = true;
		try {
			await request('sessions/' + target.id + '/suspended', 'DELETE');
			suspendedClose.value = undefined;
		} catch (cause) {
			report(cause);
		} finally {
			removingSuspended.value = false;
		}
	}

	function cancelCloseSuspended() {
		if (!removingSuspended.value) suspendedClose.value = undefined;
	}

	async function toggleSuspend(id: string) {
		const tab = tabs.value.find((item) => item.id === id);
		if (
			!tab ||
			tab.state !== 'attached' ||
			tab.terminal === 'closed' ||
			marking.value ||
			suspending.value ||
			closingWindow.value ||
			confirmOpen.value ||
			suspendedClose.value
		)
			return;
		marking.value = id;
		try {
			const confirmed = await request(
				'sessions/' + id + '/mark',
				'PATCH',
				{ marked: !tab.markedForSuspend },
				SessionSchema,
			);
			signal.throwIfAborted();

			// The mutation response is authoritative for this field. Do not wait for
			// the state socket to deliver the same mark, or replace newer metadata.
			// A newer snapshot which already changed the mark wins.
			const update = (item: SessionInfo) =>
				item.id === confirmed.id && item.state === 'attached' && item.markedForSuspend === tab.markedForSuspend
					? { ...item, markedForSuspend: confirmed.markedForSuspend }
					: item;

			if (confirmed.id === id && confirmed.state === 'attached') {
				sessions.value = sessions.value.map(update);
				tabs.value = tabs.value.map(update);
			}
		} catch (cause) {
			report(cause);
		} finally {
			marking.value = undefined;
		}
	}

	return {
		connections,
		credentials,
		canCreateConnection,
		connectionsLoaded,
		desktopAvailable,
		connectionsReadFailed,
		retryConnections,
		savedConnections,
		suspended,
		tabs,
		active,
		selected,
		connecting,
		suspending,
		marking,
		closingWindow,
		suspendedClose,
		removingSuspended,
		requestCloseSuspended,
		confirmCloseSuspended,
		cancelCloseSuspended,
		host,
		busySessions,
		confirmOpen,
		answer,
		manage,
		report,
		start,
		add,
		connect,
		close,
		toggleSuspend,
	};
}
