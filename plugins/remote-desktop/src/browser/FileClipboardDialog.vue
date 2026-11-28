<script setup lang="ts">
	import { Clipboard, Download, File, Folder, Upload } from '@lucide/vue';
	import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
	import { UiButton, UiDialog, UiList, UiListItem, UiProgress } from 'nexus-terminal/browser/ui';
	import type {
		RemoteDesktopClipboardFile,
		RemoteDesktopFileClipboard,
		RemoteDesktopFileClipboardState,
	} from './desktop-peer';

	const props = defineProps<{ clipboard?: RemoteDesktopFileClipboard; t(key: string): string }>();
	const emit = defineEmits<{ report: [code: string]; closeAutoFocus: [event: Event] }>();
	const open = defineModel<boolean>('open', { default: false });
	const picker = ref<HTMLInputElement>();
	const initial: RemoteDesktopFileClipboardState = { files: [], canUpload: false, upload: null, downloads: [] };
	const state = shallowRef(initial);
	const downloads = computed(() => new Map(state.value.downloads.map((item) => [item.id, item])));
	let generation = 0;
	const revokers = new Map<string, ReturnType<typeof setTimeout>>();

	watch(
		() => props.clipboard,
		(clipboard, _, cleanup) => {
			generation++;
			state.value = initial;
			if (clipboard) cleanup(clipboard.subscribe((update) => (state.value = update)));
		},
		{ immediate: true },
	);

	onScopeDispose(() => {
		generation++;
		for (const [url, timer] of revokers) {
			clearTimeout(timer);
			URL.revokeObjectURL(url);
		}
		revokers.clear();
	});

	function percent(progress: { transferred: number; total: number }): number {
		return Math.min(100, Math.round((progress.transferred / (progress.total || 1)) * 100));
	}

	function fileSize(size: number): string {
		const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
		const index = size > 0 ? Math.floor(Math.log2(size) / 10) : 0;
		const amount = (size / 1024 ** index).toLocaleString(undefined, { maximumFractionDigits: index === 0 ? 0 : 1 });
		return amount + ' ' + units[index];
	}

	async function upload(event: Event): Promise<void> {
		const target = event.currentTarget as HTMLInputElement;
		const files = Array.from(target.files ?? []);
		target.value = '';
		const clipboard = props.clipboard;
		const original = generation;
		if (!clipboard || !state.value.canUpload || !files.length) return;
		try {
			await clipboard.upload(files);
			if (generation === original) emit('report', 'DESKTOP_FILE_UPLOADED');
		} catch {
			if (generation === original) emit('report', 'DESKTOP_FILE_TRANSFER_FAILED');
		}
	}

	async function download(file: RemoteDesktopClipboardFile): Promise<void> {
		const clipboard = props.clipboard;
		const original = generation;
		if (!clipboard) return;
		try {
			const blob = await clipboard.download(file.id);
			if (generation !== original || !state.value.files.some(({ id }) => id === file.id)) return;
			const url = URL.createObjectURL(blob);
			const anchor = document.createElement('a');
			try {
				anchor.href = url;
				anchor.download = file.name;
				anchor.click();
			} finally {
				revokers.set(
					url,
					setTimeout(() => {
						URL.revokeObjectURL(url);
						revokers.delete(url);
					}, 0),
				);
			}
		} catch {
			if (generation === original) emit('report', 'DESKTOP_FILE_TRANSFER_FAILED');
		}
	}
</script>

<template>
	<UiDialog
		v-model:open="open"
		:title="t('files.title')"
		:close-label="t('cancel')"
		:resizable="false"
		@close-auto-focus="emit('closeAutoFocus', $event)"
	>
		<div class="remote-desktop-file-clipboard">
			<section class="remote-desktop-file-clipboard__upload">
				<div class="remote-desktop-file-clipboard__upload-row">
					<span class="remote-desktop-file-clipboard__icon"><Upload :size="19" aria-hidden="true" /></span>
					<div class="remote-desktop-file-clipboard__copy">
						<h3>{{ t('files.send') }}</h3>
						<p>{{ t('files.uploadHint') }}</p>
					</div>
					<input ref="picker" type="file" hidden multiple @change="upload" />
					<UiButton tone="primary" :disabled="!state.canUpload" @click="picker?.click()">
						{{ t('files.choose') }}
					</UiButton>
				</div>
				<div v-if="state.upload" class="remote-desktop-file-clipboard__transfer">
					<span role="status">{{ t(state.upload.waiting ? 'files.waiting' : 'files.uploading') }}</span>
					<UiProgress
						v-if="!state.upload.waiting"
						:label="t('files.uploading')"
						:value="percent(state.upload)"
					/>
				</div>
			</section>
			<section class="remote-desktop-file-clipboard__remote">
				<h3>{{ t('files.remote') }}</h3>
				<div v-if="!state.files.length" class="remote-desktop-file-clipboard__empty">
					<span class="remote-desktop-file-clipboard__icon"><Clipboard :size="19" aria-hidden="true" /></span>
					<div class="remote-desktop-file-clipboard__copy">
						<strong>{{ t('files.empty') }}</strong>
						<p>{{ t('files.downloadHint') }}</p>
					</div>
				</div>
				<UiList v-else>
					<UiListItem
						v-for="file in state.files"
						:key="file.id"
						:title="file.name"
						:icon="file.isDirectory ? Folder : File"
					>
						<template #description>
							{{ file.isDirectory ? t('files.directory') : fileSize(file.size) }}
							<UiProgress
								v-if="downloads.has(file.id)"
								class="remote-desktop-file-clipboard__download-progress"
								:label="t('files.download') + ' ' + file.name"
								:value="percent(downloads.get(file.id)!)"
							/>
						</template>
						<template v-if="!file.isDirectory" #actions>
							<UiButton
								icon-only
								appearance="ghost"
								:aria-label="t('files.download') + ' ' + file.name"
								:title="t('files.download')"
								:loading="downloads.has(file.id)"
								@click="download(file)"
							>
								<Download :size="16" />
							</UiButton>
						</template>
					</UiListItem>
				</UiList>
			</section>
		</div>
	</UiDialog>
</template>
