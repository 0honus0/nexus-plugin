<script setup lang="ts">
	import '../../../../shared/browser/catalog.css';
	import { ref, computed, onMounted } from 'vue';
	import { KeyRound, LockKeyhole, Plus, Search, Trash2, RefreshCw } from '@lucide/vue';
	import { UiInput, UiButton, UiCard, UiEmptyState, UiDialog } from 'nexus-terminal/browser/ui';
	import type { PluginWindowProps } from 'nexus-terminal/browser';
	import { useI18n } from 'vue-i18n';
	import { messages } from './messages.js';
	import type { CredentialsClient } from './credentials-client-api.js';
	import type { Credential } from '../shared/credentials-types';
	import CredentialEditor from './CredentialEditor.vue';
	const props = defineProps<PluginWindowProps & { runtime: CredentialsClient }>();
	const { t, n } = useI18n({ useScope: 'local', messages });
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
		{ value: 'all', label: t('all') },
		{ value: 'password', label: t('tile.password') },
		{ value: 'privateKey', label: t('tile.privateKey') },
	]);
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
	<section class="credentials-app plugin-catalog" data-ui-selection="none">
		<header class="plugin-catalog__header">
			<div class="plugin-catalog__identity">
				<h2>{{ t('catalogTitle') }}</h2>
				<span
					v-if="loaded"
					class="plugin-catalog__count"
					:aria-label="t('catalogCount', { shown: entries.length, total: items.length })"
				>
					{{ n(entries.length)
					}}<template v-if="entries.length !== items.length"> / {{ n(items.length) }}</template>
				</span>
			</div>
			<div v-if="!loaded || items.length" class="plugin-catalog__actions">
				<UiButton tone="primary" appearance="solid" @click="editor = {}"
					><template #leading><Plus :size="15" /></template>{{ t('add') }}</UiButton
				>
				<UiButton
					appearance="soft"
					icon-only
					:loading="loading"
					loading-animation="icon"
					:aria-label="t('refresh')"
					@click="refresh"
					><RefreshCw :size="16"
				/></UiButton>
			</div>
			<div v-if="!loaded || items.length" class="plugin-catalog__tools">
				<div class="credentials-options" role="group" :aria-label="t('type')">
					<button
						v-for="option in typeOptions"
						:key="option.value"
						class="credentials-option"
						type="button"
						:aria-pressed="type === option.value"
						@click="type = option.value"
					>
						{{ option.label }}
					</button>
				</div>
				<div class="plugin-catalog__search">
					<UiInput v-model="search" :placeholder="t('searchShort')" :aria-label="t('search')"
						><template #leading><Search :size="16" /></template
					></UiInput>
				</div>
			</div>
		</header>
		<div
			class="credentials-list plugin-catalog__list"
			:data-first="(loaded && !items.length) || undefined"
			:aria-busy="loading"
		>
			<UiCard
				v-for="item in entries"
				:key="item.id"
				class="credentials-card plugin-catalog__card"
				:data-type="item.type"
				:title="item.name"
				:description="item.username"
				:action-label="t('edit') + ' · ' + item.name"
				:icon="item.type === 'password' ? LockKeyhole : KeyRound"
				tone="primary"
				@select="editor = { credential: item }"
			>
				<template #title-end>
					<span class="credentials-type">{{ t(item.type + 'Type') }}</span>
				</template>
				<template #actions>
					<UiButton
						appearance="ghost"
						tone="danger"
						icon-only
						:title="t('delete')"
						:aria-label="t('delete') + ' · ' + item.name"
						@click="pending = item"
						><Trash2 :size="16"
					/></UiButton>
				</template>
			</UiCard>
			<UiEmptyState
				class="credentials-empty plugin-catalog__empty"
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
