<script setup lang="ts">
	import { computed, onScopeDispose, shallowRef, watch } from 'vue';
	import { SquareTerminal } from '@lucide/vue';
	import { UiActionCard } from 'nexus-terminal/browser/ui';
	import type { PluginApplicationTileProps } from 'nexus-terminal/browser';
	import { useI18n } from 'vue-i18n';
	import { SessionListResponseSchema, WorkspaceSessionsTopic } from '../shared/workspace-types';
	import { createWorkspaceI18n } from './workspace-i18n';
	import { summarizeWorkspaceSessions } from './workspace-tile-state';
	const props = defineProps<PluginApplicationTileProps>();
	const { locale } = useI18n({ useScope: 'global' });
	const i18n = createWorkspaceI18n(locale);
	onScopeDispose(i18n.dispose);
	const shape = computed(() =>
		props.size.columns === 1 && props.size.rows === 1
			? 'compact'
			: props.size.rows === 1
				? 'wide'
				: props.size.columns === 1
					? 'tall'
					: 'large',
	);
	const counts = shallowRef<ReturnType<typeof summarizeWorkspaceSessions>>();
	const metrics = computed(() =>
		shape.value === 'large'
			? (['attached', 'suspended', 'disconnected', 'transfers'] as const)
			: (['attached', 'suspended'] as const),
	);
	watch(
		() => shape.value !== 'compact',
		(expanded, _, onCleanup) => {
			counts.value = undefined;
			if (!expanded || props.view.signal.aborted) return;
			const stop = props.context.app.state.subscribe(
				WorkspaceSessionsTopic,
				SessionListResponseSchema,
				{
					updated: ({ items }) => {
						counts.value = summarizeWorkspaceSessions(items);
					},

					unconfirmed: () => {
						counts.value = undefined;
					},
				},
				props.view.signal,
			);
			onCleanup(stop);
		},
		{ immediate: true },
	);
</script>
<template>
	<UiActionCard class="workspace-desktop-tile" :data-shape="shape" :label="i18n.title.value" @click="open">
		<span class="workspace-tile__heading">
			<span class="workspace-tile__icon"><SquareTerminal :size="16" aria-hidden="true" /></span>
			<strong>{{ i18n.title.value }}</strong>
		</span>
		<span v-if="shape !== 'compact'" class="workspace-tile__metrics">
			<span v-for="metric in metrics" :key="metric" class="workspace-tile__metric" :data-metric="metric">
				<strong>{{ counts ? i18n.n(counts[metric]) : '—' }}</strong>
				<span class="workspace-tile__metric-label"
					><span class="workspace-tile__dot" aria-hidden="true" /><span>{{
						i18n.t('tile.' + metric)
					}}</span></span
				>
			</span>
		</span>
	</UiActionCard>
</template>
<style scoped>
	.workspace-desktop-tile {
		--ui-action-card-background: color-mix(in srgb, var(--ui-primary) 8%, var(--ui-surface));
		--ui-action-card-padding: clamp(6px, 5cqmin, 14px);
	}
	.workspace-desktop-tile :deep(.ui-action-card__content) {
		display: flex;
		flex-direction: column;
		gap: clamp(4px, 4cqmin, 10px);
	}
	.workspace-tile__heading {
		display: flex;
		align-items: center;
		flex: none;
		min-width: 0;
		gap: 6px;
		font-size: 12px;
		line-height: 1.2;
	}
	.workspace-tile__heading strong {
		font-weight: 550;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.workspace-tile__icon {
		flex: none;
		display: grid;
		place-items: center;
		color: var(--ui-primary);
	}
	.workspace-tile__metrics {
		display: grid;
		flex: 1;
		min-height: 0;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		grid-auto-rows: minmax(0, 1fr);
		gap: clamp(4px, 3cqmin, 8px);
	}
	.workspace-tile__metric {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
		gap: clamp(2px, 2cqmin, 6px);
		padding: 3px;
		border-radius: 9px;
		background: color-mix(in srgb, var(--ui-primary) 6%, transparent);
	}
	.workspace-tile__metric > strong {
		font-size: clamp(16px, 20cqmin, 24px);
		line-height: 1;
		font-weight: 550;
		font-variant-numeric: tabular-nums;
	}
	.workspace-tile__metric-label {
		display: flex;
		align-items: center;
		gap: 4px;
		max-width: 100%;
		font-size: 10px;
		line-height: 1.2;
		color: var(--ui-muted);
	}
	.workspace-tile__metric-label > span:last-child {
		overflow: hidden;
		white-space: nowrap;
		text-overflow: ellipsis;
	}
	.workspace-tile__dot {
		width: 6px;
		height: 6px;
		border-radius: 50%;
		flex: none;
		background: var(--ui-muted);
	}
	[data-metric='attached'] .workspace-tile__dot {
		background: var(--ui-success);
	}
	[data-metric='suspended'] .workspace-tile__dot {
		background: var(--ui-warning);
	}
	[data-metric='transfers'] .workspace-tile__dot {
		background: var(--ui-primary);
	}
	[data-shape='large'] .workspace-tile__metric > strong {
		font-size: clamp(20px, 14cqmin, 30px);
	}
	[data-shape='tall'] .workspace-tile__metrics {
		grid-template-columns: minmax(0, 1fr);
	}
	[data-shape='compact'] :deep(.ui-action-card__content) {
		justify-content: center;
	}
	[data-shape='compact'] .workspace-tile__heading {
		flex-direction: column;
		gap: 7px;
		justify-content: center;
	}
	[data-shape='compact'] .workspace-tile__icon {
		width: clamp(28px, 44cqmin, 48px);
		aspect-ratio: 1;
		border-radius: 13px;
		background: color-mix(in srgb, var(--ui-primary) 76%, #243449);
		color: #fff;
	}
	[data-shape='compact'] .workspace-tile__icon > svg {
		width: 55%;
		height: 55%;
	}
	@container (max-height: 70px) {
		.workspace-desktop-tile:not([data-shape='compact']) :deep(.ui-action-card__content) {
			gap: 3px;
		}
		.workspace-tile__metric {
			flex-direction: row;
			gap: 4px;
		}
		.workspace-tile__metric > strong {
			font-size: 15px;
		}
		.workspace-tile__metric-label {
			font-size: 9px;
		}
	}
	@container (max-height: 48px) or (max-width: 65px) {
		.workspace-tile__metrics {
			display: none;
		}
		.workspace-desktop-tile :deep(.ui-action-card__content) {
			justify-content: center;
		}
		.workspace-tile__heading {
			justify-content: center;
		}
		[data-shape='compact'] .workspace-tile__heading {
			flex-direction: row;
			gap: 4px;
		}
		[data-shape='compact'] .workspace-tile__icon {
			width: 24px;
			border-radius: 7px;
		}
	}
</style>
