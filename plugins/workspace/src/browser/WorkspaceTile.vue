<script setup lang="ts">
	import { computed, onScopeDispose, shallowRef, watch } from 'vue';
	import { SquareTerminal, Terminal } from '@lucide/vue';
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
		shape.value === 'large' || shape.value === 'tall'
			? (['suspended', 'transfers'] as const)
			: (['suspended'] as const),
	);
	const wideExtraMetrics = ['suspended', 'transfers'] as const;

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
		<Terminal v-if="shape !== 'compact'" class="workspace-tile__art" :stroke-width="1.1" aria-hidden="true" />

		<span class="workspace-tile__heading">
			<span v-if="shape === 'compact'" class="workspace-tile__icon">
				<SquareTerminal :size="20" aria-hidden="true" />
			</span>
			<strong>{{ i18n.title.value }}</strong>
		</span>

		<span v-if="shape !== 'compact'" class="workspace-tile__body">
			<span class="workspace-tile__hero">
				<strong>{{ counts ? i18n.n(counts.attached) : '—' }}</strong>
				<span class="workspace-tile__hero-label">
					<span
						class="workspace-tile__dot"
						:data-live="(counts?.attached ?? 0) > 0 || undefined"
						data-metric="attached"
						aria-hidden="true"
					/>
					<span>{{ i18n.t('tile.attached') }}</span>
				</span>
			</span>

			<span v-if="shape === 'wide'" class="workspace-tile__pills">
				<span
					v-for="metric in wideExtraMetrics"
					:key="metric"
					class="workspace-tile__pill"
					:data-metric="metric"
				>
					<span class="workspace-tile__dot" aria-hidden="true" />
					<span class="workspace-tile__pill-name">{{ i18n.t('tile.' + metric) }}</span>
					<strong>{{ counts ? i18n.n(counts[metric]) : '—' }}</strong>
				</span>
			</span>

			<span v-else class="workspace-tile__metrics">
				<span v-for="metric in metrics" :key="metric" class="workspace-tile__metric" :data-metric="metric">
					<span class="workspace-tile__metric-label">
						<span class="workspace-tile__dot" aria-hidden="true" />
						<span>{{ i18n.t('tile.' + metric) }}</span>
					</span>
					<strong>{{ counts ? i18n.n(counts[metric]) : '—' }}</strong>
				</span>
			</span>
		</span>
	</UiActionCard>
</template>

