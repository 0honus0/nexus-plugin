<script setup lang="ts">
	import { computed, reactive, ref, watch } from 'vue';
	import { Server, Monitor, ScreenShare, Search, ChevronRight, Plus, X, LoaderCircle } from '@lucide/vue';
	import { CollapsibleRoot, CollapsibleTrigger, CollapsibleContent } from 'reka-ui';
	import { UiBadge, UiButton, UiCard, UiInput, UiSelect } from 'nexus-terminal/browser/ui';
	import { type Connection } from '@nexus-terminal/connections/connections-client-api';
	import type { SessionInfo } from '../shared/workspace-types';
	import type { WorkspaceI18n } from './workspace-i18n';
	const props = defineProps<{
		connections: Connection[];
		suspended: SessionInfo[];
		connectionsAvailable: boolean;
		desktopAvailable: boolean;
		connectionsLoaded: boolean;
		connectionsReadFailed: boolean;
		connecting: boolean;
		selected: string;
		filesOnly?: boolean;
		i18n: WorkspaceI18n;
	}>();
	const emit = defineEmits<{
		connect: [id: string];
		resume: [session: SessionInfo];
		close: [id: string];
		create: [];
		manage: [];
		retry: [];
	}>();
	const { t, n } = props.i18n;
	const search = ref(''),
		type = ref('all');
	const collapsed = reactive(new Set<string>());
	const searchCollapsed = reactive(new Set<string>());
	const query = computed(() => search.value.trim().toLocaleLowerCase());
	const collapsedGroups = computed(() => (query.value ? searchCollapsed : collapsed));
	watch(query, () => searchCollapsed.clear());

	function setGroupOpen(tag: string, open: boolean) {
		if (open) collapsedGroups.value.delete(tag);
		else collapsedGroups.value.add(tag);
	}

	const icons = { ssh: Server, rdp: Monitor, vnc: ScreenShare };
	const typeOptions = computed(() => [
		{ value: 'all', label: t('allTypes') },
		...(['ssh', 'rdp', 'vnc'] as const).map((value) => ({
			value,
			label: t('connectionTypes.' + value),
		})),
	]);
	const groups = computed(() => {
		const groups = new Map<string, Connection[]>();
		for (const connection of props.connections) {
			if (type.value !== 'all' && connection.type !== type.value) continue;
			if (
				query.value &&
				![connection.name, address(connection), ...connection.tags].some((value) =>
					value.toLocaleLowerCase().includes(query.value),
				)
			)
				continue;
			for (const tag of connection.tags.length ? connection.tags : ['']) {
				const items = groups.get(tag) ?? [];
				items.push(connection);
				groups.set(tag, items);
			}
		}
		return [...groups]
			.sort(([a], [b]) => (!a ? 1 : !b ? -1 : a.localeCompare(b)))
			.map(([tag, items]) => ({ tag, items: items.sort((a, b) => a.name.localeCompare(b.name)) }));
	});

	const address = (connection: Connection) =>
		`${connection.host.includes(':') ? '[' + connection.host + ']' : connection.host}:${connection.port}`;
