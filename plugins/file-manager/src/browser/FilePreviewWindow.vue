<script setup lang="ts">
	import { computed, onScopeDispose, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { UiButton, UiDialog } from 'nexus-terminal/browser/ui';
	import type { PluginWindowApi } from 'nexus-terminal/browser';
	import FilePreview from './FilePreview.vue';
	import { isDirty, type PreviewDocument } from './preview-document.js';
	import { language, messages } from './messages.js';

	const props = defineProps<{ tabs: readonly PreviewDocument[]; view: PluginWindowApi }>();
	const active = defineModel<string | undefined>('active');
	const emit = defineEmits<{ close: [id: string] }>();
	const { locale } = useI18n({ useScope: 'global' });
	const copy = computed(() => messages[language(locale.value)]);
	const discardTarget = ref<{ tabId: string } | { resolve: (discard: boolean) => void }>();
	const discardOpen = computed({
		get: () => discardTarget.value !== undefined,

		set: (open) => {
			if (!open) finishDiscard(false);
		},
	});

	onScopeDispose(
		props.view.onBeforeClose(async (event) => {
			if (discardTarget.value || props.tabs.some((tab) => tab.saving)) {
				event.preventDefault();
				return;
			}
			if (!props.tabs.some(isDirty)) return;
			const discard = await new Promise<boolean>((resolve) => {
				discardTarget.value = { resolve };
			});
			if (!discard) event.preventDefault();
		}),
	);
	onScopeDispose(() => finishDiscard(false));

	onScopeDispose(
		props.view.registerTabs({
			items: computed(() =>
				props.tabs.map((tab) => ({
					id: tab.id,
					label: tab.file.name,
					closable: true,
					status: tab.saving
						? { tone: 'info' as const, busy: true, label: copy.value.saving }
						: isDirty(tab)
							? { tone: 'warning' as const, label: copy.value.unsaved }
							: undefined,
				})),
			),
			activeId: active,

			onSelect(id) {
				active.value = id;
			},

			onClose(id) {
				const tab = props.tabs.find((item) => item.id === id);
				if (!tab || tab.saving) return;
				if (discardTarget.value) return;
				if (isDirty(tab)) discardTarget.value = { tabId: id };
				else emit('close', id);
			},
		}),
	);

	watch(
		() => props.tabs.some(isDirty),
		(dirty, _, onCleanup) => {
			if (!dirty) return;

			const beforeUnload = (event: BeforeUnloadEvent) => {
				event.preventDefault();
				event.returnValue = true;
			};

			window.addEventListener('beforeunload', beforeUnload);
			onCleanup(() => window.removeEventListener('beforeunload', beforeUnload));
		},
		{ immediate: true },
	);

	function finishDiscard(discard: boolean) {
		const target = discardTarget.value;
		discardTarget.value = undefined;
		if (!target) return;
		if ('resolve' in target) target.resolve(discard);
		else if (discard) emit('close', target.tabId);
	}
</script>

<template>
	<div class="file-preview-window">
		<FilePreview v-for="tab in tabs" v-show="tab.id === active" :key="tab.id" :tab="tab" :signal="view.signal" />
		<p v-if="!tabs.length" class="file-preview-window__empty" role="status">{{ copy.empty }}</p>
		<UiDialog v-model:open="discardOpen" :title="copy.unsaved" :close-label="copy.cancel">
			<p>{{ discardTarget && 'resolve' in discardTarget ? copy.discardWindowQuestion : copy.discardQuestion }}</p>
			<template #footer>
				<UiButton appearance="ghost" @click="discardOpen = false">{{ copy.cancel }}</UiButton>
				<UiButton tone="danger" @click="finishDiscard(true)">{{ copy.discard }}</UiButton>
			</template>
		</UiDialog>
	</div>
</template>

<style scoped>
	.file-preview-window {
		height: 100%;
		min-height: 0;
	}
	.file-preview-window__empty {
		display: grid;
		height: 100%;
		margin: 0;
		place-items: center;
		color: var(--ui-muted);
	}
</style>
