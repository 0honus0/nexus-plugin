<script setup lang="ts">
	import { computed } from 'vue';
	import {
		File,
		Folder,
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
		CornerUpLeft,
	} from '@lucide/vue';
	import type { FileEntry } from '../../shared/workspace-file-types';
	import { fileIconKind } from './file-icon-kind';
	const props = defineProps<{ name: string; kind: FileEntry['kind'] }>();
	const icons = {
		file: File,
		folder: Folder,
		parent: CornerUpLeft,
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
		><component :is="icons[type]" :size="16"
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
		color: var(--ui-muted);
	}
	.workspace-file-icon[data-file-icon='folder'] {
		color: color-mix(in srgb, var(--ui-primary) 58%, var(--ui-muted));
	}
	.workspace-file-icon[data-file-icon='link'] {
		color: var(--ui-warning, var(--ui-muted));
	}
	.is-selected .workspace-file-icon {
		color: var(--ui-primary);
	}
</style>
