<script setup lang="ts">
	import { computed, onScopeDispose, ref, watch } from 'vue';
	import { useClipboard } from '@vueuse/core';
	import { ChevronDown, Copy, Folder, Trash2 } from '@lucide/vue';
	import {
		ComboboxAnchor,
		ComboboxContent,
		ComboboxInput,
		ComboboxItem,
		ComboboxPortal,
		ComboboxRoot,
		ComboboxTrigger,
		ComboboxViewport,
		useFilter,
	} from 'reka-ui';
	import { UiButton, UiContextMenu } from 'nexus-terminal/browser/ui';
	import type { PluginContextApi } from 'nexus-terminal/browser';
	import { WorkspacePathHistorySchema } from '../../shared/workspace-path-history-types';
	import { createWorkspaceClient } from '../workspace-client';
	import type { WorkspaceI18n } from '../workspace-i18n';

	const props = defineProps<{
		ctx: PluginContextApi;
		signal: AbortSignal;
		i18n: WorkspaceI18n;
		path: string;
		loaded: boolean;
		enabled: boolean;
		navigate(path: string): Promise<string | undefined>;
	}>();
	const { t } = props.i18n;
	const { copy } = useClipboard({ legacy: true });
	const client = createWorkspaceClient(props.ctx, props.ctx.signal);
	const draft = ref(props.path);
	const open = ref(false);
	const anchor = ref<HTMLFormElement>();
	const history = ref<string[]>([]);
	const loading = ref(false);
	const failed = ref(false);
	const contextPath = ref<string>();
	let restoringHistoryFocus = false;
	let read: AbortController | undefined;
	let writes = Promise.resolve();

	const { contains } = useFilter({ sensitivity: 'accent' });
	const choices = computed(() => {
		const typed = draft.value;
		const query = typed.trim();
		if (!query || typed === props.path) return history.value;
		return [typed, ...history.value.filter((path) => path !== typed && contains(path, query))];
	});

	function setOpen(visible: boolean) {
		if (visible || (!contextPath.value && !restoringHistoryFocus)) open.value = visible;
	}

	function keepHistory(event: Event) {
		if (
			restoringHistoryFocus ||
			(event.target instanceof Element && event.target.closest('[data-ui="context-menu"]'))
		)
			event.preventDefault();
	}

	function setMenuOpen(path: string, visible: boolean) {
		if (visible) contextPath.value = path;
		else if (contextPath.value === path) contextPath.value = undefined;
	}

	function write(method: 'POST' | 'DELETE', path: string): Promise<void> {
		const operation = writes.then(async () => {
			if (method === 'POST') await client.request('path-history', method, { path });
			else await client.request('path-history?' + new URLSearchParams({ path }), method);
		});
		writes = operation.catch(() => undefined);
		return operation;
	}

	watch(
		() => props.path,
		(path, previous) => {
			if (!open.value || draft.value === previous) draft.value = path;
		},
	);
	watch(
		() => (props.loaded ? props.path : undefined),
		(path) => {
			if (path) void write('POST', path).catch(() => undefined);
		},
		{ immediate: true },
	);
	watch(
		() => props.enabled,
		(enabled) => {
			if (!enabled) open.value = false;
		},
	);

	watch(
		open,
		(visible) => {
			if (visible) void refresh();
			else read?.abort();
		},
		{ flush: 'sync' },
	);
	onScopeDispose(() => read?.abort());

	async function refresh(): Promise<void> {
		read?.abort();
		const request = new AbortController();
		read = request;
		const signal = AbortSignal.any([props.signal, request.signal, props.ctx.signal]);
		loading.value = true;
		failed.value = false;
		try {
			await writes;
			signal.throwIfAborted();
			const reader = createWorkspaceClient(props.ctx, signal);
			const { paths } = await reader.request('path-history', undefined, undefined, WorkspacePathHistorySchema);
			if (!signal.aborted) history.value = paths;
		} catch {
			if (!signal.aborted) failed.value = true;
		} finally {
			if (read === request) loading.value = false;
		}
	}

	function choose(path = draft.value): void {
		if (!props.enabled || !path.trim()) return;
		open.value = false;
		const typed = draft.value;
		void props.navigate(path).then((resolved) => {
			if (resolved !== undefined && !props.signal.aborted && draft.value === typed) draft.value = resolved;
		});
	}

	function cancel(event: Event) {
		if (!open.value && draft.value === props.path) return;
		event.preventDefault();
		event.stopPropagation();
		open.value = false;
		draft.value = props.path;
	}

	async function historyAction(action: string, path: string): Promise<void> {
		restoringHistoryFocus = true;
		if (action === 'remove') restoreHistoryFocus();
		try {
			if (action === 'copy') await copy(path);
			else if (action === 'remove') {
				await write('DELETE', path);
				if (props.signal.aborted) return;
				history.value = history.value.filter((item) => item !== path);
				if (open.value) void refresh();
			}
		} catch (cause) {
			if (!props.signal.aborted) client.report(cause);
		} finally {
			if (action === 'copy') restoreHistoryFocus();
		}
	}

	function restoreHistoryFocus() {
		if (!props.signal.aborted && props.enabled) {
			open.value = true;
			anchor.value?.querySelector('input')?.focus({ preventScroll: true });
		}
		// Reka reconciles dismissal after the context menu and clipboard restore focus.
		requestAnimationFrame(() => {
			restoringHistoryFocus = false;
		});
	}