</script>
<template>
	<div class="workspace-home">
		<header class="workspace-home-heading">
			<div class="workspace-home-heading__text">
				<h2>{{ t(filesOnly ? 'serverDirectory' : 'connectionDirectory') }}</h2>
			</div>
			<div v-if="connections.length" class="workspace-home-actions">
				<UiButton tone="primary" appearance="solid" :disabled="!connectionsAvailable" @click="emit('create')">
					<template #leading><Plus :size="15" /></template>{{ t('addConnection') }}
				</UiButton>
			</div>
		</header>
		<div v-if="connections.length" class="workspace-home-filters">
			<div class="workspace-home-search">
				<UiInput v-model="search" :placeholder="t('searchConnections')" :aria-label="t('searchConnections')"
					><template #leading><Search :size="16" /></template
				></UiInput>
			</div>
			<UiSelect v-if="!filesOnly" v-model="type" :options="typeOptions" :aria-label="t('filterType')" />
		</div>
		<section v-if="suspended.length" class="workspace-suspended" :aria-label="t('sessions')">
			<div class="workspace-suspended-list">
				<UiCard
					v-for="session in suspended"
					:key="session.id"
					:title="session.name"
					:description="t('suspendedSshSession')"
					class="workspace-suspended-card"
					tone="warning"
					:action-label="t('resume') + ' · ' + session.name"
					@select="emit('resume', session)"
				>
					<template #icon><span class="workspace-suspended-dot" aria-hidden="true" /></template>
					<template #actions
						><UiButton
							appearance="ghost"
							density="compact"
							icon-only
							:aria-label="t('closeSession') + ' · ' + session.name"
							@click="emit('close', session.id)"
							><X :size="15" /></UiButton
					></template>
				</UiCard>
			</div>
		</section>
		<div
			class="workspace-home-groups"
			:aria-busy="connectionsAvailable && !connectionsLoaded && !connectionsReadFailed"
		>
			<div v-if="!connectionsLoaded" class="workspace-home-empty">
				<p v-if="!connectionsAvailable" role="status">{{ t('connectionsUnavailable') }}</p>
				<template v-else-if="connectionsReadFailed">
					<p>{{ t('connectionsReadFailed') }}</p>
					<UiButton @click="emit('retry')">{{ t('retryConnections') }}</UiButton>
				</template>
				<p v-else role="status">{{ t('loadingConnections') }}</p>
			</div>
			<CollapsibleRoot
				v-for="group in groups"
				:key="group.tag"
				:open="!collapsedGroups.has(group.tag)"
				class="workspace-group"
				@update:open="setGroupOpen(group.tag, $event)"
			>
				<CollapsibleTrigger class="workspace-group-heading">
					<ChevronRight :size="16" class="workspace-group-chevron" aria-hidden="true" />
					<span class="workspace-group-label">{{ group.tag || t('ungrouped') }}</span>
					<UiBadge class="workspace-group-count">{{ n(group.items.length) }}</UiBadge>
				</CollapsibleTrigger>
				<CollapsibleContent
					><div class="workspace-connections">
						<UiCard
							v-for="connection in group.items"
							:key="connection.id"
							class="workspace-connection-card"
							:data-protocol="connection.type"
							:title="connection.name"
							:description="address(connection)"
							:action-label="connection.name"
							:disabled="connection.type === 'ssh' ? connecting : !desktopAvailable"
							:aria-busy="connecting && selected === connection.id"
							@select="emit('connect', connection.id)"
						>
							<template #icon
								><LoaderCircle
									v-if="connecting && selected === connection.id"
									:size="23"
									class="workspace-connection-spinner" /><component
									v-else
									:is="icons[connection.type]"
									:size="23"
							/></template>
							<template
								v-if="
									(connection.type !== 'ssh' && !desktopAvailable) ||
									(connection.type !== 'vnc' && !connection.credentialId)
								"
								#tags
							>
								<span
									v-if="connection.type !== 'ssh' && !desktopAvailable"
									class="workspace-connection-hint"
									>{{ t('unsupportedConnection') }}</span
								>
								<span v-else class="workspace-connection-hint">{{ t('noCredential') }}</span>
							</template>
							<template #title-end>
								<span class="workspace-protocol">{{ t('connectionTypes.' + connection.type) }}</span>
							</template>
						</UiCard>
					</div></CollapsibleContent
				>
			</CollapsibleRoot>
			<div v-if="connectionsLoaded && !connections.length" class="workspace-home-empty-card">
				<span class="workspace-home-empty-card__icon" aria-hidden="true"><Server :size="24" /></span>
				<h3>{{ t('emptyConnections') }}</h3>
				<p>{{ t(filesOnly ? 'fileManagerEmptyHint' : 'emptyHint') }}</p>
				<UiButton tone="primary" appearance="solid" :disabled="!connectionsAvailable" @click="emit('create')">
					<template #leading><Plus :size="15" /></template>{{ t('addConnection') }}
				</UiButton>
			</div>
			<p v-else-if="connectionsLoaded && !groups.length" class="workspace-home-empty">
				{{ t('noConnectionsMatch') }}
			</p>
		</div>
	</div>
</template>
