<script setup lang="ts">
	import { computed, ref, watch, nextTick } from 'vue';
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
	import { UiButton, UiInput, UiEmptyState, UiDropdownMenu, UiContextMenu } from 'nexus-terminal/browser/ui';
	import type { UiMenuItem } from 'nexus-terminal/browser/ui';
	import type { PluginContextApi } from 'nexus-terminal/browser';
	import type { PluginWindowApi } from 'nexus-terminal/browser';
	import type { WorkspaceI18n } from './workspace-i18n';
	import type { FileManagerOpenFile } from './file-manager-api.js';
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
		searchExpanded = ref(false),
		showHidden = ref(false),
		sort = ref('name');
	const { style: fileScaleStyle } = usePanePresentation(surface, filesPresentation);
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
		if (mod && key === 'c')
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
				<template v-if="!searchExpanded">
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
						<UiButton
							appearance="ghost"
							icon-only
							:aria-label="t('searchFiles')"
							:title="t('searchFiles')"
							:disabled="!enabled || !loaded"
							@click="showSearch"
							><Search :size="16"
						/></UiButton>
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
				<form
					v-else
					class="workspace-file-search"
					@submit.prevent="browserSearch.search()"
					@keydown.esc.stop.prevent="closeSearch"
				>
					<UiButton
						type="submit"
						appearance="ghost"
						icon-only
						:aria-label="t('searchFiles')"
						:title="t('searchFiles')"
						:loading="searching"
						><Search :size="16"
					/></UiButton>
					<div class="workspace-file-search-input">
						<UiInput v-model="search" :aria-label="t('searchFiles')" :placeholder="t('searchFiles')" />
					</div>
					<UiButton
						appearance="ghost"
						icon-only
						:aria-label="t('closeSearch')"
						:title="t('closeSearch')"
						@click="closeSearch"
						><X :size="16"
					/></UiButton>
				</form>
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
		<div class="workspace-file-viewport">
			<div v-if="filesOnly" class="workspace-file-columns">
				<span>{{ t('sortName') }}</span>
				<span class="workspace-file-size">{{ t('fileSize') }}</span>
				<span class="workspace-file-modified">{{ t('fileModified') }}</span>
			</div>
			<UiContextMenu
				:items="entryItems(context)"
				:disabled="!enabled || !loaded || directoryChanging || mutating"
				@select="menuAction($event, context)"
			>
				<div
					class="workspace-file-list"
					:style="fileScaleStyle"
					:aria-busy="loading || searching"
					tabindex="0"
					@pointerdown.capture="context = undefined"
					@contextmenu.capture="context = undefined"
				>
					<button
						v-for="entry in visibleRows"
						:key="entry.path"
						v-memo="[
							entry,
							selectedPaths.has(entry.path),
							cutPaths.has(entry.path),
							enabled,
							i18n.language.value,
						]"
						class="workspace-file-row"
						:class="{
							'is-parent': isParent(entry),
							'is-directory': entry.kind === 'directory' && !isParent(entry),
							'is-selected': selectedPaths.has(entry.path),
							'is-cut': cutPaths.has(entry.path),
						}"
						:aria-label="isParent(entry) ? t('parentDirectory') : displayName(entry)"
						:aria-pressed="selectedPaths.has(entry.path)"
						:disabled="!enabled"
						@click="select(entry, $event)"
						@dblclick="doubleClick(entry, $event)"
						@keydown.enter="
							(event) => {
								if (isParent(entry)) {
									event.preventDefault();
									up();
								} else if (openFile && entry.kind === 'file') {
									event.preventDefault();
									void activateFile(entry);
								}
							}
						"
						@contextmenu="prepareContext(entry)"
						@pointerdown="context = entry"
						@pointerenter="prefetchEntry(entry, $event)"
						@pointerleave="files.cancelPrefetch"
					>
						<FileIcon v-if="!isParent(entry)" :name="entry.name" :kind="entry.kind" /><span
							class="workspace-file-name"
							:title="displayName(entry)"
							>{{ displayName(entry) }}</span
						><span class="workspace-file-size">{{
							isParent(entry)
								? ''
								: entry.kind === 'directory'
									? filesOnly
										? '—'
										: t('directory')
									: size(entry.size)
						}}</span>
						<span v-if="filesOnly && !isParent(entry)" class="workspace-file-modified">{{
							entry.modifiedAt ? modifiedDate.format(entry.modifiedAt) : '—'
						}}</span>
					</button>
					<UiEmptyState
						class="workspace-panel-empty"
						v-if="
							loaded &&
							!rows.length &&
							!searching &&
							(!browserSearch.active.value || browserSearch.entries.value !== undefined)
						"
						:title="t(browserSearch.active.value ? 'noFilesMatch' : 'emptyDirectory')"
						:icon="Folder"
					/>
				</div>
			</UiContextMenu>
		</div>
		<footer v-if="filesOnly && loaded" class="workspace-file-status">
			{{
				t(selectedEntries.length ? 'filesMenu.selected' : 'fileCount', {
					count: selectedEntries.length || rows.length,
				})
			}}
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
		grid-template-columns: minmax(0, 1fr) minmax(220px, 42%);
	}
	.workspace-file-tools {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-width: 0;
	}
	.workspace-file-search {
		display: flex;
		align-items: center;
		gap: 5px;
		flex: 1;
		min-width: 0;
	}
	.workspace-file-search-input {
		flex: 1;
		min-width: 0;
	}
	.workspace-file-search-input :deep(.ui-input) {
		--ui-control-height: var(--workspace-control-height);
		--ui-input-font-size: 13px;
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
	.workspace-file-viewport {
		flex: 1 1 0;
		min-height: 0;
		overflow: clip;
	}
	.workspace-file-list {
		box-sizing: border-box;
		container: workspace-files / inline-size;
		min-height: 0;
		padding: 4px 6px 8px;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.workspace-file-row {
		display: grid;
		grid-template-columns: 18px minmax(0, 1fr) auto;
		align-items: center;
		gap: 8px;
		width: 100%;
		min-height: 30px;
		border: 0;
		background: transparent;
		color: var(--ui-text);
		font: inherit;
		font-size: 12.5px;
		line-height: 18px;
		text-align: start;
		border-radius: 7px;
		padding: 5px 8px;
		cursor: pointer;
		transition: background-color 120ms ease;
	}
	.workspace-file-row:hover:not(:disabled) {
		background: color-mix(in srgb, var(--ui-text) 5.5%, transparent);
	}
	.workspace-file-row.is-selected {
		background: color-mix(in srgb, var(--ui-primary) 12%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ui-primary) 22%, transparent);
	}
	.workspace-file-row.is-directory .workspace-file-name {
		font-weight: 500;
	}
	.workspace-file-row.is-parent .workspace-file-name {
		grid-column: 2;
		color: var(--ui-muted);
		font-weight: 520;
		letter-spacing: 0.06em;
	}
	.workspace-file-row.is-cut {
		opacity: 0.45;
	}
	.workspace-file-row:focus-visible {
		outline: 2px solid var(--ui-primary);
		outline-offset: -2px;
	}
	.workspace-file-name {
		display: block;
		min-width: 0;
		line-height: 18px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.workspace-file-size {
		color: var(--ui-muted);
		font-size: 11px;
		line-height: 18px;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
		opacity: 0.85;
	}
	.workspace-files[data-files-only] {
		--file-columns: 22px minmax(0, 1fr) 76px 144px;
	}
	[data-files-only] .workspace-file-header {
		padding: 11px 14px;
		border-bottom: 0;
		background: var(--ui-surface);
	}
	[data-files-only] .workspace-file-viewport {
		display: flex;
		flex-direction: column;
		margin: 0 14px;
		border: 1px solid var(--ui-border);
		border-radius: 10px;
	}
	[data-files-only] .workspace-file-columns,
	[data-files-only] .workspace-file-row {
		display: grid;
		grid-template-columns: var(--file-columns);
		align-items: center;
		gap: 8px;
		padding-inline: 12px;
	}
	.workspace-file-columns {
		flex: none;
		min-block-size: 32px;
		border-bottom: 1px solid var(--ui-border);
		background: color-mix(in srgb, var(--ui-text) 4%, var(--ui-surface));
		color: var(--ui-muted);
		font-size: 11px;
		font-weight: 600;
		overflow: hidden;
		scrollbar-gutter: stable;
	}
	.workspace-file-columns > :first-child {
		grid-column: 2;
	}
	[data-files-only] .workspace-file-list {
		flex: 1 1 auto;
		min-height: 0;
		gap: 0;
		padding: 0;
		scrollbar-gutter: stable;
	}
	[data-files-only] .workspace-file-row {
		flex: none;
		min-block-size: 37px;
		border-bottom: 1px solid color-mix(in srgb, var(--ui-border) 70%, transparent);
		border-radius: 0;
	}
	[data-files-only] .workspace-file-size {
		display: block;
		text-align: end;
	}
	.workspace-file-row .workspace-file-modified {
		color: var(--ui-muted);
		font-size: 11px;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.workspace-file-status {
		flex: none;
		min-block-size: 30px;
		padding: 6px 15px;
		color: var(--ui-muted);
		font-size: 11px;
	}
	@container file-pane (max-width: 610px) {
		[data-files-only] .workspace-file-header {
			padding: 10px;
		}
		[data-files-only] .workspace-file-viewport {
			margin-inline: 10px;
		}
	}
	@container file-pane (max-width: 500px) {
		[data-files-only] .workspace-file-columns,
		[data-files-only] .workspace-file-row {
			grid-template-columns: 22px minmax(0, 1fr) 60px;
		}
		.workspace-file-modified {
			display: none;
		}
	}
	@container workspace-files (max-width: 300px) {
		.workspace-file-row {
			grid-template-columns: 18px minmax(0, 1fr);
		}
		.workspace-file-size {
			display: none;
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
