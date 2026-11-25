import { computed, onScopeDispose, ref, watch, type Ref } from 'vue';
import { useTimeoutFn } from '@vueuse/core';
import type { PluginContextApi } from 'nexus-terminal/browser';
import { FileSearchResultSchema, type FileSearchEntry } from '../../shared/workspace-file-types';
import { createWorkspaceClient } from '../workspace-client';

export function useFileSearch(ctx: PluginContextApi, sessionId: string, path: Ref<string>, signal: AbortSignal) {
	const query = ref(''),
		searching = ref(false),
		truncated = ref(false);
	const entries = ref<FileSearchEntry[]>();
	let controller: AbortController | undefined;
	let revision = 0;

	function invalidate() {
		revision++;
		controller?.abort();
		searching.value = false;
		entries.value = undefined;
		truncated.value = false;
	}

	async function search() {
		timer.stop();
		invalidate();
		const text = query.value.trim();
		if (!text || signal.aborted || ctx.signal.aborted) return;
		const current = revision;
		controller = new AbortController();
		const requestSignal = AbortSignal.any([signal, ctx.signal, controller.signal]);
		const client = createWorkspaceClient(ctx, requestSignal);
		searching.value = true;
		try {
			const params = new URLSearchParams({ path: path.value, query: text });
			const result = await client.request(
				`sessions/${sessionId}/files/search?${params}`,
				undefined,
				undefined,
				FileSearchResultSchema,
			);
			if (current !== revision || requestSignal.aborted) return;
			entries.value = result.entries;
			truncated.value = result.truncated;
		} catch (cause) {
			client.report(cause);
		} finally {
			if (current === revision) searching.value = false;
		}
	}

	const timer = useTimeoutFn(
		() => {
			void search();
		},
		250,
		{ immediate: false },
	);
	watch(
		query,
		() => {
			invalidate();
			timer.stop();
			// Results belong to the previous query, not the text being edited.
			if (query.value.trim() && !signal.aborted && !ctx.signal.aborted) {
				searching.value = true;
				timer.start();
			}
		},
		{ flush: 'sync' },
	);

	watch(
		path,
		() => {
			query.value = '';
			timer.stop();
			invalidate();
		},
		{ flush: 'sync' },
	);
	onScopeDispose(() => {
		timer.stop();
		invalidate();
	});
	return {
		query,
		searching,
		truncated,
		entries,
		active: computed(() => !!query.value.trim()),
		search,
	};
}
