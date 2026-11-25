import { useWorkspaceTransfers } from './transfers/workspace-transfers';
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import type { PluginContextApi } from 'nexus-terminal/browser';
import { TerminalDirectorySchema } from '../shared/workspace-file-operation-types';
import { DirectorySchema, type FileEntry } from '../shared/workspace-file-types';
import { createDirectoryCache } from './files/directory-cache';
import { useWorkspaceFilesState } from './files/workspace-files-state';
import { createWorkspaceClient } from './workspace-client';

const prefetchDelay = 20;

export function useFiles(
	ctx: PluginContextApi,
	sessionId: string,
	viewSignal: AbortSignal,
	enabled: () => boolean,
	connected: () => boolean,
) {
	const shared = useWorkspaceFilesState();
	const lifetime = new AbortController();
	const signal = AbortSignal.any([viewSignal, ctx.signal, lifetime.signal]);
	const client = createWorkspaceClient(ctx, signal);
	const root = 'sessions/' + sessionId;
	const path = ref('.'),
		entries = shallowRef<FileEntry[]>([]),
		loaded = ref(false),
		loading = ref(false),
		loadingOrigin = ref<'navigation' | 'terminal' | 'background'>(),
		mutating = ref(false);
	let revision = 0,
		appliedRevision = -1;
	const requestedPath = ref(path.value);
	const directoryChanging = computed(() => loading.value && (!loaded.value || requestedPath.value !== path.value));
	let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
	let prefetchTarget: string | undefined;
	let rejectedPrefetchTarget: string | undefined;
	let prefetchRevision = 0;
	const transfers = useWorkspaceTransfers();
	const busy = computed(() => mutating.value);
	const showRefreshLoading = computed(
		() =>
			loading.value &&
			(loadingOrigin.value === 'navigation' || (loadingOrigin.value === 'background' && !loaded.value)),
	);

	const directoryCache = createDirectoryCache(
		(remote, requestSignal) =>
			ctx.app.http.json(root + '/directory?' + new URLSearchParams({ path: remote }), DirectorySchema, {
				signal: requestSignal,
			}),
		signal,
	);

	function cancelPrefetch(): void {
		prefetchRevision++;
		clearTimeout(prefetchTimer);
		prefetchTimer = undefined;
		prefetchTarget = undefined;
	}

	function schedulePrefetch(): void {
		if (prefetchTarget && !prefetchTimer && !signal.aborted) prefetchTimer = setTimeout(runPrefetch, prefetchDelay);
	}

	function runPrefetch(): void {
		prefetchTimer = undefined;
		const target = prefetchTarget;
		if (!target || !enabled() || loading.value || !directoryCache.idle()) return;
		prefetchTarget = undefined;
		if (directoryCache.get(target)) return;
		const current = prefetchRevision;
		void directoryCache
			.read(target)
			.catch(() => {
				if (!signal.aborted && current === prefetchRevision) rejectedPrefetchTarget = target;
			})
			.finally(schedulePrefetch);
	}

	function prefetch(remote: string): void {
		if (
			signal.aborted ||
			!enabled() ||
			loading.value ||
			remote === path.value ||
			remote === rejectedPrefetchTarget ||
			directoryCache.get(remote)
		)
			return;
		clearTimeout(prefetchTimer);
		prefetchTimer = undefined;
		prefetchTarget = remote;
		schedulePrefetch();
	}

	function invalidate(): void {
		cancelPrefetch();
		rejectedPrefetchTarget = undefined;
		directoryCache.invalidate();
		revision++;
		appliedRevision = -1;
		loading.value = false;
		loadingOrigin.value = undefined;
	}

	async function navigate(remote: string, origin: 'navigation' | 'terminal' | 'background' = 'navigation') {
		cancelPrefetch();
		const current = ++revision;
		requestedPath.value = remote;
		const cached = directoryCache.get(remote);
		loadingOrigin.value = origin;
		loading.value = !cached;
		try {
			const value = cached ?? (await directoryCache.read(remote));
			if (current !== revision || signal.aborted) return;
			requestedPath.value = value.path;
			path.value = value.path;
			entries.value = value.entries;
			loaded.value = true;
			appliedRevision = shared.revision.value;
			return value.path;
		} catch (cause) {
			if (current !== revision || signal.aborted) return;
			requestedPath.value = path.value;
			client.report(cause);
		} finally {
			if (current === revision) {
				loading.value = false;
				loadingOrigin.value = undefined;
			}
		}
	}

	async function load(remote?: string) {
		if (!enabled() || signal.aborted) return;
		if (remote === undefined) invalidate();
		return navigate(remote ?? requestedPath.value);
	}

	/** CWD lookup must not supersede a newer directory navigation. */
	async function followTerminal() {
		if (!enabled() || !connected() || signal.aborted) return;
		const current = revision;
		try {
			const { path: remote } = await client.request(
				root + '/terminal-directory',
				'GET',
				undefined,
				TerminalDirectorySchema,
			);
			if (current !== revision || !enabled() || !connected() || signal.aborted) return;
			return navigate(remote, 'terminal');
		} catch (cause) {
			if (current === revision && !signal.aborted) client.report(cause);
		}
	}

	function upload(files: FileList | File[]) {
		transfers?.upload(
			sessionId,
			path.value,
			files,
			false,
			shared.sessions.value.find((item) => item.id === sessionId)?.name,
		);
	}

	function download(entry: FileEntry) {
		return transfers?.download(sessionId, entry.path);
	}

	watch(
		[enabled, connected, shared.revision],
		([active, online, current], [, wasOnline, previous]) => {
			if ((wasOnline && !online) || (previous !== undefined && current !== previous)) invalidate();
			if (!active) cancelPrefetch();
			if (active && online && !signal.aborted && appliedRevision !== current && !loading.value)
				void navigate(requestedPath.value, 'background');
		},
		{ immediate: true, flush: 'sync' },
	);
	onScopeDispose(() => {
		lifetime.abort();
		invalidate();
	});
	return {
		path,
		entries,
		loaded,
		loading,
		directoryChanging,
		showRefreshLoading,
		mutating,
		busy,
		load,
		followTerminal,
		prefetch,
		cancelPrefetch,
		upload,
		download,
	};
}
