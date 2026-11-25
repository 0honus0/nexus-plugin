import { effectScope, ref } from 'vue';
import type { PluginContextApi } from 'nexus-terminal/browser';
import { expect, it, vi } from 'vitest';
import { useFileSearch } from '../src/browser/files/use-file-search';
import type { FileSearchResult } from '../src/shared/workspace-file-types';

function result(name: string, truncated = false): FileSearchResult {
	return {
		entries: [{ name, path: '/' + name, relativePath: name, kind: 'file', size: 0, mode: 0, modifiedAt: 0 }],
		truncated,
	};
}

it('invalidates displayed results immediately when the search text changes and ignores delayed responses', async () => {
	vi.useFakeTimers();
	const scope = effectScope();
	const controller = new AbortController();
	const json = vi.fn();
	const report = vi.fn();
	const path = ref('/');
	const search = scope.run(() =>
		useFileSearch(
			{ signal: controller.signal, app: { http: { json }, log: { report } } } as unknown as PluginContextApi,
			'fixture',
			path,
			controller.signal,
		),
	)!;
	try {
		json.mockResolvedValueOnce(result('alpha.txt', true));
		search.query.value = 'alpha';
		await search.search();
		expect(search.entries.value).toEqual(result('alpha.txt', true).entries);
		expect(search.truncated.value).toBe(true);
		const delayed = Promise.withResolvers<FileSearchResult>();
		json.mockReturnValueOnce(delayed.promise);
		search.query.value = 'beta';
		expect(search.entries.value).toBeUndefined();
		expect(search.truncated.value).toBe(false);
		expect(search.searching.value).toBe(true);
		const pending = search.search();
		search.query.value = 'gamma';
		json.mockResolvedValueOnce(result('gamma.txt'));
		await vi.advanceTimersByTimeAsync(250);
		delayed.resolve(result('beta.txt', true));
		await pending;
		expect(search.entries.value).toEqual(result('gamma.txt').entries);
		expect(search.truncated.value).toBe(false);
		expect(search.searching.value).toBe(false);
		search.query.value = '';
		expect(search.active.value).toBe(false);
		expect(search.entries.value).toBeUndefined();
		expect(report).not.toHaveBeenCalled();
	} finally {
		scope.stop();
		vi.useRealTimers();
	}
});

it('invalidates results when refreshing the same query and never retains them after a failed refresh', async () => {
	const scope = effectScope();
	const signal = new AbortController().signal;
	const json = vi.fn();
	const report = vi.fn();
	const path = ref('/');
	const search = scope.run(() =>
		useFileSearch(
			{ signal, app: { http: { json }, log: { report } } } as unknown as PluginContextApi,
			'fixture',
			path,
			signal,
		),
	)!;
	try {
		json.mockResolvedValueOnce(result('old.txt', true));
		search.query.value = 'txt';
		await search.search();
		const refresh = Promise.withResolvers<FileSearchResult>();
		json.mockReturnValueOnce(refresh.promise);
		const pending = search.search();
		expect(search.searching.value).toBe(true);
		expect(search.entries.value).toBeUndefined();
		expect(search.truncated.value).toBe(false);
		refresh.reject(new Error('fixture refresh failed'));
		await pending;
		expect(search.searching.value).toBe(false);
		expect(search.entries.value).toBeUndefined();
		expect(report).toHaveBeenCalledOnce();
	} finally {
		scope.stop();
	}
});
