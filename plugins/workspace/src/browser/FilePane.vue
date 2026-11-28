<script setup lang="ts">
	import { computed, inject, ref, watch, nextTick } from 'vue';
	import { useDropZone, useClipboard } from '@vueuse/core';
	import {
		Search,
		Copy,
		Scissors,
		ClipboardPaste,
		FilePlus,
		Folder,
		Eye,
		EyeOff,
		ListFilter,
		ZoomIn,
		RefreshCw,
		Upload,
		Download,
		FolderPlus,
		Pencil,
		Trash2,
		X,
		Check,
		CircleAlert,
		FolderSync,
		Terminal,
		Archive,
		Send,
		Shield,
	} from '@lucide/vue';
	import { UiButton, UiInput, UiDropdownMenu } from 'nexus-terminal/browser/ui';
	import type { UiMenuItem } from 'nexus-terminal/browser/ui';
	import type { PluginContextApi } from 'nexus-terminal/browser';
	import type { PluginWindowApi } from 'nexus-terminal/browser';
	import type { WorkspaceI18n } from './workspace-i18n';
	import type { FileManagerOpenFile } from './file-manager-api.js';
	import { fileListKey } from './file-list-key';
	import DefaultFileList from '#file-list';
	import type { FileEntry } from '../shared/workspace-file-types';
	import { TerminalDirectorySchema } from '../shared/workspace-file-operation-types';
	import { useFileSearch } from './files/use-file-search';
	import FileIcon from './files/FileIcon.vue';
	import { filesPresentation } from './files/files-presentation';
	import PathFavorites from './files/PathFavorites.vue';
	import WorkspacePathBar from './files/WorkspacePathBar.vue';
	import FileOperationDialogs from './files/FileOperationDialogs.vue';
	import { useWorkspaceCatalog } from './catalog/workspace-catalog';
	import { useFileOperations } from './files/use-file-operations';
	import { useWorkspaceFilesState } from './files/workspace-files-state';
	import { usePanePresentation } from './presentation/pane-presentation';
	import { createWorkspaceClient } from './workspace-client';
	import { useFiles } from './use-files';
	import { usePinchZoom } from '../../../../shared/browser/use-pinch-zoom.mjs';
	const props = defineProps<{
		sessionId: string;
		enabled: boolean;
		connected: boolean;
		ctx: PluginContextApi;
		view: PluginWindowApi;
		i18n: WorkspaceI18n;
		filesOnly?: boolean;
		openFile?: FileManagerOpenFile;
	}>();
	const emit = defineEmits<{ busy: [value: boolean]; fileOpened: [] }>();
	const { t } = props.i18n;
	const suppliedFileList = inject(fileListKey);
	const fileList = computed(() => suppliedFileList?.value ?? DefaultFileList);
	const signal = AbortSignal.any([props.ctx.signal, props.view.signal]);
	const client = createWorkspaceClient(props.ctx, signal),
		shared = useWorkspaceFilesState();
	const files = useFiles(
		props.ctx,
		props.sessionId,
		props.view.signal,
		() => props.enabled,
		() => props.connected,
	);
	const { path, loaded, loading, directoryChanging, showRefreshLoading, mutating, busy } = files;
	const catalog = useWorkspaceCatalog();
	const operations = useFileOperations(
		props.ctx,
		props.sessionId,
		signal,
		files,
		() => catalog.state.value.preferences.confirmFileDeletion,
	);
	const browserSearch = useFileSearch(props.ctx, props.sessionId, path, props.view.signal);
	const { query: search, searching, truncated } = browserSearch;
	const surface = ref<HTMLElement>(),
		searchTrigger = ref<InstanceType<typeof UiButton>>(),
		searchDock = ref<HTMLElement>(),
		searchExpanded = ref(false),
		showHidden = ref(false),
		sort = ref('name');
	const { scale: fileScale, style: fileScaleStyle, inputScale } = usePanePresentation(surface, filesPresentation);
	const zoomItems = computed<UiMenuItem[]>(() =>
		[65, 80, 100, 125, 150, 160].map((percent) => ({
			id: String(percent),
			label: `${percent}%`,
			disabled: Math.round(fileScale.value * 100) === percent,
		})),
	);
	usePinchZoom(surface, inputScale.beginPinch, inputScale.pinch);
	const textClipboard = useClipboard({ legacy: true });
	const selected = ref<string[]>([]),
		anchor = ref(''),
		context = ref<FileEntry>();
	const syncing = ref<'toTerminal' | 'fromTerminal'>();

	const uploadInput = ref<HTMLInputElement>();
	let touchClick = false;

	function uploadSelected(event: Event) {
		const input = event.currentTarget as HTMLInputElement;
		const chosen = Array.from(input.files ?? []);
		input.value = '';
		if (props.enabled && loaded.value && !directoryChanging.value && !busy.value && chosen.length)
			files.upload(chosen);
	}

	function displayName(entry: FileEntry) {
		return 'relativePath' in entry ? String(entry.relativePath) : entry.name;
	}

	const parentPath = computed(() => path.value.replace(/\/[^/]+\/?$/, '') || '/');
	const parent = computed<FileEntry | undefined>(() =>
		loaded.value && path.value !== '/'
			? { name: '..', path: parentPath.value, kind: 'directory', size: 0, modifiedAt: 0, mode: 0 }
			: undefined,
	);
	const names = new Intl.Collator(undefined, { numeric: true });
	const modifiedDate = computed(
		() => new Intl.DateTimeFormat(props.i18n.language.value, { dateStyle: 'short', timeStyle: 'short' }),
	);
	const rows = computed(() =>
		(browserSearch.active.value ? (browserSearch.entries.value ?? []) : files.entries.value)
			.filter(
				(entry) =>
					showHidden.value ||
					!displayName(entry)
						.split('/')
						.some((part) => part.startsWith('.')),
			)
			.sort(
				(a, b) =>
					Number(b.kind === 'directory') - Number(a.kind === 'directory') ||
					(sort.value === 'size'
						? b.size - a.size
						: sort.value === 'modified'
							? b.modifiedAt - a.modifiedAt
							: 0) ||
					names.compare(a.name, b.name),
			),
	);
	const visibleRows = computed(() => (parent.value ? [parent.value, ...rows.value] : rows.value));
	const selectedPaths = computed(() => new Set(selected.value));
	const cutPaths = computed(() => {
		const clipboard = shared.clipboard.value;
		return new Set(
			clipboard?.operation === 'cut' && clipboard.sourceSessionId === props.sessionId ? clipboard.paths : [],
		);
	});
	const selectedEntries = computed(() => rows.value.filter((entry) => selectedPaths.value.has(entry.path)));

	const isParent = (entry?: FileEntry) => entry?.name === '..';

	function prefetchEntry(entry: FileEntry, event?: PointerEvent) {
		if (event?.pointerType !== 'touch' && entry.kind === 'directory') files.prefetch(entry.path);
	}

	watch(path, () => {
		selected.value = [];
		anchor.value = '';
	});
	watch(files.entries, () => {
		if (browserSearch.active.value) void browserSearch.search();
	});
	watch(
		() => busy.value || !!syncing.value,
		(value) => emit('busy', value),
		{ immediate: true },
	);
	watch(visibleRows, (value) => {
		const available = new Set(value.map((entry) => entry.path));
		selected.value = selected.value.filter((p) => available.has(p));
		if (!available.has(anchor.value)) anchor.value = '';
	});

	function up() {
		void files.load(parentPath.value);
	}

	function select(entry: FileEntry, event?: MouseEvent) {
		touchClick = event instanceof PointerEvent && event.pointerType === 'touch';
		if (event?.shiftKey) {
			const keys = visibleRows.value.map((e) => e.path),
				a = keys.indexOf(anchor.value),
				b = keys.indexOf(entry.path);
			if (a >= 0 && b >= 0) selected.value = keys.slice(Math.min(a, b), Math.max(a, b) + 1);
			else {
				selected.value = [entry.path];
				anchor.value = entry.path;
			}
		} else if (event?.ctrlKey || event?.metaKey) {
			selected.value = selectedPaths.value.has(entry.path)
				? selected.value.filter((p) => p !== entry.path)
				: [...selected.value, entry.path];
			anchor.value = entry.path;
		} else {
			selected.value = [entry.path];
			anchor.value = entry.path;
			if (event && (entry.kind === 'directory' || entry.kind === 'link')) void files.load(entry.path);
			if (touchClick) void activateFile(entry);
		}
	}

	function doubleClick(entry: FileEntry, event: MouseEvent) {
		if (touchClick || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
		void activateFile(entry);
	}

	function targets(entry?: FileEntry) {
		if (!entry || isParent(entry)) return [];
		return selectedPaths.value.has(entry.path) ? selectedEntries.value : [entry];
	}

	function prepareContext(entry?: FileEntry) {
		context.value = entry;
		if (entry && !selectedPaths.value.has(entry.path)) {
			selected.value = [entry.path];
			anchor.value = entry.path;
		}
	}

	async function activateFile(entry: FileEntry, mode: 'reuse' | 'new' = 'reuse') {
		if (
			entry.kind !== 'file' ||
			!props.openFile ||
			!props.enabled ||
			!loaded.value ||
			directoryChanging.value ||
			signal.aborted
		)
			return;
		const sessionId = props.sessionId;
		const endpoint = 'sessions/' + sessionId + '/file?';
		try {
			const opened = props.openFile({
				name: entry.name,
				path: entry.path,
				sessionId,
				size: entry.size,
				mode,

				async read(maxBytes, readSignal) {
					const active = AbortSignal.any([signal, readSignal]);
					active.throwIfAborted();
					const response = await client.binary(endpoint + new URLSearchParams({ path: entry.path }), {
						signal: active,
					});
					const length = response.headers.get('content-length');
					if (length === null || !/^\d+$/u.test(length) || Number(length) > maxBytes) {
						await response.body?.cancel();
						throw new Error('WORKSPACE_PREVIEW_TOO_LARGE');
					}
					return response.arrayBuffer();
				},

				async save(body, expectedHash, saveSignal) {
					const query = new URLSearchParams({
						path: entry.path,
						size: String(body.size),
						overwrite: 'true',
						expectedHash,
					});
					await client.binary(endpoint + query, {
						method: 'PUT',
						body,
						headers: { 'content-type': 'application/octet-stream' },
						signal: AbortSignal.any([signal, saveSignal]),
					});
				},

				async download() {
					await files.download(entry);
				},
			});
			if (opened) emit('fileOpened');
			else await files.download(entry);
		} catch (cause) {
			client.report(cause);
		}
	}

	const archiveFormat = (name: string) =>
		/\.zip$/i.test(name)
			? 'zip'
			: /\.(?:tar\.gz|tgz)$/i.test(name)
				? 'tar.gz'
				: /\.(?:tar\.bz2|tbz2?)$/i.test(name)
					? 'tar.bz2'
					: undefined;

	function entryItems(entry?: FileEntry): UiMenuItem[] {
		const entries = targets(entry);
		const first = entries[0];
		const single = entries.length === 1;
		const noTargets = !entries.length;
		return [
			...(entry?.kind === 'directory' || entry?.kind === 'link'
				? [{ id: 'open', label: t('openDirectory'), icon: Folder }]
				: []),
			...(props.openFile && single && first.kind === 'file'
				? [
						{ id: 'openFile', label: t('openFile'), icon: Eye },
						{ id: 'openFileNew', label: t('openFileNew'), icon: Eye },
					]
				: []),
			{ id: 'file', label: t('file'), icon: FilePlus },
			{ id: 'mkdir', label: t('mkdir'), icon: FolderPlus },
			{ id: 'copy', label: t('filesMenu.copy'), icon: Copy, disabled: noTargets, separatorBefore: true },
			{ id: 'cut', label: t('filesMenu.cut'), icon: Scissors, disabled: noTargets },
			{
				id: 'paste',
				label: t('filesMenu.paste'),
				icon: ClipboardPaste,
				disabled: !shared.clipboard.value,
			},
			{ id: 'send', label: t('filesMenu.send'), icon: Send, disabled: noTargets },
			{
				id: 'compress',
				label: t('filesMenu.compress'),
				icon: Archive,
				disabled: noTargets,
				separatorBefore: true,
			},
			...(single && archiveFormat(first.name)
				? [{ id: 'extract', label: t('filesMenu.extract'), icon: Archive }]
				: []),
			{ id: 'permissions', label: t('filesMenu.permissions'), icon: Shield, disabled: noTargets },
			{ id: 'rename', label: t('rename'), icon: Pencil, disabled: !single },
			{ id: 'download', label: t('download'), icon: Download, disabled: !single || first.kind === 'directory' },
			{
				id: 'remove',
				label: t('remove'),
				icon: Trash2,
				disabled: noTargets,
				tone: 'danger',
				separatorBefore: true,
			},
			{ id: 'copyPath', label: t('copyPath'), icon: Copy, separatorBefore: true },
		];
	}

	async function menuAction(id: string, entry = context.value) {
		if (
			!props.enabled ||
			!loaded.value ||
			directoryChanging.value ||
			busy.value ||
			!entryItems(entry).some((item) => item.id === id && !item.disabled)
		)
			return;
		const entries = targets(entry),
			directory = entry?.kind === 'directory' ? entry.path : path.value;
		if (id === 'open' && entry) await files.load(entry.path);
		else if ((id === 'openFile' || id === 'openFileNew') && entries[0])
			await activateFile(entries[0], id === 'openFileNew' ? 'new' : 'reuse');
		else if (id === 'copy' || id === 'cut')
			shared.copy(
				props.sessionId,
				entries.map((e) => e.path),
				id,
			);
		else if (id === 'paste') await operations.paste(directory);
		else if (id === 'download' && entries[0]) await files.download(entries[0]);
		else if (id === 'copyPath') {
			try {
				await textClipboard.copy(entry?.path ?? path.value);
			} catch (cause) {
				client.report(cause);
			}
		} else if (id === 'file' || id === 'mkdir') operations.open(id, [], directory);
		else if (id === 'compress') operations.open('compress', entries, path.value);
		else if (id === 'extract' && entries[0])
			operations.open('extract', entries, path.value, archiveFormat(entries[0].name));
		else if (id === 'rename' || id === 'remove' || id === 'permissions' || id === 'send')
			operations.open(id, entries, path.value);
	}

	async function synchronize(direction: 'toTerminal' | 'fromTerminal') {
		if (syncing.value || !props.enabled || !props.connected || signal.aborted) return;
		syncing.value = direction;
		try {
			if (direction === 'fromTerminal') await files.followTerminal();
			else
				await client.request(
					'sessions/' + props.sessionId + '/terminal-directory',
					'POST',
					{ path: path.value },
					TerminalDirectorySchema,
				);
		} catch (cause) {
			client.report(cause);
		} finally {
			syncing.value = undefined;
		}
	}

	function shortcut(event: KeyboardEvent) {
		if (
			!props.enabled ||
			!loaded.value ||
			directoryChanging.value ||
			busy.value ||
			operations.state.kind ||
			operations.state.overwrite ||
			event.defaultPrevented ||
			event.isComposing
		)
			return;
		if ((event.target as HTMLElement).closest('input,textarea,[contenteditable="true"],[role="menu"]')) return;
		let action: (() => void) | undefined;
		const key = event.key.toLowerCase(),
			mod = event.ctrlKey || event.metaKey;
		const entry = visibleRows.value.find((e) => e.path === selected.value.at(-1));
		if (mod && key === 'f' && props.enabled && loaded.value) action = showSearch;
		else if (mod && key === 'c')
			action = () => {
				if (selectedEntries.value.length)
					shared.copy(
						props.sessionId,
						selectedEntries.value.map((e) => e.path),
						'copy',
					);
			};
		else if (mod && key === 'x')
			action = () => {
				if (selectedEntries.value.length)
					shared.copy(
						props.sessionId,
						selectedEntries.value.map((e) => e.path),
						'cut',
					);
			};
		else if (mod && key === 'v')
			action = () => {
				void operations.paste(isParent(entry) ? parentPath.value : path.value);
			};
		else if (mod && key === 'a')
			action = () => {
				selected.value = rows.value.map((e) => e.path);
			};
		else if ((event.altKey && key === 'arrowup') || key === 'backspace') action = up;
		else if (key === 'f5')
			action = () => {
				void files.load();
			};
		else if (key === 'f2' && selectedEntries.value.length === 1)
			action = () => operations.open('rename', selectedEntries.value);
		else if (key === 'delete' && selectedEntries.value.length)
			action = () => operations.open('remove', selectedEntries.value);
		else if (mod && event.shiftKey && key === 'n') action = () => operations.open('mkdir', []);
		else if (key === 'enter' && entry)
			action = () => {
				if (entry.kind === 'directory' || entry.kind === 'link') void files.load(entry.path);
			};
		else if (key === 'arrowdown' || key === 'arrowup')
			action = () => {
				const index = visibleRows.value.findIndex((e) => e.path === entry?.path),
					next =
						visibleRows.value[
							Math.max(0, Math.min(visibleRows.value.length - 1, index + (key === 'arrowdown' ? 1 : -1)))
						];
				if (next) {
					selected.value = [next.path];
					prefetchEntry(next);
					nextTick(() =>
						surface.value
							?.querySelector<HTMLElement>('[aria-pressed="true"]')
							?.scrollIntoView({ block: 'nearest' }),
					);
				}
			};
		if (action) {
			event.preventDefault();
			event.stopPropagation();
			action();
		}
	}

	async function showSearch() {
		searchExpanded.value = true;
		await nextTick();
		surface.value?.querySelector<HTMLInputElement>('.workspace-file-search input')?.focus();
	}

	function closeSearch() {
		search.value = '';
		searchExpanded.value = false;
		void nextTick(() => searchTrigger.value?.$el.focus({ preventScroll: true }));
	}

	function clearSearch() {
		if (search.value) {
			search.value = '';
			void showSearch();
		} else closeSearch();
	}

	function submitSearch(event: KeyboardEvent) {
		if (event.isComposing) return;
		event.preventDefault();
		void browserSearch.search();
	}

	const { isOverDropZone } = useDropZone(surface, {
		checkValidity: (items) => !!items.length && Array.from(items).every((item) => item.kind === 'file'),

		onDrop(dropped, event) {
			if (!props.enabled || !loaded.value || directoryChanging.value || busy.value) return;
			if (Array.from(event.dataTransfer?.items ?? []).some((item) => item.webkitGetAsEntry?.()?.isDirectory)) {
				props.ctx.app.log.report({
					level: 'warn',
					code: 'WORKSPACE_DROP_FILES_ONLY',
					userVisible: true,
				});
				return;
			}
			if (dropped?.length) void files.upload(dropped);
		},
	});

	function activateWithKeyboard(entry: FileEntry, event: KeyboardEvent) {
		if (isParent(entry)) {
			event.preventDefault();
			up();
		} else if (props.openFile && entry.kind === 'file') {
			event.preventDefault();
			void activateFile(entry);
		}
	}

	function size(bytes: number) {
		const unit = bytes < 1024 ? 'B' : bytes < 1024 ** 2 ? 'KiB' : bytes < 1024 ** 3 ? 'MiB' : 'GiB';
		const divisor = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 }[unit];
		return props.i18n.n(Math.round((bytes / divisor) * 10) / 10) + ' ' + unit;
	}
