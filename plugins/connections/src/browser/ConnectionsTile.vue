<script setup lang="ts">
	import { computed, onMounted, watchEffect, type Ref } from 'vue';
	import { Server } from '@lucide/vue';
	import { UiActionCard } from 'nexus-terminal/browser/ui';
	import type { PluginApplicationTileProps } from 'nexus-terminal/browser';
	import type { ConnectionsClient } from './connections-client-api.js';
	import { useI18n } from 'vue-i18n';
	import { messages } from './messages.js';
	import { ConnectionTypeSchema, type ConnectionType } from '../shared/connection-types';

	const props = defineProps<PluginApplicationTileProps & { runtime: ConnectionsClient; label: Ref<string> }>();
	const { t, n } = useI18n({ useScope: 'local', messages });
	watchEffect(() => (props.label.value = t('title')));
	const { catalog, loaded } = props.runtime;
	const savedCount = computed(() => (loaded.value ? n(catalog.value.connections.length) : '—'));

	const shape = computed(() =>
		props.size.columns === 1 && props.size.rows === 1
			? 'compact'
			: props.size.rows === 1
				? 'wide'
				: props.size.columns === 1
					? 'tall'
					: 'square',
	);

	const groups = computed(() => {
		const counts = new Map<ConnectionType, number>();
		for (const connection of catalog.value.connections)
			counts.set(connection.type, (counts.get(connection.type) ?? 0) + 1);
		return ConnectionTypeSchema.options.map((type) => ({ type, count: counts.get(type) ?? 0 }));
	});

	const segments = computed(() => {
		const total = catalog.value.connections.length;
		if (!loaded.value || total === 0) {
			return groups.value.map((group) => ({ type: group.type, flex: 1, empty: true }));
		}
		return groups.value
			.filter((group) => group.count > 0)
			.map((group) => ({ type: group.type, flex: group.count, empty: false }));
	});

	onMounted(() => {
		if (!loaded.value)
			void props.runtime
				.refresh(props.view.signal)
				.catch((cause) => props.runtime.report(cause, props.view.signal));
	});
</script>

<template>
	<UiActionCard class="connections-tile" :data-shape="shape" :label="t('title')" :title="t('title')" @click="open">
		<span class="connections-tile__header">
			<Server v-if="shape !== 'compact'" :size="13" aria-hidden="true" />
			<span>{{ t('title') }}</span>
		</span>

		<span class="connections-tile__total">
			<strong :style="{ '--count-characters': savedCount.length }">{{ savedCount }}</strong>
			<span>{{ t('tile.saved') }}</span>
		</span>

		<span class="connections-tile__summary">
			<span v-if="shape !== 'compact'" class="connections-tile__groups">
				<span
					v-for="group in groups"
					:key="group.type"
					class="connections-tile__group"
					:data-type="group.type"
					:data-empty="(loaded && group.count === 0) || undefined"
				>
					<span class="connections-tile__group-label">
						<span class="connections-tile__proto-dot" :data-proto="group.type" aria-hidden="true" />
						<span>{{ t(`types.${group.type}`) }}</span>
					</span>
					<strong :style="{ '--count-characters': loaded ? n(group.count).length : 1 }">{{
						loaded ? n(group.count) : '—'
					}}</strong>
				</span>
			</span>
			<span class="connections-tile__bar" aria-hidden="true">
				<span
					v-for="seg in segments"
					:key="seg.type"
					class="connections-tile__bar-seg"
					:data-proto="seg.type"
					:data-empty="seg.empty || undefined"
					:style="{ flexGrow: seg.flex }"
				/>
			</span>
		</span>
	</UiActionCard>
</template>

