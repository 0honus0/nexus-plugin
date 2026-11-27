<script setup lang="ts">
	import { computed, onScopeDispose, ref, watch } from 'vue';
	import { useI18n } from 'vue-i18n';
	import { ArrowDownToLine, ChevronLeft, ChevronRight, Maximize, Minus, Plus, RotateCw, Save } from '@lucide/vue';
	import { UiButton, UiDialog } from 'nexus-terminal/browser/ui';
	import { sha256 } from '@noble/hashes/sha2.js';
	import { bytesToHex } from '@noble/hashes/utils.js';
	import Papa from 'papaparse';
	import CodeEditor from './CodeEditor.vue';
	import { isDirty, type PreviewDocument } from './preview-document.js';
	import { renderMarkdown } from './preview-markdown.js';
	import { language, messages } from './messages.js';

	const props = defineProps<{ tab: PreviewDocument; signal: AbortSignal }>();
	const { locale } = useI18n({ useScope: 'global' });
	const copy = computed(() => messages[language(locale.value)]);
	const state = ref<'loading' | 'tooLarge' | 'invalidText' | 'failed' | 'ready'>(
		props.tab.text ? 'ready' : 'loading',
	);
	const objectUrl = ref('');
	const imageSize = ref<{ width: number; height: number }>();
	const zoom = ref<number | 'fit'>('fit');
	const imageFrame = ref<HTMLElement>();
	const saveStatus = ref<
		'saved' | 'saveFailed' | 'downloadFailed' | 'conflict' | 'tooLarge' | 'atomicSaveUnavailable'
	>();
	const reloadPrompt = ref(false);
	const page = ref(0);
	const pageSize = 100;
	const columnPage = ref(0);
	const columnPageSize = 64;
	let request: AbortController | undefined;
	const lifetime = new AbortController();
	const active = AbortSignal.any([props.signal, lifetime.signal]);

	const editor = computed(() => ('language' in props.tab.format ? props.tab.format.language : undefined));
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
		page.value = 0;
		columnPage.value = 0;
		releaseObject();
		imageSize.value = undefined;
		zoom.value = 'fit';
		try {
			const bytes = await file.read(format.maxBytes, signal);
			if (signal.aborted) return;
			if ('mime' in format) {
				objectUrl.value = URL.createObjectURL(new Blob([bytes], { type: format.mime }));
			} else {
				let decoded: string;
				try {
					decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
					if (decoded.includes('\0')) throw new TypeError();
				} catch {
					state.value = 'invalidText';
					return;
				}
				const data = new Uint8Array(bytes);
				const text = decoded.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
				props.tab.text = {
					original: text,
					draft: text,
					hash: bytesToHex(sha256(data)),
					bom: data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf,
					lineEnding: decoded.includes('\r\n') ? '\r\n' : '\n',
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
		if (dirty.value) reloadPrompt.value = true;
		else void load();
	}

	async function save() {
		const { tab } = props;
		const text = tab.text;
		if (!text || !dirty.value || tab.saving || active.aborted || state.value !== 'ready') return;
		const draft = text.draft;
		const encoded = new TextEncoder().encode((text.bom ? '\uFEFF' : '') + draft.replaceAll('\n', text.lineEnding));
		if (encoded.byteLength > tab.format.maxBytes) {
			saveStatus.value = 'tooLarge';
			return;
		}
		tab.saving = true;
		saveStatus.value = undefined;
		try {
			await tab.file.save(new Blob([encoded]), text.hash, active);
			text.original = draft;
			text.hash = bytesToHex(sha256(encoded));
			saveStatus.value = 'saved';
		} catch (cause) {
			if (!active.aborted)
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

	function changeZoom(step: number) {
		const size = imageSize.value;
		const frame = imageFrame.value;
		if (!size || !frame) return;
		const fit = Math.min(
			1,
			Math.max(0, frame.clientWidth - 32) / size.width,
			Math.max(0, frame.clientHeight - 32) / size.height,
		);
		const current = zoom.value === 'fit' ? Math.round(fit * 100) : zoom.value;
		zoom.value = Math.max(5, Math.min(400, current + step));
	}

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
			<div v-if="tab.format.kind === 'image'" ref="imageFrame" class="file-preview__image">
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
				:src="objectUrl + '#view=Fit&toolbar=0'"
				:title="tab.file.name"
				referrerpolicy="no-referrer"
			/>
			<div
				v-else-if="tab.text && editor"
				class="file-preview__document"
				:data-split="tab.mode === 'split' || undefined"
			>
				<CodeEditor
					v-show="tab.mode !== 'preview'"
					v-model="tab.text.draft"
					:language="editor"
					:label="copy.edit"
				/>
				<div v-if="tab.mode !== 'edit'" class="file-preview__body" data-ui-selection="text">
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
					<pre v-else>{{ source }}</pre>
				</div>
			</div>
		</template>
		<p v-else class="file-preview__status" role="status">{{ copy.previewStatus[state] }}</p>

		<footer class="file-preview__footer">
			<div class="file-preview__info" :title="saveStatus ? copy.feedback[saveStatus] : tab.file.path">
				<span v-if="saveStatus" role="status">{{ copy.feedback[saveStatus] }}</span>
				<span v-else-if="imageSize">{{ imageSize.width }} × {{ imageSize.height }}</span>
				<span v-else-if="tab.text">UTF-8 · {{ tab.text.lineEnding === '\r\n' ? 'CRLF' : 'LF' }}</span>
				<span v-else>{{ tab.file.path }}</span>
			</div>
			<div class="file-preview__tools">
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
						@click="tab.mode = mode"
					>
						{{ copy[mode === 'preview' ? 'rendered' : mode] }}
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
				<template v-if="imageSize && state === 'ready'">
					<UiButton
						appearance="ghost"
						density="compact"
						icon-only
						:aria-label="copy.zoomOut"
						:title="copy.zoomOut"
						@click="changeZoom(-25)"
						><Minus :size="15"
					/></UiButton>
					<UiButton
						appearance="ghost"
						density="compact"
						class="file-preview__scale"
						:aria-label="copy.actualSize"
						:title="copy.actualSize"
						@click="zoom = 100"
						>{{ zoom === 'fit' ? copy.fit : zoom + '%' }}</UiButton
					>
					<UiButton
						appearance="ghost"
						density="compact"
						icon-only
						:aria-label="copy.zoomIn"
						:title="copy.zoomIn"
						@click="changeZoom(25)"
						><Plus :size="15"
					/></UiButton>
					<UiButton
						appearance="ghost"
						density="compact"
						icon-only
						:aria-label="copy.fit"
						:title="copy.fit"
						@click="zoom = 'fit'"
						><Maximize :size="15"
					/></UiButton>
				</template>
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
					appearance="ghost"
					density="compact"
					icon-only
					:aria-label="copy.refresh"
					:title="copy.refresh"
					:disabled="state === 'loading' || tab.saving"
					@click="reload"
					><RotateCw :size="15"
				/></UiButton>
				<UiButton
					appearance="ghost"
					density="compact"
					icon-only
					:aria-label="copy.download"
					:title="copy.download"
					@click="download"
					><ArrowDownToLine :size="15"
				/></UiButton>
			</div>
		</footer>

		<UiDialog v-model:open="reloadPrompt" :title="copy.refresh" :close-label="copy.cancel">
			<p>{{ copy.discardQuestion }}</p>
			<template #footer>
				<UiButton appearance="ghost" @click="reloadPrompt = false">{{ copy.cancel }}</UiButton>
				<UiButton tone="danger" @click="load">{{ copy.discard }}</UiButton>
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
		min-height: 0;
		min-width: 0;
		overflow: auto;
	}
	.file-preview__body pre {
		margin: 0;
		padding: 16px;
		font: 13px/1.65 var(--ui-font-mono, ui-monospace, monospace);
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
		font-size: 14px;
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
		font-size: 13px;
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
</style>