</script>
<template>
	<section
		ref="surface"
		class="workspace-files"
		:data-files-only="filesOnly || undefined"
		:style="{ '--workspace-file-scale': fileScale }"
		:aria-label="t('files')"
		tabindex="0"
		@keydown="shortcut"
	>
		<input ref="uploadInput" type="file" multiple hidden @change="uploadSelected" />
		<div class="workspace-file-header workspace-panel-bar">
			<WorkspacePathBar
				:ctx="ctx"
				:signal="signal"
				:i18n="i18n"
				:path="path"
				:loaded="loaded"
				:enabled="enabled"
				:navigate="files.load"
			/>
			<div class="workspace-file-tools">
				<template v-if="filesOnly || !searchExpanded">
					<UiButton
						class="workspace-file-upload workspace-panel-primary"
						:appearance="filesOnly ? 'solid' : 'soft'"
						tone="primary"
						:aria-label="t('upload')"
						:title="t('upload')"
						:disabled="!enabled || !loaded || directoryChanging || busy"
						@click="uploadInput?.click()"
					>
						<template #leading><Upload :size="16" /></template>
						<span class="workspace-file-upload-label">{{ t('upload') }}</span>
					</UiButton>
					<div class="workspace-tool-group">
						<UiButton
							appearance="ghost"
							icon-only
							:aria-label="t('refreshFiles')"
							:title="t('refreshFiles')"
							:loading="showRefreshLoading"
							loading-animation="spinner"
							:disabled="!enabled"
							@click="files.load()"
							><RefreshCw :size="16"
						/></UiButton>
						<Teleport
							v-if="!searchExpanded && (!filesOnly || searchDock)"
							:to="searchDock"
							:disabled="!filesOnly"
						>
							<UiButton
								ref="searchTrigger"
								class="workspace-file-search-trigger"
								appearance="ghost"
								icon-only
								:aria-label="t('searchFiles')"
								:title="t('searchFiles')"
								:disabled="!enabled || !loaded"
								@click="showSearch"
								><Search :size="16"
							/></UiButton>
						</Teleport>
					</div>
					<div class="workspace-tool-group">
						<UiDropdownMenu
							:items="[
								{ id: 'name', label: t('sortName') },
								{ id: 'size', label: t('sortSize') },
								{ id: 'modified', label: t('sortModified') },
							]"
							@select="sort = $event"
							><UiButton appearance="ghost" icon-only :aria-label="t('sortFiles')" :title="t('sortFiles')"
								><ListFilter :size="16" /></UiButton
						></UiDropdownMenu>
						<UiDropdownMenu :items="zoomItems" @select="inputScale.setScale(Number($event) / 100)">
							<UiButton
								appearance="ghost"
								icon-only
								:aria-label="t('fileZoom', { percent: Math.round(fileScale * 100) })"
								:title="t('fileZoom', { percent: Math.round(fileScale * 100) })"
								><ZoomIn :size="16"
							/></UiButton>
						</UiDropdownMenu>
						<UiButton
							appearance="ghost"
							icon-only
							:aria-label="t('showHidden')"
							:title="t('showHidden')"
							:aria-pressed="showHidden"
							@click="showHidden = !showHidden"
							><component :is="showHidden ? Eye : EyeOff" :size="16"
						/></UiButton>
					</div>
					<div v-if="!filesOnly" class="workspace-tool-group">
						<UiButton
							appearance="ghost"
							icon-only
							:aria-label="t('filesMenu.terminalToFiles')"
							:title="t('filesMenu.terminalToFiles')"
							:loading="syncing === 'toTerminal'"
							loading-animation="spinner"
							:disabled="!enabled || !connected || !loaded || !!syncing"
							@click="synchronize('toTerminal')"
							><Terminal :size="16"
						/></UiButton>
						<UiButton
							appearance="ghost"
							icon-only
							:aria-label="t('filesMenu.filesToTerminal')"
							:title="t('filesMenu.filesToTerminal')"
							:loading="syncing === 'fromTerminal'"
							loading-animation="spinner"
							:disabled="!enabled || !connected || !!syncing"
							@click="synchronize('fromTerminal')"
							><FolderSync :size="16"
						/></UiButton>
					</div>
				</template>
				<Teleport v-if="searchExpanded && (!filesOnly || searchDock)" :to="searchDock" :disabled="!filesOnly">
					<form
						class="workspace-file-search"
						role="search"
						:aria-label="t('searchFiles')"
						@submit.prevent="browserSearch.search()"
						@keydown.esc.stop.prevent="closeSearch"
					>
						<UiInput
							v-model="search"
							type="search"
							:aria-label="t('searchFiles')"
							:placeholder="t('searchFiles')"
							autocomplete="off"
							@keydown.enter="submitSearch"
						>
							<template #leading>
								<UiButton
									class="workspace-file-search-action workspace-file-search-submit"
									type="submit"
									appearance="ghost"
									icon-only
									:aria-label="t('searchFiles')"
									:title="t('searchFiles')"
									:disabled="!search.trim()"
									:loading="searching"
									><Search :size="15"
								/></UiButton>
							</template>
							<template #trailing>
								<UiButton
									class="workspace-file-search-action"
									appearance="ghost"
									icon-only
									:aria-label="t(search ? 'clearSearch' : 'closeSearch')"
									:title="t(search ? 'clearSearch' : 'closeSearch')"
									@click="clearSearch"
									><X :size="15"
								/></UiButton>
							</template>
						</UiInput>
					</form>
				</Teleport>
				<div class="workspace-tool-group">
					<PathFavorites
						:path="path"
						:enabled="enabled && loaded"
						:i18n="i18n"
						@navigate="files.load($event)"
					/>
				</div>
			</div>
		</div>
		<p v-if="browserSearch.active.value && truncated" class="workspace-search-limit">
			{{ t('searchTruncated') }}
		</p>
		<component
			:is="fileList"
			:entries="visibleRows"
			:selected-paths="selectedPaths"
			:cut-paths="cutPaths"
			:files-only="filesOnly"
			:enabled="enabled"
			:busy="loading || searching"
			:menu-disabled="!enabled || !loaded || directoryChanging || mutating"
			:menu-items="entryItems(context)"
			:empty-title="
				loaded &&
				!rows.length &&
				!searching &&
				(!browserSearch.active.value || browserSearch.entries.value !== undefined)
					? t(browserSearch.active.value ? 'noFilesMatch' : 'emptyDirectory')
					: undefined
			"
			:file-scale-style="fileScaleStyle"
			:locale="i18n.language.value"
			:t="t"
			:is-parent="isParent"
			:display-name="displayName"
			:size="size"
			:modified-date="(time: number) => modifiedDate.format(time)"
			@menu="menuAction($event, context)"
			@select="select"
			@open="doubleClick"
			@enter="activateWithKeyboard"
			@context="context = $event"
			@prepare="prepareContext"
			@prefetch="prefetchEntry"
			@cancel-prefetch="files.cancelPrefetch"
		>
			<template #icon="{ entry }"><FileIcon :name="entry.name" :kind="entry.kind" /></template>
		</component>
		<footer v-if="filesOnly && loaded" class="workspace-file-status">
			<span>{{
				t(selectedEntries.length ? 'filesMenu.selected' : 'fileCount', {
					count: selectedEntries.length || rows.length,
				})
			}}</span>
			<div ref="searchDock" class="workspace-file-status-search" />
		</footer>
		<div v-if="isOverDropZone && enabled && loaded && !busy" class="workspace-file-drop" aria-hidden="true">
			<Upload :size="30" /><span>{{ t('dropFiles') }}</span>
		</div>
	</section>
	<FileOperationDialogs :operations="operations" :busy="mutating" :i18n="i18n" :session-id="sessionId" />
