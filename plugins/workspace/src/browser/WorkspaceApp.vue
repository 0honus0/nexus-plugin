<script setup lang="ts">
	import { useWindowSize } from '@vueuse/core';
	import { Terminal, Home, Fingerprint, Pause, Play, ArrowDownUp, FolderOpen } from '@lucide/vue';
	import { UiButton, UiDialog } from 'nexus-terminal/browser/ui';
	import type { PluginContextApi } from 'nexus-terminal/browser';
	import type { PluginWindowProps } from 'nexus-terminal/browser';
	import type { WorkspaceI18n } from './workspace-i18n';
	import type { FileManagerOpenFile } from './file-manager-api.js';
	import { computed, onScopeDispose, provide, defineAsyncComponent, defineComponent, h, ref, watch } from 'vue';
	import { createWorkspaceFilesState, workspaceFilesStateKey } from './files/workspace-files-state';
	import { createWorkspaceTransfers, workspaceTransfersKey } from './transfers/workspace-transfers';
	import TransferCenter from './transfers/TransferCenter.vue';
	import { LayoutProfiles } from '../shared/layout-types.js';
	import WorkspaceLoading from './WorkspaceLoading.vue';
	import WorkspaceHome from './WorkspaceHome.vue';
	import WorkspaceConnectionDialog from './WorkspaceConnectionDialog.vue';
	import { useWorkspaceSessions } from './use-workspace-sessions';
	import { sessionTabStatus, type AttachmentStatus } from './session-tab-status';
	import { createWorkspaceLayoutState, workspaceLayoutStateKey } from './presentation/workspace-layout-state';
	const props = defineProps<
		PluginWindowProps & {
			ctx: PluginContextApi;
			i18n: WorkspaceI18n;
			filesOnly?: boolean;
			openFile?: FileManagerOpenFile;
		}
	>();
	const { t } = props.i18n;
	const layouts = createWorkspaceLayoutState(props.ctx);
	provide(workspaceLayoutStateKey, layouts);
	let sessionModule: Promise<typeof import('./WorkspaceSessionTabs.vue')> | undefined;

	function loadSessionTabs() {
		return (sessionModule ??= import('./WorkspaceSessionTabs.vue').catch((cause: unknown) => {
			sessionModule = undefined;
			throw cause;
		}));
	}

	const WorkspaceSessionTabs = defineAsyncComponent({
		loader: loadSessionTabs,

		loadingComponent: WorkspaceLoading,
		delay: 0,
	});
	let filesState: ReturnType<typeof createWorkspaceFilesState> | undefined;
	const transfers = createWorkspaceTransfers(props.ctx, props.view, () => filesState?.changed());
	provide(workspaceTransfersKey, transfers);
	const { width: viewportWidth } = useWindowSize();
	const narrowTransfers = computed(() => viewportWidth.value < LayoutProfiles.wide.minWidth);
	const TransferIcon = defineComponent(
		() => () =>
			h('span', { class: 'workspace-transfer-action-icon' }, [
				h(ArrowDownUp, { size: 16 }),
				...(transfers.active.value.length ? [h('small', String(transfers.active.value.length))] : []),
			]),
	);
	onScopeDispose(
		props.view.registerActions({
			items: computed(() => [{ id: 'transfers', label: t('transferCenter.title'), icon: TransferIcon }]),

			onSelect() {
				transfers.open.value = !transfers.open.value;
			},
		}),
	);
	watch(
		() => props.view.state.value.mode,
		(mode) => {
			if (mode === 'minimized') transfers.open.value = false;
		},
	);

	const {
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
	} = useWorkspaceSessions({ ...props, hasTransfers: transfers.hasPending, prepareSuspend: layouts.prepareSuspend });

	const createOpen = ref(false);
	const homeConnections = computed(() =>
		props.filesOnly ? savedConnections.value.filter((item) => item.type === 'ssh') : savedConnections.value,
	);

	function openConnection(id: string): void {
		if (homeConnections.value.find((item) => item.id === id)?.type === 'ssh') {
			start(id);
			return;
		}
		try {
			connections.value?.openDesktop(id);
		} catch (cause) {
			report(cause);
		}
	}

	function openCreate(): void {
		if (canCreateConnection.value) createOpen.value = true;
		else void manage();
	}

	function handleCreated(connection: { id: string }, connectNow: boolean): void {
		createOpen.value = false;
		if (connectNow) start(connection.id);
	}

	watch(
		connecting,
		(pending) => {
			if (pending) void loadSessionTabs().catch(() => undefined);
		},
		{ flush: 'sync' },
	);

	const sessionsOpened = ref(false);
	watch(
		() => tabs.value.length,
		(count) => {
			if (count) sessionsOpened.value = true;
		},
	);

	filesState = createWorkspaceFilesState(
		tabs,
		savedConnections,
		(id) => start(id, false),
		computed(() => connecting.value || !!host.value),
	);
	provide(workspaceFilesStateKey, filesState);
	const attachment = ref<Record<string, AttachmentStatus>>({});
	watch(
		() => tabs.value.map(({ id }) => id),
		(ids) => {
			attachment.value = Object.fromEntries(Object.entries(attachment.value).filter(([id]) => ids.includes(id)));
		},
	);
	let lastSessionId = '';
	watch(active, (id) => {
		if (id !== 'home') lastSessionId = id;
	});
	const windowTabs = computed(() => [
		...tabs.value.map((tab) => {
			const peers = tabs.value.filter((s) => s.connectionId === tab.connectionId);
			const { key, tone, busy } = sessionTabStatus(tab, attachment.value[tab.id], suspending.value === tab.id);
			return {
				id: tab.id,
				label: tab.name + (peers.length > 1 ? ' · ' + (peers.findIndex((s) => s.id === tab.id) + 1) : ''),
				icon: props.filesOnly ? FolderOpen : Terminal,
				closable: true,
				status: { tone, busy, label: t('sessionStatus.' + key) },
				menu: props.filesOnly
					? []
					: [
							{
								id: 'suspend',
								label: t(tab.markedForSuspend ? 'unmarkSuspend' : 'suspend'),
								icon: tab.markedForSuspend ? Play : Pause,
								disabled:
									!!suspending.value ||
									!!marking.value ||
									closingWindow.value ||
									tab.state !== 'attached' ||
									attachment.value[tab.id] !== 'connected' ||
									tab.terminal === 'closed',
							},
						],
			};
		}),
		...(active.value === 'home'
			? [{ id: 'home', label: t('connection'), icon: Home, closable: tabs.value.length > 0 }]
			: []),
	]);
	onScopeDispose(
		props.view.registerTabs({
			items: windowTabs,
			activeId: active,

			addLabel: () => (active.value === 'home' ? '' : t('newSession')),

			onSelect: (id) => {
				active.value = id;
			},

			onClose: (id) => {
				if (id === 'home') {
					const fallback = tabs.value.some((tab) => tab.id === lastSessionId)
						? lastSessionId
						: tabs.value.at(-1)?.id;
					if (fallback) active.value = fallback;
					return;
				}
				return close(id);
			},

			onMenuSelect: (id, action) => {
				if (action === 'suspend') return toggleSuspend(id);
			},

			onAdd: () => {
				active.value = 'home';
			},
		}),
	);
