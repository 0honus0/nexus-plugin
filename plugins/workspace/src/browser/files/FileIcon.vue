<script setup lang="ts">
	import { computed } from 'vue';
	import {
		File,
		Folder,
		FolderOpen,
		Link,
		FileImage,
		FileVideo,
		FileAudio,
		FileText,
		FileSpreadsheet,
		Presentation,
		FileArchive,
		FileCode,
		Settings,
		BookOpen,
		Database,
		KeyRound,
		Terminal,
		FileType,
		Shield,
		GitBranch,
		Package,
		Container,
		Scale,
		Disc3,
	} from '@lucide/vue';
	import type { FileEntry } from '../../shared/workspace-file-types';
	import { fileIconKind } from './file-icon-kind';
	const props = defineProps<{ name: string; kind: FileEntry['kind'] }>();
	const icons = {
		file: File,
		folder: Folder,
		parent: FolderOpen,
		link: Link,
		image: FileImage,
		video: FileVideo,
		audio: FileAudio,
		document: FileText,
		spreadsheet: FileSpreadsheet,
		presentation: Presentation,
		archive: FileArchive,
		disk: Disc3,
		code: FileCode,
		config: Settings,
		book: BookOpen,
		database: Database,
		key: KeyRound,
		terminal: Terminal,
		font: FileType,
		git: GitBranch,
		package: Package,
		container: Container,
		shield: Shield,
		license: Scale,
	};
	const type = computed(() => fileIconKind(props.name, props.kind));
</script>
<template>
	<span class="workspace-file-icon" :data-file-icon="type" aria-hidden="true"
		><component :is="icons[type]" :size="15" :stroke-width="1.8"
	/></span>
</template>
<style scoped>
	.workspace-file-icon {
		display: inline-flex;
		width: 18px;
		height: 18px;
		flex: none;
		align-items: center;
		justify-content: center;
		line-height: 1;
		color: var(--ui-muted);
	}
	.workspace-file-icon > svg {
		display: block;
		flex: none;
	}
	.workspace-file-icon:is([data-file-icon='folder'], [data-file-icon='parent']) {
		color: color-mix(in srgb, var(--ui-primary) 78%, var(--ui-text));
	}
	.workspace-file-icon:is([data-file-icon='folder'], [data-file-icon='parent']) > svg {
		fill: color-mix(in srgb, var(--ui-primary) 16%, transparent);
	}
	.workspace-file-icon[data-file-icon='code'],
	.workspace-file-icon[data-file-icon='git'] {
		color: var(--ui-app-indigo, var(--ui-primary));
	}
	.workspace-file-icon[data-file-icon='terminal'],
	.workspace-file-icon[data-file-icon='spreadsheet'] {
		color: var(--ui-success, #22a06b);
	}
	.workspace-file-icon[data-file-icon='image'],
	.workspace-file-icon[data-file-icon='video'],
	.workspace-file-icon[data-file-icon='audio'] {
		color: var(--ui-app-violet, #7c5cff);
	}
	.workspace-file-icon[data-file-icon='archive'],
	.workspace-file-icon[data-file-icon='disk'],
	.workspace-file-icon[data-file-icon='link'] {
		color: var(--ui-app-amber, var(--ui-warning, #e08416));
	}
	.workspace-file-icon[data-file-icon='key'],
	.workspace-file-icon[data-file-icon='shield'] {
		color: var(--ui-app-rose, #d94c7a);
	}
	.workspace-file-icon[data-file-icon='config'],
	.workspace-file-icon[data-file-icon='database'],
	.workspace-file-icon[data-file-icon='container'],
	.workspace-file-icon[data-file-icon='package'] {
		color: var(--ui-app-cyan, #1a88a8);
	}
	.is-selected .workspace-file-icon {
		color: var(--ui-primary);
	}
</style>
