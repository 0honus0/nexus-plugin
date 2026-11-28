<script setup lang="ts">
	import 'monaco-editor/editor/browser/coreCommands';
	import 'monaco-editor/features/codicon/register';
	import 'monaco-editor/features/bracketMatching/register';
	import 'monaco-editor/features/comment/register';
	import 'monaco-editor/features/contextmenu/register';
	import 'monaco-editor/features/find/register';
	import 'monaco-editor/features/folding/register';
	import 'monaco-editor/features/indentation/register';
	import 'monaco-editor/features/stickyScroll/register';
	import 'monaco-editor/features/tokenization/register';
	import 'monaco-editor/languages/definitions/css/register';
	import 'monaco-editor/languages/definitions/html/register';
	import 'monaco-editor/languages/definitions/javascript/register';
	import 'monaco-editor/languages/definitions/markdown/register';
	import 'monaco-editor/languages/definitions/python/register';
	import 'monaco-editor/languages/definitions/typescript/register';
	// The JSON worker factory loads editor contributions that must register before the first editor.
	import 'monaco-editor/internal/common/workers';
	import 'monaco-editor/language/json/monaco.contribution';
	import { editor, type Environment } from 'monaco-editor/editor/editor.api';
	import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
	import JsonWorker from 'monaco-editor/language/json/json.worker?worker';
	import { onMounted, onScopeDispose, useTemplateRef, watch } from 'vue';

	const props = defineProps<{
		modelValue: string;
		language: string;
		label: string;
		fontSize: number;
		readOnly?: boolean;
	}>();
	const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
	const host = useTemplateRef('host');
	let instance: editor.IStandaloneCodeEditor | undefined;
	let model: editor.ITextModel | undefined;

	const environment = globalThis as typeof globalThis & { MonacoEnvironment?: Environment };

	onMounted(() => {
		environment.MonacoEnvironment = {
			...environment.MonacoEnvironment,

			getWorker: (_, label) => (label === 'json' ? new JsonWorker() : new EditorWorker()),
		};
		model = editor.createModel(props.modelValue, props.language === 'text' ? 'plaintext' : props.language);
		instance = editor.create(host.value!, {
			model,
			ariaLabel: props.label,
			automaticLayout: true,
			theme: 'vs-dark',
			fontSize: props.fontSize,
			readOnly: props.readOnly,
			wordWrap: 'on',
			wrappingIndent: 'same',
			lineNumbersMinChars: 3,
			showFoldingControls: 'always',
			guides: { bracketPairs: 'active', highlightActiveIndentation: true },
			stickyScroll: { enabled: true },
			scrollBeyondLastLine: false,
		});
		instance.onDidChangeModelContent(() => {
			const value = model?.getValue();
			if (value !== undefined && value !== props.modelValue) emit('update:modelValue', value);
		});
	});

	watch(
		() => props.modelValue,
		(value) => {
			if (model && model.getValue() !== value) model.setValue(value);
		},
	);
	watch(
		() => [props.readOnly, props.label, props.fontSize] as const,
		([readOnly, ariaLabel, fontSize]) => instance?.updateOptions({ readOnly, ariaLabel, fontSize }),
	);

	function openSearch(): void {
		instance?.focus();
		void instance?.getAction('actions.find')?.run();
	}

	defineExpose({ openSearch });

	onScopeDispose(() => {
		instance?.dispose();
		model?.dispose();
	});
</script>

<template><div ref="host" class="file-code-editor" data-ui-selection="text" /></template>

<style scoped>
	.file-code-editor {
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}
</style>