</script>
<template>
	<section class="workspace-app" data-ui-selection="none">
		<WorkspaceHome
			v-show="active === 'home'"
			:connections="homeConnections"
			:files-only="filesOnly"
			:suspended="filesOnly ? [] : suspended"
			:connections-available="!!connections"
			:desktop-available="desktopAvailable"
			:connections-loaded="connectionsLoaded"
			:connections-read-failed="connectionsReadFailed"
			:selected="selected"
			:connecting="connecting"
			:i18n="i18n"
			@connect="openConnection"
			@resume="add"
			@close="requestCloseSuspended"
			@create="openCreate"
			@manage="manage"
			@retry="retryConnections"
		/>
		<div v-if="sessionsOpened" v-show="active !== 'home'" class="workspace-sessions">
			<WorkspaceSessionTabs
				:tabs="tabs"
				:active="active"
				:connections="savedConnections"
				:files-only="filesOnly"
				:open-file="openFile"
				:ctx="ctx"
				:view="view"
				:i18n="i18n"
				@busy="(id, value) => (busySessions[id] = value)"
				@attachment="(id, value) => (attachment[id] = value)"
			/>
		</div>
	</section>

	<TransferCenter :transfers="transfers" :i18n="i18n" :narrow="narrowTransfers" />
	<WorkspaceConnectionDialog
		v-model:open="createOpen"
		:connections="connections"
		:credentials="credentials"
		:view="view"
		:i18n="i18n"
		:report="report"
		@created="handleCreated"
	/>
	<UiDialog
		:open="!!suspendedClose"
		:title="t('closeSession')"
		:description="t('closeSuspendedHint', { name: suspendedClose?.name ?? '' })"
		:close-label="t('cancel')"
		:close-disabled="removingSuspended"
		@update:open="(value) => !value && cancelCloseSuspended()"
	>
		<template #footer>
			<UiButton :disabled="removingSuspended" @click="cancelCloseSuspended">{{ t('cancel') }}</UiButton>
			<UiButton tone="danger" :loading="removingSuspended" @click="confirmCloseSuspended">{{
				t('closeSession')
			}}</UiButton>
		</template>
	</UiDialog>

	<UiDialog
		:open="confirmOpen"
		:title="t('stopTransfers')"
		:description="t('stopTransfersHint')"
		:close-label="t('cancel')"
		@update:open="
			(value) => {
				if (!value) answer(false);
			}
		"
	>
		<template #footer
			><UiButton @click="answer(false)">{{ t('cancel') }}</UiButton
			><UiButton tone="danger" @click="answer(true)">{{ t('continue') }}</UiButton></template
		>
	</UiDialog>
	<UiDialog
		:open="!!host"
		:title="t(host?.previousFingerprint ? 'hostChanged' : 'hostTitle')"
		:description="t('hostHint')"
		:close-label="t('close')"
		:close-on-interact-outside="false"
		@update:open="
			(v) => {
				if (!v && !connecting) host = undefined;
			}
		"
		><div class="workspace-fingerprint">
			<span class="workspace-fingerprint__label"><Fingerprint :size="18" />{{ t('fingerprint') }}</span
			><code>{{ host?.fingerprint }}</code
			><template v-if="host?.previousFingerprint"
				><span>{{ t('previous') }}</span
				><code>{{ host.previousFingerprint }}</code></template
			>
		</div>
		<template #footer
			><UiButton :disabled="connecting" @click="host = undefined">{{ t('cancel') }}</UiButton
			><UiButton tone="primary" :loading="connecting" @click="connect(host?.fingerprint)">{{
				t('trust')
			}}</UiButton></template
		></UiDialog
	>
</template>
