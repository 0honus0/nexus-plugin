<script setup lang="ts">
	import { computed, ref } from 'vue';
	import { Server, Monitor, ScreenShare, Search, ChevronDown, Tags, Play, Plus, X, LoaderCircle } from '@lucide/vue';
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
	const icons = { ssh: Server, rdp: Monitor, vnc: ScreenShare };
	const typeOptions = computed(() => [
		{ value: 'all', label: t('allTypes') },
		...(['ssh', 'rdp', 'vnc'] as const).map((value) => ({
			value,
			label: t('connectionTypes.' + value),
		})),
	]);
	const groups = computed(() => {
		const query = search.value.trim().toLocaleLowerCase();
		const groups = new Map<string, Connection[]>();
		for (const connection of props.connections) {
			if (type.value !== 'all' && connection.type !== type.value) continue;
			if (
				query &&
				![connection.name, connection.host, ...connection.tags].some((value) =>
					value.toLocaleLowerCase().includes(query),
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
				<h2>{{ t(filesOnly ? 'fileManagerChoose' : 'subtitle') }}</h2>
			</div>
			<div v-if="connections.length" class="workspace-home-actions">
				<UiButton tone="primary" appearance="solid" :disabled="!connectionsAvailable" @click="emit('create')">
					<template #leading><Plus :size="15" /></template>{{ t('addConnection') }}
				</UiButton>
			</div>
		</header>
		<section v-if="suspended.length" class="workspace-suspended">
			<h3>
				<Play :size="16" />{{ t('sessions') }}<span>{{ suspended.length }}</span>
			</h3>
			<div class="workspace-home-grid">
				<UiCard
					v-for="session in suspended"
					:key="session.id"
					:title="session.name"
					class="workspace-suspended-card"
					tone="warning"
					:action-label="t('resume') + ' · ' + session.name"
					:icon="Play"
					@select="emit('resume', session)"
				>
					<template #tags
						><UiBadge tone="warning" dot>{{ t('suspended') }}</UiBadge></template
					>
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
			<div v-if="connections.length" class="workspace-home-filters">
				<div class="workspace-home-search">
					<UiInput v-model="search" :placeholder="t('searchConnections')" :aria-label="t('searchConnections')"
						><template #leading><Search :size="16" /></template
					></UiInput>
				</div>
				<UiSelect v-if="!filesOnly" v-model="type" :options="typeOptions" :aria-label="t('filterType')" />
			</div>
			<div v-if="!connectionsLoaded" class="workspace-home-empty">
				<p v-if="!connectionsAvailable" role="status">{{ t('connectionsUnavailable') }}</p>
				<template v-else-if="connectionsReadFailed">
					<p>{{ t('connectionsReadFailed') }}</p>
					<UiButton @click="emit('retry')">{{ t('retryConnections') }}</UiButton>
				</template>
				<p v-else role="status">{{ t('loadingConnections') }}</p>
			</div>
			<CollapsibleRoot v-for="group in groups" :key="group.tag" :default-open="true" class="workspace-group">
				<CollapsibleTrigger class="workspace-group-heading">
					<Tags :size="16" aria-hidden="true" />
					<span class="workspace-group-label">{{ group.tag || t('ungrouped') }}</span>
					<UiBadge class="workspace-group-count">{{ n(group.items.length) }}</UiBadge>
					<ChevronDown :size="16" class="workspace-group-chevron" aria-hidden="true" />
				</CollapsibleTrigger>
				<CollapsibleContent
					><div class="workspace-home-grid workspace-connections">
						<UiCard
							v-for="connection in group.items"
							:key="connection.id"
							class="workspace-connection-card"
							:data-protocol="connection.type"
							:title="connection.name"
							:description="address(connection)"
							:icon="icons[connection.type]"
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
