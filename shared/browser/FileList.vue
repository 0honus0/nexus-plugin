<script
	setup
	lang="ts"
	generic="Entry extends { path: string; name: string; kind: string; size: number; modifiedAt: number }"
>
	import { Folder } from '@lucide/vue';
	import { UiContextMenu, UiEmptyState, type UiMenuItem } from 'nexus-terminal/browser/ui';
	import type { StyleValue } from 'vue';

	defineProps<{
		entries: readonly Entry[];
		selectedPaths: ReadonlySet<string>;
		cutPaths: ReadonlySet<string>;
		filesOnly?: boolean;
		enabled: boolean;
		busy: boolean;
		menuDisabled: boolean;
		menuItems: UiMenuItem[];
		emptyTitle?: string;
		fileScaleStyle: StyleValue;
		locale: string;
		t(key: string): string;
		isParent(entry: Entry): boolean;
		displayName(entry: Entry): string;
		size(bytes: number): string;
		modifiedDate(time: number): string;
	}>();

	const emit = defineEmits<{
		menu: [id: string];
		select: [entry: Entry, event: MouseEvent];
		open: [entry: Entry, event: MouseEvent];
		enter: [entry: Entry, event: KeyboardEvent];
		context: [entry: Entry | undefined];
		prepare: [entry: Entry];
		prefetch: [entry: Entry, event: PointerEvent];
		cancelPrefetch: [];
	}>();
</script>

<template>
	<div class="workspace-file-viewport" :data-files-only="filesOnly || undefined">
		<div v-if="filesOnly" class="workspace-file-columns">
			<span>{{ t('sortName') }}</span>
			<span class="workspace-file-size">{{ t('fileSize') }}</span>
			<span class="workspace-file-modified">{{ t('fileModified') }}</span>
		</div>
		<UiContextMenu :items="menuItems" :disabled="menuDisabled" @select="emit('menu', $event)">
			<div
				class="workspace-file-list"
				:style="fileScaleStyle"
				:aria-busy="busy"
				tabindex="0"
				@pointerdown.capture="emit('context', undefined)"
				@contextmenu.capture="emit('context', undefined)"
			>
				<button
					v-for="entry in entries"
					:key="entry.path"
					v-memo="[entry, selectedPaths.has(entry.path), cutPaths.has(entry.path), enabled, locale]"
					class="workspace-file-row"
					:class="{
						'is-parent': isParent(entry),
						'is-directory': entry.kind === 'directory' && !isParent(entry),
						'is-selected': selectedPaths.has(entry.path),
						'is-cut': cutPaths.has(entry.path),
					}"
					:aria-label="isParent(entry) ? t('parentDirectory') : displayName(entry)"
					:aria-pressed="selectedPaths.has(entry.path)"
					:disabled="!enabled"
					@click="emit('select', entry, $event)"
					@dblclick="emit('open', entry, $event)"
					@keydown.enter="emit('enter', entry, $event)"
					@contextmenu="emit('prepare', entry)"
					@pointerdown="emit('context', entry)"
					@pointerenter="emit('prefetch', entry, $event)"
					@pointerleave="emit('cancelPrefetch')"
				>
					<slot name="icon" :entry="entry" /><span class="workspace-file-name" :title="displayName(entry)">{{
						displayName(entry)
					}}</span
					><span class="workspace-file-size">{{
						isParent(entry)
							? ''
							: entry.kind === 'directory'
								? filesOnly
									? '—'
									: t('directory')
								: size(entry.size)
					}}</span>
					<span v-if="filesOnly && !isParent(entry)" class="workspace-file-modified">{{
						entry.modifiedAt ? modifiedDate(entry.modifiedAt) : '—'
					}}</span>
				</button>
				<UiEmptyState class="workspace-panel-empty" v-if="emptyTitle" :title="emptyTitle" :icon="Folder" />
			</div>
		</UiContextMenu>
	</div>
</template>

<style scoped>
	.workspace-file-viewport {
		flex: 1 1 0;
		min-height: 0;
		overflow: clip;
	}
	.workspace-file-list {
		box-sizing: border-box;
		container: workspace-files / inline-size;
		min-height: 0;
		padding: 4px 6px 8px;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.workspace-file-row {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 30px;
		border: 0;
		background: transparent;
		color: var(--ui-text);
		font: inherit;
		font-size: 12.5px;
		line-height: 18px;
		text-align: start;
		border-radius: 7px;
		padding: 5px 8px;
		cursor: pointer;
		transition: background-color 120ms ease;
	}
	.workspace-file-row:hover:not(:disabled) {
		background: color-mix(in srgb, var(--ui-text) 5.5%, transparent);
	}
	.workspace-file-row.is-selected {
		background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-primary) 22%, transparent);
	}
	.workspace-file-row.is-directory .workspace-file-name {
		font-weight: 500;
	}
	.workspace-file-row.is-parent .workspace-file-name {
		grid-column: 2;
		color: var(--ui-muted);
		font-weight: 520;
		letter-spacing: 0.06em;
	}
	.workspace-file-row.is-cut {
		opacity: 0.45;
	}
	.workspace-file-row:focus-visible {
		outline: 2px solid var(--ui-primary);
		outline-offset: -2px;
	}
	.workspace-file-name {
		display: block;
		min-width: 0;
		line-height: 18px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.workspace-file-size {
		color: var(--ui-muted);
		font-size: 11px;
		line-height: 18px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		opacity: 0.85;
	}
	.workspace-file-viewport[data-files-only] {
		--file-columns: 22px minmax(0, 1fr) 76px 144px;
		display: flex;
		flex-direction: column;
		margin: 0 14px;
		border: 1px solid var(--ui-border);
		border-radius: 10px;
	}
	[data-files-only] .workspace-file-columns,
	[data-files-only] .workspace-file-row {
		display: grid;
		grid-template-columns: var(--file-columns);
		align-items: center;
		gap: 8px;
		padding-inline: 12px;
	}
	.workspace-file-columns {
		flex: none;
		min-block-size: 32px;
		border-bottom: 1px solid var(--ui-border);
		background: color-mix(in srgb, var(--ui-text) 4%, var(--ui-surface));
		color: var(--ui-muted);
		font-size: 11px;
		font-weight: 600;
		overflow: hidden;
		scrollbar-gutter: stable;
	}
	.workspace-file-columns > :first-child {
		grid-column: 2;
	}
	[data-files-only] .workspace-file-list {
		flex: 1 1 auto;
		min-height: 0;
		gap: 0;
		padding: 0;
		scrollbar-gutter: stable;
	}
	[data-files-only] .workspace-file-row {
		flex: none;
		min-block-size: 37px;
		border-bottom: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
		border-radius: 0;
	}
	[data-files-only] .workspace-file-size {
		display: block;
		text-align: end;
	}
	.workspace-file-row .workspace-file-modified {
		color: var(--ui-muted);
		font-size: 11px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	@container file-pane (max-width: 610px) {
		.workspace-file-viewport[data-files-only] {
			margin-inline: 10px;
		}
	}
	@container file-pane (max-width: 500px) {
		[data-files-only] .workspace-file-columns,
		[data-files-only] .workspace-file-row {
			grid-template-columns: 22px minmax(0, 1fr) 60px;
		}
		.workspace-file-modified {
			display: none;
		}
	}
	@container workspace-files (max-width: 300px) {
		.workspace-file-row {
			grid-template-columns: 18px minmax(0, 1fr);
		}
		.workspace-file-size {
			display: none;
		}
	}
</style>
