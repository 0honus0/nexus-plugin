<script setup lang="ts">
	import { onScopeDispose, watch } from 'vue';
	import type { AttachmentStatus } from './session-tab-status';
	import { useCommandTargets } from './commands/command-targets';
	import type { PluginContextApi } from 'nexus-terminal/browser';
	import type { PluginWindowApi } from 'nexus-terminal/browser';
	import type { SessionInfo } from '../shared/workspace-types';
	import type { WorkspaceI18n } from './workspace-i18n';
	import type { FileManagerOpenFile } from './file-manager-api.js';
	import { useSessionTransport } from './use-session-transport';
	import { createTerminalInput } from './terminal/terminal-input';
	import WorkspaceSurface from './presentation/WorkspaceSurface.vue';
	import FilePane from './FilePane.vue';
	const props = defineProps<{
		session: SessionInfo;
		host?: string;
		active: boolean;
		ctx: PluginContextApi;
		view: PluginWindowApi;
		i18n: WorkspaceI18n;
		filesOnly?: boolean;
		openFile?: FileManagerOpenFile;
	}>();
	const emit = defineEmits<{ busy: [value: boolean]; attachment: [value: AttachmentStatus] }>();
	const transport = useSessionTransport(props.ctx, props.session.id, props.view.signal);
	const input = props.filesOnly ? undefined : createTerminalInput(transport);
	let attached = false;
	watch(
		[transport.connected, transport.connecting, transport.terminalClosed],
		([connected, connecting, closed]) => {
			if (connected) attached = true;
			emit(
				'attachment',
				closed && !props.filesOnly
					? 'disconnected'
					: connected
						? 'connected'
						: connecting
							? attached
								? 'reconnecting'
								: 'connecting'
							: 'disconnected',
			);
		},
		{ immediate: true, flush: 'sync' },
	);

	if (input) {
		onScopeDispose(
			useCommandTargets().register(props.session.id, {
				name: props.session.name,
				input,

				ready: () => transport.connected.value && !transport.terminalClosed.value,
			}),
		);
	} else {
		transport.connect();
	}
</script>
<template>
	<WorkspaceSurface
		v-if="input"
		:context="{
			...props,
			transport,
			input,
			busy: (value) => emit('busy', value),
		}"
	/>
	<div v-else class="workspace-file-slot">
		<FilePane
			:session-id="session.id"
			:enabled="active && transport.connected.value"
			:connected="transport.connected.value"
			:ctx="ctx"
			:view="view"
			:i18n="i18n"
			:open-file="openFile"
			files-only
			@busy="emit('busy', $event)"
		/>
	</div>
</template>
