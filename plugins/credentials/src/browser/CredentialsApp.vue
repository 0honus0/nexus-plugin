<script setup lang="ts">
	import { ref, computed, onMounted } from 'vue';
	import { Ellipsis, KeyRound, LockKeyhole, Pencil, Plus, Search, Trash2, RefreshCw } from '@lucide/vue';
	import {
		UiInput,
		UiButton,
		UiCard,
		UiEmptyState,
		UiDialog,
		UiDropdownMenu,
		UiSelect,
	} from 'nexus-terminal/browser/ui';
	import type { PluginWindowProps } from 'nexus-terminal/browser';
	import { useI18n } from 'vue-i18n';
	import { messages } from './messages.js';
	import type { CredentialsClient } from './credentials-client-api.js';
	import type { Credential } from '../shared/credentials-types';
	import CredentialEditor from './CredentialEditor.vue';
	const props = defineProps<PluginWindowProps & { runtime: CredentialsClient }>();
	const { t } = useI18n({ useScope: 'local', messages });
	const { items, loaded, pending: requests } = props.runtime;
	const loading = computed(() => requests.value > 0);

	function refresh() {
		void props.runtime.refresh(props.view.signal).catch((cause) => props.runtime.report(cause, props.view.signal));
	}

	const search = ref(''),
		type = ref('all'),
		editor = ref<{ credential?: Credential }>(),
		pending = ref<Credential>(),
		deleting = ref(false);
	const typeOptions = computed(() => [
		{ value: 'all', label: t('allTypes') },
		{ value: 'password', label: t('passwordType') },
		{ value: 'privateKey', label: t('privateKeyType') },
	]);
	const actions = computed(() => [
		{ id: 'edit', label: t('edit'), icon: Pencil },
		{ id: 'delete', label: t('delete'), icon: Trash2, tone: 'danger' as const },
	]);

	function selectAction(action: string, item: Credential) {
		if (action === 'edit') editor.value = { credential: item };
		else if (action === 'delete') pending.value = item;
	}

	const entries = computed(() =>
		items.value.filter(
			(v) =>
				(type.value === 'all' || v.type === type.value) &&
				[v.name, v.username].some((s) => s.toLowerCase().includes(search.value.trim().toLowerCase())),
		),
	);

	function clearFilters() {
		search.value = '';
		type.value = 'all';
	}

	onMounted(refresh);

	async function remove() {
		if (!pending.value || deleting.value || props.view.signal.aborted) return;
		deleting.value = true;
		try {
			await props.runtime.remove(pending.value.id, props.view);
			pending.value = undefined;
		} catch (e) {
			props.runtime.report(e, props.view.signal);
		} finally {
			deleting.value = false;
		}
	}
</script>
<template>
	<section class="credentials-app" data-ui-selection="none">
		<header v-if="!loaded || items.length" class="credentials-toolbar">
			<div class="credentials-toolbar-filters">
				<div class="credentials-search">
					<UiInput v-model="search" :placeholder="t('searchShort')" :aria-label="t('search')"
						><template #leading><Search :size="16" /></template
					></UiInput>
				</div>
				<UiSelect
					v-model="type"
					class="credentials-type-filter"
					:options="typeOptions"
					:aria-label="t('type')"
				/>
			</div>
			<div class="credentials-toolbar-actions">
				<UiButton tone="primary" appearance="solid" @click="editor = {}"
					><template #leading><Plus :size="15" /></template>{{ t('add') }}</UiButton
				>
				<UiButton
					appearance="ghost"
					icon-only
					:loading="loading"
					loading-animation="icon"
					:aria-label="t('refresh')"
					@click="refresh"
					><RefreshCw :size="16"
				/></UiButton>
			</div>
		</header>
		<div class="credentials-list" :data-first="(loaded && !items.length) || undefined" :aria-busy="loading">
			<UiCard
				v-for="item in entries"
				:key="item.id"
				class="credentials-card"
				:data-type="item.type"
				:title="item.name"
				:description="item.username"
				:icon="item.type === 'password' ? LockKeyhole : KeyRound"
				tone="primary"
				@select="editor = { credential: item }"
			>
				<template #badge>
					<span class="credentials-type" :data-type="item.type">{{ t(item.type + 'Type') }}</span>
				</template>
				<template #actions>
					<UiDropdownMenu :items="actions" @select="selectAction($event, item)">
						<UiButton appearance="ghost" icon-only :aria-label="t('actions') + ' · ' + item.name"
							><Ellipsis :size="18"
						/></UiButton>
					</UiDropdownMenu>
				</template>
			</UiCard>
			<UiEmptyState
				class="credentials-empty"
				v-if="loaded && !entries.length"
				:icon="items.length ? Search : KeyRound"
				:title="t(items.length ? 'noResults' : 'empty')"
				:description="items.length ? '' : t('emptyHint')"
			>
				<UiButton v-if="!items.length" tone="primary" appearance="solid" @click="editor = {}">
					<template #leading><Plus :size="15" /></template>{{ t('add') }}
				</UiButton>
				<UiButton v-else appearance="soft" @click="clearFilters">{{ t('clearFilters') }}</UiButton>
			</UiEmptyState>
		</div>
	</section>
	<CredentialEditor
		:view="view"
		v-if="editor"
		:runtime="runtime"
		:credential="editor.credential"
		@close="editor = undefined"
	/>
	<UiDialog
		:open="!!pending"
		:close-disabled="deleting"
		:title="t('deleteTitle')"
		:description="pending ? t('deleteHint', { name: pending.name }) : ''"
		:close-label="t('close')"
		@update:open="(value) => !value && (pending = undefined)"
		><template #footer
			><UiButton :disabled="deleting" @click="pending = undefined">{{ t('cancel') }}</UiButton
			><UiButton tone="danger" appearance="solid" :loading="deleting" loading-animation="spinner" @click="remove"
				><template #leading><Trash2 :size="15" /></template>{{ t('delete') }}</UiButton
			></template
		></UiDialog
	>
</template>
