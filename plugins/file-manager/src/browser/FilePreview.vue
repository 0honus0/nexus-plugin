<script setup lang="ts">
	import { computed, defineAsyncComponent, onScopeDispose, ref, watch } from 'vue';
	import { useEventListener } from '@vueuse/core';
	import { useI18n } from 'vue-i18n';
	import {
		ArrowDownToLine,
		ChevronLeft,
		ChevronRight,
		Columns2,
		Ellipsis,
		Eye,
		Maximize,
		Minus,
		Pencil,
		Plus,
		RotateCw,
		Save,
		Search,
		ZoomIn,
	} from '@lucide/vue';
	import { UiButton, UiDialog, UiDropdownMenu, UiSelect } from 'nexus-terminal/browser/ui';
	import { sha256 } from '@noble/hashes/sha2.js';
	import { bytesToHex } from '@noble/hashes/utils.js';
	import Papa from 'papaparse';
	import { isDirty, type PreviewDocument } from './preview-document.js';
	import { renderMarkdown } from './preview-markdown.js';
	import { language, messages } from './messages.js';
	import {
		decodeText,
		encodeText,
		textEncodings,
		UnrepresentableTextError,
		type EncodingChoice,
	} from './text-encoding.js';

	import { usePinchZoom } from '../../../../shared/browser/use-pinch-zoom.mjs';

	const CodeEditor = defineAsyncComponent(() => import('./CodeEditor.vue'));
	const props = defineProps<{ tab: PreviewDocument; signal: AbortSignal }>();
	const { locale } = useI18n({ useScope: 'global' });
	const copy = computed(() => messages[language(locale.value)]);
	const state = ref<'loading' | 'tooLarge' | 'invalidText' | 'failed' | 'ready'>(
		props.tab.text ? 'ready' : 'loading',
	);
	const objectUrl = ref('');
	const imageSize = ref<{ width: number; height: number }>();
	const zoom = ref<number | 'fit'>(props.tab.format.kind === 'image' ? 'fit' : 100);
	const zoomFrame = ref<HTMLElement>();
	const percent = computed(() => (typeof zoom.value === 'number' ? zoom.value : 100));
	const editorFontSize = computed(() => (14 * percent.value) / 100);
	const zoomable = computed(
		() => state.value === 'ready' && (props.tab.format.kind === 'image' ? !!imageSize.value : !!props.tab.text),
	);
	const zoomLimits = props.tab.format.kind === 'image' ? { min: 5, max: 400 } : { min: 50, max: 250 };
	const saveStatus = ref<
		| 'saved'
		| 'saveFailed'
		| 'downloadFailed'
		| 'conflict'
		| 'tooLarge'
		| 'atomicSaveUnavailable'
		| 'unrepresentable'
	>();
	const reloadPrompt = ref(false);
	const pendingEncoding = ref<EncodingChoice>();
	const page = ref(0);
	const pageSize = 100;
	const columnPage = ref(0);
	const columnPageSize = 64;
	let request: AbortController | undefined;
	const lifetime = new AbortController();
	const active = AbortSignal.any([props.signal, lifetime.signal]);

	const editor = computed(() => ('language' in props.tab.format ? props.tab.format.language : undefined));
	const codeEditor = ref<{ openSearch(): void }>();
	const editorVisible = computed(() => props.tab.mode !== 'preview' || props.tab.format.kind === 'text');
	const encodingOptions = computed(() => [
		{ value: 'auto', label: copy.value.autoEncoding },
		...Object.entries(textEncodings).map(([value, label]) => ({ value, label })),
	]);
	const lineEndings = { '\r\n': 'CRLF', '\n': 'LF', '\r': 'CR' };
	const dirty = computed(() => isDirty(props.tab));
	const source = computed(() => props.tab.text?.draft ?? '');
	const markdown = computed(() => renderMarkdown(source.value));
	const table = computed(() => Papa.parse<string[]>(source.value, { skipEmptyLines: 'greedy' }).data);
	const columns = computed(() => table.value.reduce((count, row) => Math.max(count, row.length), 0));
	const columnStart = computed(() => columnPage.value * columnPageSize);
	const columnEnd = computed(() => Math.min(columnStart.value + columnPageSize, columns.value));
	const displayed = computed(() => table.value.slice(page.value * pageSize, (page.value + 1) * pageSize));
	const pages = computed(() => Math.max(1, Math.ceil(table.value.length / pageSize)));
	const imageStyle = computed(() =>
		zoom.value === 'fit' || !imageSize.value
			? undefined
			: {
					width: (imageSize.value.width * zoom.value) / 100 + 'px',
					height: (imageSize.value.height * zoom.value) / 100 + 'px',
				},
	);
	const modeOptions = computed(() =>
		props.tab.format.kind === 'markdown' ? (['preview', 'split', 'edit'] as const) : (['preview', 'edit'] as const),
	);
	const modeIcons = { preview: Eye, split: Columns2, edit: Pencil };
	const zoomLabel = computed(() => (zoom.value === 'fit' ? copy.value.fit : zoom.value + '%'));
	const zoomActions = computed(() => [
		{ id: 'zoomOut', label: copy.value.zoomOut, icon: Minus, disabled: zoom.value === zoomLimits.min },
		{ id: 'zoomIn', label: copy.value.zoomIn, icon: Plus, disabled: zoom.value === zoomLimits.max },
		{
			id: 'actualSize',
			label: imageSize.value ? copy.value.actualSize : copy.value.resetZoom,
			icon: ZoomIn,
			disabled: zoom.value === 100,
		},
		...(imageSize.value
			? [{ id: 'fit', label: copy.value.fit, icon: Maximize, disabled: zoom.value === 'fit' }]
			: []),
	]);
	const fileActions = computed(() => [
		...(editor.value && editorVisible.value && state.value === 'ready'
			? [{ id: 'find', label: copy.value.find, icon: Search, disabled: !codeEditor.value }]
			: []),
		{
			id: 'refresh',
			label: copy.value.refresh,
			icon: RotateCw,
			disabled: state.value === 'loading' || props.tab.saving,
		},
		{ id: 'download', label: copy.value.download, icon: ArrowDownToLine },
	]);

	const mobileActions = computed(() => [
		...fileActions.value,
		...(zoomable.value
			? zoomActions.value.map((action) => ({
					...action,
					label: action.id === 'actualSize' ? `${action.label} · ${zoomLabel.value}` : action.label,
					separatorBefore: action.id === 'zoomOut',
				}))
			: []),
	]);

	function runFileAction(id: string) {
		if (id === 'find') codeEditor.value?.openSearch();
		else if (id === 'refresh') reload();
		else if (id === 'download') download();
		else if (id === 'zoomIn') setZoom(currentZoom() + (imageSize.value ? 25 : 10));
		else if (id === 'zoomOut') setZoom(currentZoom() - (imageSize.value ? 25 : 10));
		else if (id === 'actualSize') setZoom(100);
		else if (id === 'fit' && imageSize.value) zoom.value = 'fit';
	}

	watch([source, () => props.tab.mode], () => {
		if (saveStatus.value === 'saved') saveStatus.value = undefined;
		if (props.tab.format.kind === 'csv' && props.tab.mode !== 'edit') {
			page.value = Math.min(page.value, pages.value - 1);
			columnPage.value = Math.min(columnPage.value, Math.max(0, Math.ceil(columns.value / columnPageSize) - 1));
		}
	});

	function releaseObject() {
		if (objectUrl.value) URL.revokeObjectURL(objectUrl.value);
		objectUrl.value = '';
	}

	async function load() {
		request?.abort();
		const controller = new AbortController();
		request = controller;
		const signal = AbortSignal.any([active, controller.signal]);
		const { file, format } = props.tab;
		state.value = 'loading';
		saveStatus.value = undefined;
		reloadPrompt.value = false;
		pendingEncoding.value = undefined;
		page.value = 0;
		columnPage.value = 0;
		releaseObject();
		imageSize.value = undefined;
		try {
			const bytes = await file.read(format.maxBytes, signal);
			if (signal.aborted) return;
			if ('mime' in format) {
				objectUrl.value = URL.createObjectURL(new Blob([bytes], { type: format.mime }));
			} else {
				let decoded;
				try {
					decoded = await decodeText(bytes, props.tab.encodingChoice);
				} catch {
					if (signal.aborted) return;
					props.tab.text = undefined;
					state.value = 'invalidText';
					return;
				}
				if (signal.aborted) return;
				const data = new Uint8Array(bytes);
				const lineEnding = decoded.text.match(/\r\n|\r|\n/u)?.[0];
				const text = decoded.text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
				props.tab.text = {
					original: text,
					draft: text,
					hash: bytesToHex(sha256(data)),
					bom: decoded.bom,
					encoding: decoded.encoding,
					lineEnding: lineEnding === '\r\n' || lineEnding === '\r' ? lineEnding : '\n',
				};
			}
			state.value = 'ready';
		} catch (cause) {
			if (signal.aborted) return;
			state.value =
				cause instanceof Error && cause.message === 'WORKSPACE_PREVIEW_TOO_LARGE' ? 'tooLarge' : 'failed';
		}
	}

	function reload() {
		pendingEncoding.value = undefined;
		if (dirty.value) reloadPrompt.value = true;
		else void load();
	}

	function chooseEncoding(value: unknown) {
		if (typeof value !== 'string' || (value !== 'auto' && !Object.hasOwn(textEncodings, value))) return;
		const choice = value as EncodingChoice;
		if (choice === props.tab.encodingChoice || props.tab.saving) return;
		if (dirty.value) {
			pendingEncoding.value = choice;
			reloadPrompt.value = true;
		} else {
			props.tab.encodingChoice = choice;
			void load();
		}
	}

	function confirmReload() {
		if (pendingEncoding.value) props.tab.encodingChoice = pendingEncoding.value;
		void load();
	}

	async function save() {
		const { tab } = props;
		const text = tab.text;
		if (!text || !dirty.value || tab.saving || active.aborted || state.value !== 'ready') return;
		const draft = text.draft;
		tab.saving = true;
		saveStatus.value = undefined;
		try {
			const encoded = await encodeText(draft.replaceAll('\n', text.lineEnding), text.encoding, text.bom);
			if (active.aborted) return;
			if (encoded.byteLength > tab.format.maxBytes) {
				saveStatus.value = 'tooLarge';
				return;
			}
			await tab.file.save(new Blob([encoded]), text.hash, active);
			text.original = draft;
			text.hash = bytesToHex(sha256(encoded));
			saveStatus.value = 'saved';
		} catch (cause) {
			if (active.aborted) return;
			if (cause instanceof UnrepresentableTextError) saveStatus.value = 'unrepresentable';
			else
				saveStatus.value =
					typeof cause === 'object' && cause !== null && 'code' in cause
						? cause.code === 'WORKSPACE_CONFLICT'
							? 'conflict'
							: cause.code === 'WORKSPACE_ATOMIC_SAVE_UNAVAILABLE'
								? 'atomicSaveUnavailable'
								: 'saveFailed'
						: 'saveFailed';
		} finally {
			tab.saving = false;
		}
	}

	function onImageLoad(event: Event) {
		const img = event.currentTarget as HTMLImageElement;
		imageSize.value = { width: img.naturalWidth, height: img.naturalHeight };
	}

	function currentZoom() {
		const size = imageSize.value;
		const frame = zoomFrame.value;
		if (typeof zoom.value === 'number' || !size || !frame) return percent.value;
		return (
			100 *
			Math.min(
				1,
				Math.max(0, frame.clientWidth - 32) / size.width,
				Math.max(0, frame.clientHeight - 32) / size.height,
			)
		);
	}

	function setZoom(value: number) {
		if (!zoomable.value) return;
		zoom.value = Math.max(zoomLimits.min, Math.min(zoomLimits.max, Math.round(value)));
	}

	useEventListener(
		zoomFrame,
		'wheel',
		(event) => {
			if (!event.ctrlKey || !zoomable.value || !event.deltaY) return;
			event.preventDefault();
			event.stopImmediatePropagation();
			const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1);
			setZoom(currentZoom() - Math.sign(pixels) * Math.min(20, Math.max(1, Math.abs(pixels) / 8)));
		},
		{ passive: false, capture: true },
	);

	let pinchBaseline = 100;
	usePinchZoom(
		zoomFrame,
		() => {
			pinchBaseline = currentZoom();
		},
		(ratio) => setZoom(pinchBaseline * ratio),
	);

	function shortcut(event: KeyboardEvent) {
		if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
			event.preventDefault();
			void save();
		}
	}

	function download() {
		void props.tab.file.download().catch(() => {
			saveStatus.value = 'downloadFailed';
		});
	}

	onScopeDispose(() => {
		lifetime.abort();
		releaseObject();
	});
	if (!props.tab.text) void load();
