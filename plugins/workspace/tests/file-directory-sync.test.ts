import { effectScope, ref } from 'vue';
import { expect, it, vi } from 'vitest';
import type { PluginContextApi } from 'nexus-terminal/browser';
import type { RemoteDirectory } from '../src/shared/workspace-file-types';
import { useFiles } from '../src/browser/use-files';

const { shared } = vi.hoisted(() => ({ shared: { revision: undefined as unknown, sessions: { value: [] } } }));
vi.mock('../src/browser/files/workspace-files-state', () => ({ useWorkspaceFilesState: () => shared }));
vi.mock('../src/browser/transfers/workspace-transfers', () => ({ useWorkspaceTransfers: () => undefined }));

function fixture() {
	const revision = ref(0);
	shared.revision = revision;
	const online = ref(false);
	const enabled = ref(true);
	const scope = effectScope();
	const json = vi.fn<(path: string, schema: unknown, options: RequestInit) => Promise<unknown>>();
	const report = vi.fn();
	const controller = new AbortController();
	const files = scope.run(() =>
		useFiles(
			{
				signal: controller.signal,
				app: { http: { json }, log: { report } },
			} as unknown as PluginContextApi,
			'test',
			controller.signal,
			() => enabled.value,
			() => online.value,
		),
	)!;
	return { files, json, report, online, enabled, revision, scope };
}

it('keeps the refresh indicator idle while following the terminal and preserves the current path until listing arrives', async () => {
	const f = fixture();
	try {
		f.json.mockResolvedValueOnce({ path: '/old', entries: [] });
		f.online.value = true;
		await vi.waitFor(() => expect(f.files.loaded.value).toBe(true));
		const listing = Promise.withResolvers<RemoteDirectory>();
		f.json.mockResolvedValueOnce({ path: '/new' }).mockReturnValueOnce(listing.promise);
		const pending = f.files.followTerminal();
		await vi.waitFor(() => expect(f.files.loading.value).toBe(true));
		expect(f.files.showRefreshLoading.value).toBe(false);
		expect(f.files.path.value).toBe('/old');
		listing.resolve({ path: '/new', entries: [] });
		await pending;
		expect(f.files.path.value).toBe('/new');
		expect(f.files.loading.value).toBe(false);

		const refresh = Promise.withResolvers<RemoteDirectory>();
		f.json.mockReturnValueOnce(refresh.promise);
		const manual = f.files.load();
		expect(f.files.showRefreshLoading.value).toBe(true);
		refresh.resolve({ path: '/new', entries: [] });
		await manual;
		expect(f.files.showRefreshLoading.value).toBe(false);

		const background = Promise.withResolvers<RemoteDirectory>();
		f.json.mockReturnValueOnce(background.promise);
		f.revision.value++;
		expect(f.files.loading.value).toBe(true);
		expect(f.files.showRefreshLoading.value).toBe(false);
		background.resolve({ path: '/new', entries: [] });
		await vi.waitFor(() => expect(f.files.loading.value).toBe(false));
	} finally {
		f.scope.stop();
	}
});

it('does not let a delayed terminal directory lookup overwrite newer manual navigation', async () => {
	const f = fixture();
	try {
		f.json.mockResolvedValueOnce({ path: '/old', entries: [] });
		f.online.value = true;
		await vi.waitFor(() => expect(f.files.loaded.value).toBe(true));
		const cwd = Promise.withResolvers<{ path: string }>();
		f.json.mockReturnValueOnce(cwd.promise).mockResolvedValueOnce({ path: '/manual', entries: [] });
		const pending = f.files.followTerminal();
		await f.files.load('/manual');
		cwd.resolve({ path: '/late' });
		await pending;
		expect(f.files.path.value).toBe('/manual');
		expect(f.json).toHaveBeenCalledTimes(3);
		expect(f.report).not.toHaveBeenCalled();
	} finally {
		f.scope.stop();
	}
});

it('ignores a terminal directory result after disconnect', async () => {
	const f = fixture();
	try {
		f.json.mockResolvedValueOnce({ path: '/old', entries: [] });
		f.online.value = true;
		await vi.waitFor(() => expect(f.files.loaded.value).toBe(true));
		const cwd = Promise.withResolvers<{ path: string }>();
		f.json.mockReturnValueOnce(cwd.promise);
		const pending = f.files.followTerminal();
		f.online.value = false;
		cwd.resolve({ path: '/late' });
		await pending;
		expect(f.files.path.value).toBe('/old');
		expect(f.json).toHaveBeenCalledTimes(2);
		expect(f.files.loading.value).toBe(false);
	} finally {
		f.scope.stop();
	}
});
