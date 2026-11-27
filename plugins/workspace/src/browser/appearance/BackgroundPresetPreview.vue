<script setup lang="ts">
	import { computed, ref } from 'vue';
	import { useIntersectionObserver } from '@vueuse/core';
	import type { BackgroundSettings } from '../../shared/workspace-background-types';
	import TerminalBackgroundLayer from './TerminalBackgroundLayer.vue';

	const props = defineProps<{
		settings: BackgroundSettings;
		imageUrl?: string;
		html: string;
		animated: boolean;
		active: boolean;
		selected: boolean;
	}>();

	const stage = ref<HTMLElement>();
	const inView = ref(false);
	const hovered = ref(false);

	useIntersectionObserver(
		stage,
		([entry]) => {
			inView.value = !!entry?.isIntersecting;
		},
		{ rootMargin: '80px' },
	);

	const previewSettings = computed<BackgroundSettings>(() => ({
		...props.settings,
		enabled: true,
		overlay: Math.min(props.settings.overlay, 0.45),
	}));

	const running = computed(() => props.animated && (props.selected || hovered.value));
</script>

<template>
	<div
		ref="stage"
		class="workspace-background-preset-stage"
		@pointerenter="hovered = true"
		@pointerleave="hovered = false"
	>
		<TerminalBackgroundLayer
			v-if="active && inView"
			:settings="previewSettings"
			:image-url="imageUrl"
			:html="html"
			:animated="running"
			:active="active && inView"
		/>
		<span class="workspace-background-preset-sample" aria-hidden="true">nexus ~ $</span>
	</div>
</template>