</script>

<template>
	<section class="file-preview" :aria-label="tab.file.name" @keydown.capture="shortcut">
		<template v-if="state === 'ready'">
			<div v-if="tab.format.kind === 'image'" ref="zoomFrame" class="file-preview__image">
				<img
					:src="objectUrl"
					:alt="tab.file.name"
					:style="imageStyle"
					:data-fit="zoom === 'fit' || undefined"
					@load="onImageLoad"
					@error="state = 'failed'"
				/>
			</div>
			<iframe
				v-else-if="tab.format.kind === 'pdf'"
				class="file-preview__pdf"
				:src="objectUrl + '#view=Fit'"
				:title="tab.file.name"
				referrerpolicy="no-referrer"
			/>
			<div
				v-else-if="tab.text && editor"
				ref="zoomFrame"
				class="file-preview__document"
				:style="{ '--preview-scale': percent / 100 }"
				:data-split="tab.mode === 'split' || undefined"
			>
				<CodeEditor
					v-show="editorVisible"
					ref="codeEditor"
					v-model="tab.text.draft"
					:language="editor"
					:label="copy.edit"
					:font-size="editorFontSize"
					:read-only="tab.mode === 'preview'"
				/>
				<div
					v-if="tab.mode !== 'edit' && tab.format.kind !== 'text'"
					class="file-preview__body"
					data-ui-selection="text"
				>
					<article v-if="tab.format.kind === 'markdown'" class="file-preview__markdown" v-html="markdown" />
					<template v-else-if="tab.format.kind === 'csv'">
						<div v-if="columns > columnPageSize" class="file-preview__column-tools">
							<UiButton
								appearance="ghost"
								density="compact"
								icon-only
								:aria-label="copy.previousColumns"
								:disabled="columnPage === 0"
								@click="columnPage--"
								><ChevronLeft :size="15"
							/></UiButton>
							<span>{{ copy.columns }} {{ columnStart + 1 }}–{{ columnEnd }} / {{ columns }}</span>
							<UiButton
								appearance="ghost"
								density="compact"
								icon-only
								:aria-label="copy.nextColumns"
								:disabled="columnEnd === columns"
								@click="columnPage++"
								><ChevronRight :size="15"
							/></UiButton>
						</div>
						<table class="file-preview__table">
							<tbody>
								<tr v-for="(row, i) in displayed" :key="i">
									<th scope="row">{{ page * pageSize + i + 1 }}</th>
									<td v-for="col in columnEnd - columnStart" :key="col">
										{{ row[columnStart + col - 1] }}
									</td>
								</tr>
							</tbody>
						</table>
					</template>
				</div>
			</div>
		</template>
		<p v-else class="file-preview__status" role="status">{{ copy.previewStatus[state] }}</p>

		<footer class="file-preview__footer">
			<div class="file-preview__info" :title="saveStatus ? copy.feedback[saveStatus] : tab.file.path">
				<span v-if="saveStatus" role="status">{{ copy.feedback[saveStatus] }}</span>
				<span v-else-if="imageSize">{{ imageSize.width }} × {{ imageSize.height }}</span>
				<span v-else-if="tab.text"
					>{{ textEncodings[tab.text.encoding] }} · {{ lineEndings[tab.text.lineEnding]
					}}<template v-if="tab.mode === 'preview'"> · {{ copy.readOnly }}</template></span
				>
				<span v-else>{{ tab.file.path }}</span>
			</div>
			<div class="file-preview__tools">
				<UiSelect
					v-if="editor"
					class="file-preview__encoding"
					density="compact"
					:model-value="tab.encodingChoice"
					:options="encodingOptions"
					:aria-label="copy.encoding"
					:disabled="state === 'loading' || tab.saving"
					@update:model-value="chooseEncoding"
				/>
				<div
					v-if="editor && state === 'ready'"
					class="file-preview__modes"
					:aria-label="copy.viewMode"
					role="group"
				>
					<button
						v-for="mode in modeOptions"
						:key="mode"
						type="button"
						:aria-pressed="tab.mode === mode"
						:aria-label="copy[mode === 'preview' ? 'rendered' : mode]"
						:title="copy[mode === 'preview' ? 'rendered' : mode]"
						@click="tab.mode = mode"
					>
						<span>{{ copy[mode === 'preview' ? 'rendered' : mode] }}</span>
						<component :is="modeIcons[mode]" :size="15" aria-hidden="true" />
					</button>
				</div>
				<template v-if="tab.format.kind === 'csv' && tab.mode === 'preview' && pages > 1 && state === 'ready'">
					<UiButton
						appearance="ghost"
						density="compact"
						icon-only
						:aria-label="copy.previous"
						:disabled="page === 0"
						@click="page--"
						><ChevronLeft :size="15"
					/></UiButton>
					<span class="file-preview__scale">{{ page + 1 }} / {{ pages }}</span>
					<UiButton
						appearance="ghost"
						density="compact"
						icon-only
						:aria-label="copy.next"
						:disabled="page + 1 >= pages"
						@click="page++"
						><ChevronRight :size="15"
					/></UiButton>
				</template>
				<UiDropdownMenu v-if="zoomable" :items="zoomActions" @select="runFileAction">
					<UiButton
						class="file-preview__zoom file-preview__scale"
						appearance="ghost"
						density="compact"
						:aria-label="copy.zoom + ' · ' + zoomLabel"
						:title="copy.zoom"
					>
						<template #leading><ZoomIn :size="15" /></template>
						{{ zoomLabel }}
					</UiButton>
				</UiDropdownMenu>
				<UiButton
					v-if="editor && tab.text && state === 'ready'"
					appearance="ghost"
					density="compact"
					icon-only
					:aria-label="copy.save"
					:title="copy.save"
					:loading="tab.saving"
					:disabled="!dirty || tab.saving"
					@click="save"
					><Save :size="15"
				/></UiButton>
				<UiButton
					v-for="action in fileActions"
					:key="action.id"
					class="file-preview__file-action"
					appearance="ghost"
					density="compact"
					icon-only
					:aria-label="action.label"
					:title="action.label"
					:disabled="action.disabled"
					@click="runFileAction(action.id)"
					><component :is="action.icon" :size="15"
				/></UiButton>
				<UiDropdownMenu :items="mobileActions" @select="runFileAction">
					<UiButton
						class="file-preview__more"
						appearance="ghost"
						density="compact"
						icon-only
						:aria-label="copy.moreActions"
						:title="copy.moreActions"
						><Ellipsis :size="17"
					/></UiButton>
				</UiDropdownMenu>
			</div>
		</footer>

		<UiDialog v-model:open="reloadPrompt" :title="copy.refresh" :close-label="copy.cancel">
			<p>{{ copy.discardQuestion }}</p>
			<template #footer>
				<UiButton appearance="ghost" @click="reloadPrompt = false">{{ copy.cancel }}</UiButton>
				<UiButton tone="danger" @click="confirmReload">{{ copy.discard }}</UiButton>
			</template>
		</UiDialog>
	</section>
