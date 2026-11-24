import { expect, it } from 'vitest';
import { ref } from 'vue';
import type { SessionInfo } from '../src/shared/workspace-types';
import { summarizeWorkspaceSessions } from '../src/browser/workspace-tile-state';
import { createWorkspaceI18n, workspaceTitle } from '../src/browser/workspace-i18n';

it('summarizes confirmed session states and active transfers without inventing sessions', () => {
	const items = [
		{ state: 'attached', transfers: 2 },
		{ state: 'attached', transfers: 0 },
		{ state: 'suspended', transfers: 0 },
		{ state: 'disconnected', transfers: 0 },
	] as SessionInfo[];
	expect(summarizeWorkspaceSessions(items)).toEqual({ attached: 2, suspended: 1, disconnected: 1, transfers: 2 });
	expect(summarizeWorkspaceSessions([])).toEqual({ attached: 0, suspended: 0, disconnected: 0, transfers: 0 });
});

it('uses the same localized title for host contributions and live tile text', () => {
	const locale = ref('en');
	const i18n = createWorkspaceI18n(locale);
	try {
		expect(workspaceTitle()).toBe('Workspace');
		expect(i18n.title.value).toBe(workspaceTitle(locale.value));
		expect(i18n.t('tile.attached')).toBe('Connected');
		locale.value = 'zh';
		expect(i18n.title.value).toBe('连接空间');
		expect(workspaceTitle('zh-CN')).toBe(i18n.title.value);
		expect(i18n.t('tile.attached')).toBe('已连接');
	} finally {
		i18n.dispose();
	}
});