</script>

<template>
	<ComboboxRoot
		:open="open"
		:model-value="path"
		:disabled="!enabled"
		:reset-search-term-on-select="false"
		:reset-search-term-on-blur="false"
		ignore-filter
		open-on-focus
		open-on-click
		loop
		class="workspace-file-path"
		@update:open="setOpen"
	>
		<form ref="anchor" class="workspace-path-form" @submit.prevent="choose()">
			<ComboboxAnchor class="workspace-path-field">
				<Folder :size="15" aria-hidden="true" />
				<ComboboxInput
					v-model="draft"
					class="workspace-path-input"
					:aria-label="t('path')"
					spellcheck="false"
					@keydown.esc="cancel"
				/>
				<span class="path-history-control">
					<ComboboxTrigger as-child>
						<UiButton
							type="button"
							class="path-history-toggle"
							appearance="ghost"
							density="compact"
							icon-only
							:aria-label="t('pathHistory.title')"
							:title="t('pathHistory.title')"
							><ChevronDown :size="16" aria-hidden="true"
						/></UiButton>
					</ComboboxTrigger>
				</span>
			</ComboboxAnchor>
		</form>
		<ComboboxPortal :to="anchor?.closest('[role=dialog]') ?? 'body'">
			<ComboboxContent
				class="workspace-path-history"
				position="popper"
				align="start"
				:side-offset="4"
				:collision-padding="8"
				:aria-label="t('pathHistory.title')"
				:aria-busy="loading"
				@escape-key-down="cancel"
				@interact-outside="keepHistory"
			>
				<ComboboxViewport>
					<UiContextMenu
						v-for="choice in choices"
						:key="choice"
						:open="contextPath === choice"
						:disabled="!history.includes(choice)"
						:items="[
							{ id: 'copy', label: t('copyPath'), icon: Copy },
							{ id: 'remove', label: t('pathHistory.remove'), icon: Trash2, tone: 'danger' },
						]"
						@update:open="setMenuOpen(choice, $event)"
						@select="historyAction($event, choice)"
					>
						<ComboboxItem
							:value="choice"
							class="path-history-option"
							:title="choice"
							@select.prevent="choose(choice)"
						>
							{{ choice }}
						</ComboboxItem>
					</UiContextMenu>
					<p v-if="!choices.length" class="path-history-message" role="status">
						{{ t(loading ? 'pathHistory.loading' : failed ? 'pathHistory.failed' : 'pathHistory.empty') }}
					</p>
				</ComboboxViewport>
			</ComboboxContent>
		</ComboboxPortal>
	</ComboboxRoot>
</template>

<style scoped>
	.workspace-file-path,
	.workspace-path-form {
		display: flex;
		min-width: 0;
	}

	.workspace-path-form {
		flex: 1;
	}

	.workspace-path-field .path-history-toggle {
		--ui-button-height: 24px;
		--ui-button-radius: 5px;
	}

	.workspace-path-field {
		display: flex;
		flex: 1;
		align-items: center;
		min-width: 0;
		min-height: var(--workspace-control-height);
		gap: 7px;
		padding-inline: 8px 4px;
		border: 1px solid var(--ui-border);
		border-radius: var(--workspace-control-radius);
		background: var(--ui-surface);
		color: color-mix(in srgb, var(--ui-primary) 40%, var(--ui-muted));
	}

	.workspace-path-field:focus-within {
		border-color: var(--ui-primary);
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-primary) 10%, transparent);
	}

	.workspace-path-field > svg {
		flex: none;
	}

	.workspace-path-input {
		flex: 1;
		align-self: stretch;
		min-width: 0;
		padding: 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--ui-text);
		font: 500 13px var(--ui-font-family, system-ui, sans-serif);
		user-select: text;
	}

	.workspace-path-field:has(input:disabled) {
		opacity: 0.6;
	}

	.path-history-control {
		flex: none;
		padding-inline-start: 5px;
		border-inline-start: 1px solid var(--workspace-panel-edge);
	}

	:global(.workspace-path-history) {
		z-index: 105;
		box-sizing: border-box;
		width: max-content;
		min-width: min(var(--reka-combobox-trigger-width), var(--reka-combobox-content-available-width));
		max-width: var(--reka-combobox-content-available-width);
		max-height: min(280px, var(--reka-combobox-content-available-height));
		overflow: auto;
		padding: 4px;
		border: 1px solid var(--ui-border);
		border-radius: 9px;
		background: var(--ui-surface);
		color: var(--ui-text);
		box-shadow: 0 8px 24px #0002;
	}

	.path-history-option {
		display: block;
		width: 100%;
		padding: 7px 8px;
		overflow: hidden;
		border: 0;
		border-radius: 5px;
		background: transparent;
		color: inherit;
		font: 500 13px / 1.4 var(--ui-font-family, system-ui, sans-serif);
		text-align: start;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: pointer;
	}

	.path-history-option:hover,
	.path-history-option:focus-visible,
	.path-history-option[data-highlighted] {
		background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
	}

	.path-history-message {
		margin: 0;
		padding: 7px 8px;
		color: var(--ui-muted);
		font-size: 12px;
	}
</style>
