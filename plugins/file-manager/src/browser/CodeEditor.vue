<script setup lang="ts">
	import { basicSetup, EditorView } from 'codemirror';
	import { indentWithTab } from '@codemirror/commands';
	import { keymap } from '@codemirror/view';
	import { css } from '@codemirror/lang-css';
	import { html } from '@codemirror/lang-html';
	import { javascript } from '@codemirror/lang-javascript';
	import { json } from '@codemirror/lang-json';
	import { markdown } from '@codemirror/lang-markdown';
	import { python } from '@codemirror/lang-python';
	import { onMounted, onScopeDispose, useTemplateRef } from 'vue';

	const props = defineProps<{ modelValue: string; language: string; label: string }>();
	const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
	const host = useTemplateRef('host');
	let editor: EditorView | undefined;

	const languages = {
		css,
		html,
		javascript,
		json,
		markdown,
		python,

		typescript: () => javascript({ typescript: true }),
	};
	const theme = EditorView.theme({
		'&': { height: '100%', color: 'var(--ui-text)', backgroundColor: 'var(--ui-surface)' },
		'.cm-scroller': {
			fontFamily: 'var(--ui-font-mono, ui-monospace, monospace)',
			fontSize: '13px',
			lineHeight: '1.65',
		},
		'.cm-content': { paddingBlock: '12px', caretColor: 'var(--ui-text)' },
		'.cm-line': { paddingInline: '10px' },
		'.cm-gutters': { border: '0', backgroundColor: 'var(--ui-surface)', color: 'var(--ui-muted)' },
		'.cm-activeLine, .cm-activeLineGutter': {
			backgroundColor: 'color-mix(in srgb, var(--ui-primary) 9%, transparent)',
		},
		'.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--ui-text)' },
		'&.cm-focused': { outline: 'none' },
	});

	onMounted(() => {
		const language = languages[props.language as keyof typeof languages];
		editor = new EditorView({
			doc: props.modelValue,
			parent: host.value!,
			extensions: [
				basicSetup,
				theme,
				EditorView.contentAttributes.of({ 'aria-label': props.label, spellcheck: 'false' }),
				keymap.of([indentWithTab]),
				...(language ? [language()] : []),
				EditorView.updateListener.of((update) => {
					if (update.docChanged) emit('update:modelValue', update.state.doc.toString());
				}),
			],
		});
	});

	onScopeDispose(() => editor?.destroy());
</script>

<template><div ref="host" class="file-code-editor" data-ui-selection="text" /></template>

<style scoped>
	.file-code-editor {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
</style>