</template>

<style scoped>
	.file-preview {
		container: file-preview / inline-size;
		display: grid;
		grid-template-rows: minmax(0, 1fr) auto;
		height: 100%;
		min-height: 0;
		color: var(--ui-text);
	}
	.file-preview__document,
	.file-preview__document :deep(.monaco-scrollable-element) {
		touch-action: pan-x pan-y;
	}
	.file-preview__document {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		min-height: 0;
		min-width: 0;
	}
	.file-preview__document[data-split] {
		grid-template-columns: repeat(2, minmax(0, 1fr));
	}
	.file-preview__document[data-split] .file-preview__body {
		border-inline-start: 1px solid var(--ui-border);
	}
	@container file-preview (max-width: 560px) {
		.file-preview__document[data-split] {
			grid-template-columns: minmax(0, 1fr);
			grid-template-rows: repeat(2, minmax(0, 1fr));
		}
		.file-preview__document[data-split] .file-preview__body {
			border-inline-start: 0;
			border-block-start: 1px solid var(--ui-border);
		}
	}
	.file-preview__body,
	.file-preview__image {
		touch-action: pan-x pan-y;
		min-height: 0;
		min-width: 0;
		overflow: auto;
	}
	.file-preview__markdown :deep(pre) {
		margin: 0;
		padding: 16px;
		font: 0.93em/1.65 var(--ui-font-mono, ui-monospace, monospace);
		tab-size: 4;
	}
	.file-preview__image {
		display: flex;
		padding: 16px;
		background-color: color-mix(in srgb, var(--ui-text) 4%, var(--ui-surface));
	}
	.file-preview__image > img {
		display: block;
		flex: none;
		margin: auto;
		object-fit: contain;
	}
	.file-preview__image > img[data-fit] {
		width: auto;
		height: auto;
		max-width: 100%;
		max-height: 100%;
	}
	.file-preview__pdf {
		border: 0;
		width: 100%;
		height: 100%;
	}
	.file-preview__markdown {
		max-width: 74ch;
		margin-inline: auto;
		padding: clamp(16px, 4vw, 36px);
		overflow-wrap: anywhere;
		font-size: calc(14px * var(--preview-scale, 1));
		line-height: 1.7;
	}
	.file-preview__markdown :deep(> :first-child) {
		margin-block-start: 0;
	}
	.file-preview__markdown :deep(a) {
		color: var(--ui-primary);
	}
	.file-preview__markdown :deep(pre) {
		overflow: auto;
		border: 1px solid var(--ui-border);
		border-radius: 7px;
		background: color-mix(in srgb, var(--ui-text) 5%, var(--ui-surface));
	}
	.file-preview__markdown :deep(blockquote) {
		margin-inline: 0;
		padding-inline: 1em;
		border-inline-start: 3px solid var(--ui-border);
		color: var(--ui-muted);
	}
	.file-preview__markdown :deep(table),
	.file-preview__table {
		border-collapse: collapse;
		text-align: start;
	}
	.file-preview__markdown :deep(td),
	.file-preview__markdown :deep(th),
	.file-preview__table :is(th, td) {
		padding: 6px 12px;
		border: 1px solid var(--ui-border);
		text-align: start;
	}
	.file-preview__table {
		min-width: 100%;
		font-size: calc(13px * var(--preview-scale, 1));
	}
	.file-preview__table td {
		max-width: 44ch;
		overflow-wrap: anywhere;
	}
	.file-preview__column-tools {
		position: sticky;
		inset-inline-start: 0;
		display: flex;
		align-items: center;
		gap: 4px;
		width: fit-content;
		padding: 4px 8px;
		font-size: 12px;
		color: var(--ui-muted);
	}
	.file-preview__table th {
		width: 2.5rem;
		color: var(--ui-muted);
		background: var(--ui-surface);
	}
	.file-preview__status {
		margin: auto;
		padding: 18px;
		color: var(--ui-muted);
		text-align: center;
	}
	.file-preview__footer {
		display: flex;
		align-items: center;
		min-width: 0;
		min-height: 40px;
		gap: 8px;
		padding: 4px 10px;
		border-top: 1px solid var(--ui-border);
		background: color-mix(in srgb, var(--ui-text) 4%, var(--ui-surface));
	}
	.file-preview__info {
		min-width: 0;
		flex: 1;
		color: var(--ui-muted);
		font-size: 12px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.file-preview__info [role='status'] {
		color: var(--ui-text);
	}
	.file-preview__tools,
	.file-preview__modes {
		display: flex;
		align-items: center;
		gap: 2px;
		flex: none;
	}
	.file-preview__encoding {
		max-width: 130px;
		margin-inline-end: 4px;
	}
	.file-preview__more,
	.file-preview__modes svg {
		display: none;
	}
	.file-preview__modes {
		margin-inline-end: 4px;
		padding: 2px;
		border: 1px solid var(--ui-border);
		border-radius: 7px;
	}
	.file-preview__modes button {
		border: 0;
		border-radius: 5px;
		background: transparent;
		padding: 3px 7px;
		color: var(--ui-muted);
		font: inherit;
		font-size: 12px;
		cursor: pointer;
	}
	.file-preview__modes button[aria-pressed='true'] {
		color: var(--ui-text);
		background: color-mix(in srgb, var(--ui-primary) 15%, var(--ui-surface));
	}
	.file-preview__scale {
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	@container file-preview (max-width: 480px) {
		.file-preview__footer {
			gap: 5px;
			padding-inline: 7px;
		}
		.file-preview__tools {
			--ui-button-height: 30px;
			flex: 0 1 auto;
			min-width: 0;
		}
		.file-preview__tools > button {
			flex-shrink: 0;
		}
		.file-preview__tools > .file-preview__encoding {
			flex: 0 1 auto;
			min-width: 58px;
			max-width: 96px;
			margin-inline-end: 2px;
		}
		.file-preview__modes {
			margin-inline-end: 2px;
		}
		.file-preview__modes button {
			display: grid;
			place-items: center;
			width: 26px;
			height: 26px;
			padding: 0;
		}
		.file-preview__file-action,
		.file-preview__zoom,
		.file-preview__modes span {
			display: none;
		}
		.file-preview__more,
		.file-preview__modes svg {
			display: inline-flex;
		}
	}
</style>