<style scoped>
	.workspace-desktop-tile {
		--_accent: var(--ui-app-cyan, #167b92);
		--_ink: var(--ui-text);
		--_muted: var(--ui-muted);
		--ui-action-card-padding: 0;
		--ui-action-card-background: color-mix(in srgb, var(--_accent) 13%, var(--ui-surface));
		--ui-action-card-text: var(--_ink);
	}
	.workspace-desktop-tile :deep(.ui-action-card__content) {
		position: relative;
		display: flex;
		flex-direction: column;
		justify-content: space-between;
		width: 100%;
		height: 100%;
		padding: clamp(11px, 7cqmin, 16px) clamp(12px, 8cqmin, 18px);
		gap: 8px;
		overflow: hidden;
	}
	.workspace-tile__art {
		position: absolute;
		top: -6%;
		right: -6%;
		width: 48%;
		height: 76%;
		color: color-mix(in srgb, var(--_accent) 26%, transparent);
		pointer-events: none;
	}
	.workspace-tile__heading {
		position: relative;
		z-index: 1;
		display: flex;
		align-items: center;
		flex: none;
		min-width: 0;
		gap: 6px;
		font-size: clamp(12px, 7cqi, 14px);
		line-height: 1.25;
		color: color-mix(in srgb, var(--_accent) 72%, var(--_ink));
	}
	.workspace-tile__heading strong {
		font-weight: 600;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.workspace-tile__body {
		position: relative;
		z-index: 1;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		gap: 8px;
		flex: 1;
		min-height: 0;
		min-width: 0;
	}
	.workspace-tile__hero {
		display: flex;
		align-items: baseline;
		gap: 7px;
		min-width: 0;
		white-space: nowrap;
	}
	.workspace-tile__hero > strong {
		color: var(--_ink);
		font-size: clamp(24px, 28cqmin, 36px);
		font-weight: 600;
		letter-spacing: -0.04em;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}
	.workspace-tile__hero-label {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-size: 11.5px;
		color: var(--_muted);
	}
	.workspace-tile__pills {
		display: flex;
		align-items: center;
		flex-wrap: nowrap;
		gap: 6px;
		min-width: 0;
		overflow: hidden;
	}
	.workspace-tile__pill {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 3px 8px;
		border-radius: 999px;
		background: color-mix(in srgb, var(--ui-surface) 68%, transparent);
		font-size: 10.5px;
		color: var(--_muted);
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		flex-shrink: 0;
	}
	.workspace-tile__pill > strong {
		color: var(--_ink);
		font-size: 11px;
		font-weight: 600;
	}
	.workspace-tile__pill[data-metric='transfers'] {
		display: none;
	}

	/* 2×2+ Large */
	.workspace-tile__metrics {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 7px;
		min-width: 0;
	}
	.workspace-tile__metric {
		display: flex;
		flex-direction: column;
		justify-content: center;
		gap: 5px;
		min-width: 0;
		padding: 9px 10px;
		border-radius: 12px;
		background: color-mix(in srgb, var(--ui-surface) 64%, transparent);
	}
	.workspace-tile__metric > strong {
		color: var(--_ink);
		font-size: clamp(18px, 14cqmin, 24px);
		line-height: 1;
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}
	.workspace-tile__metric-label {
		display: flex;
		align-items: center;
		gap: 5px;
		max-width: 100%;
		font-size: 11px;
		line-height: 1.2;
		color: var(--_muted);
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
		background: var(--_muted);
		opacity: 0.7;
	}
	.workspace-tile__dot[data-metric='attached'],
	[data-metric='attached'] .workspace-tile__dot {
		background: var(--ui-success);
		opacity: 0.9;
	}
	.workspace-tile__dot[data-live] {
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--ui-success) 22%, transparent);
	}
	[data-metric='suspended'] .workspace-tile__dot {
		background: var(--ui-warning);
		opacity: 0.9;
	}
	[data-metric='transfers'] .workspace-tile__dot {
		background: var(--_accent);
		opacity: 0.9;
	}

	/* 2×1 / 3×1 Wide */
	.workspace-desktop-tile[data-shape='wide'] .workspace-tile__body {
		flex-direction: row;
		align-items: flex-end;
		justify-content: space-between;
		gap: 8px;
	}
	.workspace-desktop-tile[data-shape='wide'] .workspace-tile__hero {
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
	}
	.workspace-desktop-tile[data-shape='wide'] .workspace-tile__hero > strong {
		font-size: clamp(22px, 26cqmin, 30px);
	}
	.workspace-desktop-tile[data-shape='wide'] .workspace-tile__hero-label {
		font-size: 10.5px;
	}

	/* 1×2 Tall */
	.workspace-desktop-tile[data-shape='tall'] .workspace-tile__art {
		top: 10%;
		right: -22%;
		width: 88%;
		height: 36%;
	}
	.workspace-desktop-tile[data-shape='tall'] .workspace-tile__hero {
		flex-direction: column;
		align-items: flex-start;
		gap: 3px;
	}
	.workspace-desktop-tile[data-shape='tall'] .workspace-tile__metrics {
		grid-template-columns: minmax(0, 1fr);
		gap: 0;
	}
	.workspace-desktop-tile[data-shape='tall'] .workspace-tile__metric {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
		padding: 6px 0;
		border-radius: 0;
		background: transparent;
	}
	.workspace-desktop-tile[data-shape='tall'] .workspace-tile__metric + .workspace-tile__metric {
		border-top: 1px solid color-mix(in srgb, var(--_accent) 18%, transparent);
	}
	.workspace-desktop-tile[data-shape='tall'] .workspace-tile__metric > strong {
		font-size: 13px;
	}

	/* 1×1 Compact */
	.workspace-desktop-tile[data-shape='compact'] :deep(.ui-action-card__content) {
		justify-content: center;
		align-items: center;
		padding: 10px;
	}
	.workspace-desktop-tile[data-shape='compact'] .workspace-tile__heading {
		flex-direction: column;
		gap: 7px;
		justify-content: center;
		color: var(--_ink);
		font-size: 11px;
	}
	.workspace-tile__icon {
		flex: none;
		display: grid;
		place-items: center;
		width: clamp(32px, 44cqmin, 46px);
		aspect-ratio: 1;
		border-radius: 13px;
		background: color-mix(in srgb, var(--_accent) 84%, #133946);
		color: #fff;
	}
	.workspace-tile__icon > svg {
		width: 54%;
		height: 54%;
	}

	/* 3×1 / 4×1 宽卡展示更多指标且更舒展 */
	@container (min-width: 260px) {
		.workspace-desktop-tile[data-shape='wide'] .workspace-tile__art {
			width: 34%;
			right: -2%;
		}
		.workspace-desktop-tile[data-shape='wide'] .workspace-tile__hero {
			flex-direction: row;
			align-items: baseline;
			gap: 7px;
		}
		.workspace-desktop-tile[data-shape='wide'] .workspace-tile__pill[data-metric='transfers'] {
			display: inline-flex;
		}
		.workspace-desktop-tile[data-shape='wide'] .workspace-tile__pill {
			padding: 4px 10px;
			font-size: 11px;
		}
	}
	@container (max-width: 150px) {
		.workspace-desktop-tile[data-shape='wide'] .workspace-tile__pills {
			display: none;
		}
	}
	@container (max-height: 48px) or (max-width: 65px) {
		.workspace-tile__body,
		.workspace-tile__art {
			display: none;
		}
		.workspace-desktop-tile :deep(.ui-action-card__content) {
			justify-content: center;
		}
		.workspace-tile__heading {
			justify-content: center;
		}
		.workspace-desktop-tile[data-shape='compact'] .workspace-tile__heading {
			flex-direction: row;
			gap: 4px;
		}
		.workspace-tile__icon {
			width: 24px;
			border-radius: 7px;
		}
	}
</style>