<style scoped>
	.connections-tile {
		--_ink: var(--ui-connections-tile-text, var(--ui-text));
		--_muted: var(--ui-connections-tile-muted, var(--ui-muted));
		--_accent: var(--ui-connections-tile-accent, var(--ui-primary));
		--_proto-ssh: var(--ui-primary, #7752b4);
		--_proto-rdp: var(--ui-success, #326b58);
		--_proto-vnc: var(--ui-app-cyan, #167b92);
		--ui-action-card-padding: 0;
		--ui-action-card-background: var(
			--ui-connections-tile-background,
			color-mix(in srgb, var(--_accent) 9%, var(--ui-surface))
		);
		--ui-action-card-text: var(--_ink);
	}
	.connections-tile :deep(.ui-action-card__content) {
		display: grid;
		grid-template-rows: auto 1fr auto;
		width: 100%;
		height: 100%;
		padding: clamp(11px, 7cqmin, 16px) clamp(12px, 8cqmin, 18px);
		gap: 8px;
	}
	.connections-tile__header {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		flex: none;
		color: var(--_muted);
		font-size: clamp(11px, 6.5cqi, 13px);
		font-weight: 560;
		line-height: 1.25;
	}
	.connections-tile__header > svg {
		flex: none;
		color: var(--_accent);
		opacity: 0.85;
	}
	.connections-tile__header > span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	[data-proto='ssh'] {
		background: var(--_proto-ssh);
	}
	[data-proto='rdp'] {
		background: var(--_proto-rdp);
	}
	[data-proto='vnc'] {
		background: var(--_proto-vnc);
	}
	.connections-tile__summary {
		display: grid;
		gap: 10px;
		min-width: 0;
	}
	.connections-tile__total {
		display: flex;
		align-items: baseline;
		align-self: end;
		gap: 6px;
		min-width: 0;
		white-space: nowrap;
	}
	.connections-tile__total strong {
		color: var(--_ink);
		font-size: clamp(24px, 26cqmin, 38px);
		font-weight: 650;
		letter-spacing: -0.04em;
		line-height: 1;
		font-variant-numeric: tabular-nums;
	}
	.connections-tile__total > span {
		color: var(--_muted);
		font-size: 11.5px;
		line-height: 1.25;
	}

	/* 三段按比例分段圆条 */
	.connections-tile__bar {
		display: flex;
		gap: 3px;
		width: 100%;
		height: 6px;
		border-radius: 999px;
		overflow: hidden;
		background: color-mix(in srgb, var(--_accent) 8%, transparent);
	}
	.connections-tile__bar-seg {
		min-width: 8px;
		height: 100%;
		border-radius: 999px;
		opacity: 0.86;
		transition: flex-grow 260ms ease;
	}
	.connections-tile__bar-seg[data-empty] {
		opacity: 0.2;
	}

	/* 图例：默认（2×2 及以上）为三列，标签在上、数量在下 */
	.connections-tile__groups {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 8px;
		min-width: 0;
	}
	.connections-tile__group {
		container-type: inline-size;
		display: flex;
		flex-direction: column;
		gap: 3px;
		min-width: 0;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		transition: opacity var(--ui-motion-duration, 150ms) ease;
	}
	.connections-tile__group[data-empty] {
		opacity: 0.72;
	}
	.connections-tile__group-label {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		min-width: 0;
		color: var(--_muted);
		font-size: 10.5px;
		font-weight: 560;
		letter-spacing: 0.02em;
		line-height: 1.2;
	}
	.connections-tile__group-label > span:last-child {
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.connections-tile__proto-dot {
		width: 6px;
		height: 6px;
		border-radius: 999px;
		flex: none;
	}
	.connections-tile__group > strong {
		padding-inline-start: 11px;
		color: var(--_ink);
		font-size: 15px;
		font-weight: 620;
		line-height: 1;
	}

	/* 1×1 Compact：只保留总数与分段条 */
	.connections-tile[data-shape='compact'] :deep(.ui-action-card__content) {
		padding: 9px clamp(6px, 8cqi, 12px);
		gap: 5px;
	}
	.connections-tile[data-shape='compact'] .connections-tile__header {
		font-size: clamp(10px, 15cqi, 12px);
		color: var(--_ink);
	}
	.connections-tile[data-shape='compact'] .connections-tile__total {
		flex-wrap: wrap;
		gap: 1px 5px;
	}
	.connections-tile[data-shape='compact'] .connections-tile__total strong {
		font-size: clamp(12px, min(30cqi, calc(130cqi / max(2, var(--count-characters)))), 26px);
	}
	.connections-tile[data-shape='compact'] .connections-tile__total > span {
		font-size: 10px;
	}
	.connections-tile[data-shape='compact'] .connections-tile__bar {
		height: 4px;
	}

	/* 单行多列磁贴的总数与标题同行，协议在下方分列。 */
	.connections-tile[data-shape='wide'] :deep(.ui-action-card__content) {
		grid-template-columns: minmax(0, 1fr) auto;
		grid-template-rows: auto 1fr;
		align-items: center;
		padding: 9px clamp(7px, 6cqi, 14px);
		gap: 5px 8px;
	}
	.connections-tile[data-shape='wide'] .connections-tile__total {
		align-self: center;
		gap: 4px;
	}
	.connections-tile[data-shape='wide'] .connections-tile__summary {
		grid-column: 1 / -1;
		align-self: end;
		gap: 5px;
	}
	.connections-tile[data-shape='wide'] .connections-tile__total strong {
		font-size: clamp(17px, 22cqmin, 24px);
	}
	.connections-tile[data-shape='wide'] .connections-tile__total > span {
		font-size: 10px;
	}
	.connections-tile[data-shape='wide'] .connections-tile__bar {
		height: 4px;
	}
	.connections-tile[data-shape='wide'] .connections-tile__groups {
		gap: 4px;
	}
	.connections-tile[data-shape='wide'] .connections-tile__group {
		flex-direction: row;
		align-items: center;
		justify-content: center;
		gap: 4px;
	}
	.connections-tile[data-shape='wide'] .connections-tile__group-label {
		gap: 3px;
	}
	.connections-tile[data-shape='wide'] .connections-tile__group > strong {
		padding: 0;
		font-size: 11px;
	}

	/* 1×2 Tall：图例纵向排列，标签居左、数量居右 */
	.connections-tile[data-shape='tall'] :deep(.ui-action-card__content) {
		padding: 12px 11px;
	}
	.connections-tile[data-shape='tall'] .connections-tile__header > svg {
		display: none;
	}
	.connections-tile[data-shape='tall'] .connections-tile__total {
		flex-direction: column;
		gap: 2px;
	}
	.connections-tile[data-shape='tall'] .connections-tile__total strong {
		font-size: clamp(12px, min(30cqi, calc(120cqi / max(2, var(--count-characters)))), 30px);
	}
	.connections-tile[data-shape='tall'] .connections-tile__groups {
		grid-template-columns: minmax(0, 1fr);
		gap: 6px;
	}
	.connections-tile[data-shape='tall'] .connections-tile__group {
		flex-direction: row;
		align-items: center;
		justify-content: space-between;
	}
	.connections-tile[data-shape='tall'] .connections-tile__group > strong {
		padding: 0;
		font-size: 12.5px;
	}

	@container (max-width: 230px) {
		.connections-tile[data-shape='wide'] .connections-tile__group {
			flex-direction: column;
			gap: 2px;
		}
	}
	@container (max-width: 138px) {
		.connections-tile[data-shape='wide'] :deep(.ui-action-card__content) {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: auto auto 1fr;
			align-items: start;
			padding-block: 7px;
			gap: 3px;
		}
		.connections-tile[data-shape='wide'] .connections-tile__proto-dot,
		.connections-tile[data-shape='square'] .connections-tile__proto-dot,
		.connections-tile[data-shape='wide'] .connections-tile__header > svg {
			display: none;
		}
		.connections-tile[data-shape='wide'] .connections-tile__group > strong {
			font-size: clamp(8px, calc(145cqi / max(2, var(--count-characters))), 11px);
		}
		.connections-tile[data-shape='square'] .connections-tile__total {
			flex-wrap: wrap;
		}
		.connections-tile[data-shape='square'] .connections-tile__total strong {
			font-size: clamp(12px, calc(120cqi / max(2, var(--count-characters))), 27px);
		}
		.connections-tile[data-shape='square'] .connections-tile__groups {
			grid-template-columns: minmax(0, 1fr);
			gap: 6px;
		}
		.connections-tile[data-shape='square'] .connections-tile__group {
			flex-direction: row;
			align-items: center;
			justify-content: space-between;
		}
		.connections-tile[data-shape='square'] .connections-tile__group > strong {
			padding: 0;
			font-size: 12px;
		}
	}
	@container (max-width: 76px) {
		.connections-tile[data-shape='compact'] .connections-tile__total {
			flex-direction: column-reverse;
			align-items: flex-start;
			gap: 2px;
		}
		.connections-tile[data-shape='tall'] .connections-tile__group {
			flex-direction: column;
			align-items: flex-start;
		}
		.connections-tile[data-shape='tall'] .connections-tile__proto-dot {
			display: none;
		}
	}
</style>