</template>
<style scoped>
	.workspace-files {
		position: relative;
		container: file-pane / inline-size;
		overflow: hidden;
		background: var(--ui-surface);
	}
	.workspace-file-header {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
	}
	.workspace-file-header:has(.workspace-file-search) {
		grid-template-columns: minmax(0, 1fr) minmax(260px, 42%);
	}
	.workspace-file-tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.workspace-file-search {
		flex: 1;
		min-width: 0;
	}
	.workspace-file-search :deep(.ui-input) {
		--ui-input-height: var(--workspace-control-height);
		--ui-control-padding-inline: 3px;
		--ui-control-gap: 5px;
		--ui-control-radius: 6px;
		--ui-input-font-size: 13px;
		background: color-mix(in srgb, var(--ui-text) 3%, var(--ui-surface));
	}
	.workspace-file-search :deep(.ui-input:focus-within) {
		background: var(--ui-surface);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--ui-primary) 12%, transparent);
	}
	.workspace-file-search :deep(input::-webkit-search-cancel-button) {
		appearance: none;
	}
	.workspace-file-search .workspace-file-search-action {
		--ui-button-height: calc(var(--workspace-control-height) - 8px);
		--ui-button-radius: 4px;
		--ui-button-text: var(--ui-muted);
	}
	.workspace-file-search .workspace-file-search-submit {
		--ui-button-text: var(--ui-primary);
	}
	.workspace-file-search .workspace-file-search-submit:disabled:not([aria-busy]) {
		opacity: 1;
	}
	@container file-pane (max-width: 610px) {
		.workspace-file-header,
		.workspace-file-header:has(.workspace-file-search) {
			grid-template-columns: minmax(0, 1fr);
			gap: 6px;
		}
	}
	@container file-pane (max-width: 345px) {
		.workspace-file-tools {
			gap: 4px;
		}
		.workspace-file-tools .workspace-file-upload {
			--ui-button-padding-inline: 0px;
		}
		.workspace-file-upload-label {
			display: none;
		}
	}
	[data-files-only] .workspace-file-header {
		padding: 11px 14px;
		border-bottom: 0;
		background: var(--ui-surface);
	}
	.workspace-file-status {
		display: flex;
		align-items: center;
		justify-content: space-between;
		flex: none;
		gap: 10px;
		min-block-size: 36px;
		padding: 4px 15px;
		color: var(--ui-muted);
		font-size: 11px;
	}
	.workspace-file-status > span {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.workspace-file-status-search {
		--workspace-control-height: 28px;

		display: flex;
		flex: 0 1 320px;
		justify-content: flex-end;
		min-width: 0;
	}
	.workspace-file-status-search .workspace-file-search-trigger {
		--ui-button-height: var(--workspace-control-height);
		--ui-button-text: var(--ui-muted);
	}
	@container file-pane (max-width: 610px) {
		[data-files-only] .workspace-file-header {
			padding: 10px;
		}
	}
	.workspace-file-drop {
		position: absolute;
		inset: 6px;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 12px;
		border: 2px dashed var(--ui-primary);
		border-radius: 12px;
		background: color-mix(in srgb, var(--ui-surface) 92%, transparent);
		color: var(--ui-primary);
		pointer-events: none;
		z-index: 2;
	}
	.workspace-search-limit {
		margin: 0;
		padding: 5px 10px;
		font-size: 11px;
		color: var(--ui-muted);
	}
</style>
