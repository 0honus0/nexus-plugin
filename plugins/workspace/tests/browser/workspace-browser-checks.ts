import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page } from '@playwright/test';
import type { startHost } from '../../../test/tests/host.js';
import { BackgroundSnapshotSchema } from '../../src/shared/workspace-background-types.js';
import { WorkspacePathHistorySchema } from '../../src/shared/workspace-path-history-types.js';
import { TransferTaskSchema } from '../../src/shared/workspace-transfer-types.js';
import { SessionListResponseSchema } from '../../src/shared/workspace-types.js';

type Host = Awaited<ReturnType<typeof startHost>>;

const base = '/api/plugins/' + encodeURIComponent('@nexus-terminal/workspace');

async function exported(page: Page, trigger: Locator, filename: string) {
	// CDP Chrome runs on another OS; Playwright's runner-side artifact directory
	// is unavailable there. Verify the actual Blob and download event instead.
	if (process.env.NEXUS_TEST_CDP) {
		await page.evaluate(() => {
			const create = URL.createObjectURL;
			const capture = {
				content: Promise.resolve(''),

				restore: () => {
					URL.createObjectURL = create;
				},
			};
			URL.createObjectURL = (value) => {
				if (value instanceof Blob) capture.content = value.text();
				return create.call(URL, value);
			};
			Object.assign(window, { __nexusExportCapture: capture });
		});
		try {
			const event = page.waitForEvent('download');
			await trigger.click();
			expect((await event).suggestedFilename()).toBe(filename);
			return await page.evaluate(
				() =>
					(window as unknown as { __nexusExportCapture: { content: Promise<string> } }).__nexusExportCapture
						.content,
			);
		} finally {
			await page.evaluate(() => {
				const target = window as unknown as { __nexusExportCapture?: { restore(): void } };
				target.__nexusExportCapture?.restore();
				delete target.__nexusExportCapture;
			});
		}
	}
	const event = page.waitForEvent('download');
	await trigger.click();
	const download = await event;
	expect(download.suggestedFilename()).toBe(filename);
	const directory = await mkdtemp(join(tmpdir(), 'nexus-download-'));
	try {
		const file = join(directory, 'download');
		await download.saveAs(file);
		return await readFile(file, 'utf8');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

export async function verifyWorkspaceAppearance(page: Page, workspace: Locator, host: Host): Promise<void> {
	await workspace.getByRole('button', { name: 'Terminal settings', exact: true }).click();
	const settings = page.getByRole('dialog', { name: 'Terminal settings', exact: true });
	const terminal = workspace.locator('.workspace-terminal-frame');
	await settings.getByRole('tab', { name: 'Colors', exact: true }).click();
	const colors = settings.locator('.workspace-theme-panel');
	await expect(colors.locator('.workspace-theme-card')).toHaveCount(403);
	await colors.getByRole('button', { name: 'Apply theme · Dracula', exact: true }).click();
	await expect(terminal).toHaveCSS('background-color', 'rgb(40, 42, 54)');

	await colors.locator('input[type=file]').setInputFiles({
		name: 'Browser audit.json',
		mimeType: 'application/json',
		buffer: Buffer.from(JSON.stringify({ background: '#102030', foreground: '#eef4ff' })),
	});
	const custom = colors.locator('.workspace-theme-card').filter({ hasText: 'Browser audit' });
	await custom.getByRole('button', { name: 'Apply theme · Browser audit', exact: true }).click();
	await expect(terminal).toHaveCSS('background-color', 'rgb(16, 32, 48)');
	expect(
		JSON.parse(
			await exported(
				page,
				custom.getByRole('button', { name: 'Export theme', exact: true }),
				'terminal-theme.json',
			),
		),
	).toMatchObject({
		name: 'Browser audit',
		colors: { background: '#102030', foreground: '#eef4ff' },
	});

	await custom.getByRole('button', { name: 'Delete · Browser audit', exact: true }).click();
	await expect(custom).toHaveCount(0);
	await expect
		.poll(
			async () => (await host.json(base + '/catalog')) as { themes: unknown[]; preferences: { theme: unknown } },
		)
		.toMatchObject({ themes: [], preferences: { theme: null } });

	await settings.getByRole('tab', { name: 'Background', exact: true }).click();
	await expect(settings.getByRole('button', { name: /Apply background · /u })).toHaveCount(20);
	await settings.getByRole('button', { name: 'Apply background · Ribbons', exact: true }).click();
	await expect(terminal.locator('iframe.workspace-background-frame')).toHaveAttribute('sandbox', 'allow-scripts');
	const html = '<div>Browser audit background</div>';
	await settings.locator('input[type=file][accept*=".html"]').setInputFiles({
		name: 'Browser audit.html',
		mimeType: 'text/html',
		buffer: Buffer.from(html),
	});
	const editor = page.getByRole('dialog', { name: 'New background', exact: true });
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toHaveCount(0);
	await settings.getByRole('button', { name: 'Apply background · Browser audit', exact: true }).click();
	await expect(
		terminal.frameLocator('iframe.workspace-background-frame').getByText('Browser audit background'),
	).toBeVisible();
	await expect
		.poll(async () => BackgroundSnapshotSchema.parse(await host.json(base + '/appearance')).settings.enabled)
		.toBe(true);
	expect(
		await exported(
			page,
			settings.getByRole('button', { name: 'Export background · Browser audit', exact: true }),
			'terminal-background.html',
		),
	).toBe(html);
	await settings.getByRole('button', { name: 'Delete · Browser audit', exact: true }).click();
	await expect(settings.getByRole('button', { name: 'Apply background · Browser audit', exact: true })).toHaveCount(
		0,
	);
	await expect
		.poll(async () => BackgroundSnapshotSchema.parse(await host.json(base + '/appearance')))
		.toMatchObject({ presets: [], settings: { preset: null } });
	await settings.locator('input[type=file][accept*="image/png"]').setInputFiles({
		name: 'qa.png',
		mimeType: 'image/png',
		buffer: Buffer.from(
			'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
			'base64',
		),
	});
	await expect
		.poll(async () => BackgroundSnapshotSchema.parse(await host.json(base + '/appearance')).image)
		.not.toBeNull();
	await settings.getByRole('button', { name: 'Remove image', exact: true }).click();
	await expect
		.poll(async () => BackgroundSnapshotSchema.parse(await host.json(base + '/appearance')).image)
		.toBeNull();
	await settings.getByRole('button', { name: 'Close', exact: true }).click();
	await expect(settings).toHaveCount(0);
}

export async function verifyQuickCommands(page: Page, workspace: Locator, host: Host, received: () => string) {
	const panel = workspace.locator('.workspace-quick-commands');
	await expect(panel).toBeVisible();
	await panel.getByRole('button', { name: 'New command', exact: true }).click();
	const editor = page.getByRole('dialog', { name: 'Edit quick command', exact: true });
	await expect(editor.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
	await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('QA greeting');
	await editor.getByRole('textbox', { name: 'Command', exact: true }).fill('echo ${greeting}');
	await editor.getByRole('textbox', { name: 'Tags', exact: true }).fill('QA');
	await editor.getByRole('textbox', { name: 'greeting', exact: true }).fill('default');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(editor).toHaveCount(0);
	const row = panel.getByRole('button', { name: 'Run · QA greeting', exact: true });
	await expect(row).toBeVisible();
	await panel.getByRole('button', { name: 'Show names', exact: true }).click();
	await expect(row).toHaveText('QA greeting');
	await panel.getByRole('button', { name: 'Expand search', exact: true }).click();
	const search = panel.getByRole('searchbox', { name: 'Search names, commands or tags', exact: true });
	await search.fill('not-present');
	await expect(row).toHaveCount(0);
	await search.fill('greeting');
	await expect(row).toBeVisible();
	await search.press('ArrowDown');
	await search.press('Enter');
	const run = page.getByRole('dialog', { name: 'QA greeting', exact: true });
	await expect(run.locator('.workspace-command-preview')).toHaveText('echo default');
	const before = received();
	await run.getByRole('contentinfo').getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(run).toHaveCount(0);
	expect(received()).toBe(before);
	await row.click();
	await run.getByRole('textbox', { name: 'greeting', exact: true }).fill('qa-verified');
	await expect(run.locator('.workspace-command-preview')).toHaveText('echo qa-verified');
	await run.getByRole('button', { name: 'Run', exact: true }).click();
	await expect(run).toHaveCount(0);
	await expect.poll(received).toContain('echo qa-verified');
	await expect
		.poll(
			async () =>
				((await host.json(base + '/catalog')) as { commands: { name: string; usageCount: number }[] }).commands,
		)
		.toEqual([expect.objectContaining({ name: 'QA greeting', usageCount: 1 })]);
	await row.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
	await editor.getByRole('textbox', { name: 'Name', exact: true }).fill('QA edited greeting');
	await editor.getByRole('button', { name: 'Save', exact: true }).click();
	const edited = panel.getByRole('button', { name: 'Run · QA edited greeting', exact: true });
	await expect(edited).toBeVisible();
	await edited.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
	const remove = page.getByRole('dialog', { name: 'Delete command', exact: true });
	const deleted = page.waitForResponse(
		(response) =>
			response.request().method() === 'DELETE' && new URL(response.url()).pathname.includes('/catalog/commands/'),
	);
	await remove.getByRole('contentinfo').getByRole('button', { name: 'Delete', exact: true }).click();
	const deletion = await deleted;
	expect(deletion.status(), await deletion.text()).toBe(200);
	expect(new URL(deletion.url()).searchParams.get('version')).toBe('2');
	await expect(remove).toHaveCount(0);
	await expect(edited).toHaveCount(0);
	await expect
		.poll(async () => ((await host.json(base + '/catalog')) as { commands: unknown[] }).commands)
		.toEqual([]);
}

export async function verifyWorkspacePanels(page: Page, workspace: Locator, host: Host): Promise<void> {
	const status = workspace.locator('.workspace-status-panel');
	await expect(status).toContainText('Server status');
	await expect(status.locator('.metric-row')).toHaveCount(5);
	const metricTrack = status.locator('.metric-track').first();
	const originalStyle = await status.evaluate((element) => {
		const previous = { width: element.style.width, height: element.style.height };
		element.style.width = '250px';
		element.style.height = '310px';
		return previous;
	});
	await expect(metricTrack).toBeVisible();
	const gaps = await status.locator('.metric-row:not(.network-row)').evaluateAll((rows) =>
		rows.map((row) => {
			const header = row.querySelector('.metric-topline')!.getBoundingClientRect();
			const track = row.querySelector('.metric-track')!.getBoundingClientRect();
			return track.top - header.bottom;
		}),
	);
	for (const gap of gaps) expect(gap).toBeCloseTo(9, 0);
	await status.evaluate((element) => {
		element.style.height = '240px';
	});
	await expect(metricTrack).toBeVisible();
	await status.evaluate((element) => {
		element.style.width = '200px';
	});
	await expect(metricTrack).toBeVisible();

	const statusViewport = workspace.locator('.workspace-status-viewport');
	for (let index = 0; index < 2; index++)
		await statusViewport.dispatchEvent('wheel', { ctrlKey: true, deltaY: -250 });
	await expect(status).toHaveAttribute('data-status-scale', '1.60');
	await status.evaluate((element) => {
		Object.assign(element.style, { width: '184px', height: '260px' });
	});
	await expect(metricTrack).toBeVisible();
	await status.evaluate((element) => {
		Object.assign(element.style, { width: '500px', height: '205px' });
	});
	await expect(metricTrack).toBeHidden();
	await status.evaluate((element) => {
		Object.assign(element.style, { width: '112px', height: '240px' });
	});
	await expect(metricTrack).toBeVisible();
	await expect(status.locator('.metric-icon').first()).toBeHidden();
	for (let index = 0; index < 2; index++) await statusViewport.dispatchEvent('wheel', { ctrlKey: true, deltaY: 250 });
	await expect(status).toHaveAttribute('data-status-scale', '1.00');
	await status.evaluate((element, styles) => Object.assign(element.style, styles), originalStyle);
	await status.locator('.metric-row').first().click();
	await expect(status.locator('canvas')).toBeVisible();

	const layout = workspace.getByRole('button', { name: 'Layout', exact: true });
	await layout.click();
	await page.getByRole('menuitem', { name: 'Edit layout', exact: true }).click();
	await expect(workspace.locator('.dv-full-width-single-tab .workspace-pane-grip').first()).toBeVisible();
	await layout.click();
	await page.getByRole('menuitem', { name: 'Finish editing', exact: true }).click();
	await expect(workspace.locator('.workspace-pane-grip')).toHaveCount(0);

	const files = workspace.locator('.workspace-files');
	const entry = files.getByRole('button', { name: 'file.txt', exact: true });
	await expect(entry).toBeVisible();
	const list = files.locator('.workspace-file-list');
	const folder = files.getByRole('button', { name: 'prefetch-fixture', exact: true });
	const prefetchedFile = files.getByRole('button', { name: 'prefetched.txt', exact: true });
	await expect(entry.locator('[data-file-icon="document"] svg')).toBeVisible();
	await expect(folder.locator('[data-file-icon="folder"] svg')).toBeVisible();
	await expect(files.locator('.workspace-file-icon img')).toHaveCount(0);
	const releaseDirectory = Promise.withResolvers<void>();

	const history = async () => WorkspacePathHistorySchema.parse(await host.json(base + '/path-history')).paths;

	await expect.poll(history).toEqual(['/']);
	let reads = 0;
	const directoryRequests = '**/directory?*';
	await page.route(directoryRequests, async (route) => {
		if (new URL(route.request().url()).searchParams.get('path') === '/prefetch-fixture') {
			reads++;
			await releaseDirectory.promise;
		}
		await route.continue();
	});
	try {
		await folder.hover();
		await expect.poll(() => reads).toBe(1);
		await expect(list).toHaveAttribute('aria-busy', 'false');
		expect(await history()).toEqual(['/']);
		await folder.click();
		await expect(list).toHaveAttribute('aria-busy', 'true');
		releaseDirectory.resolve();
		await expect(prefetchedFile).toBeVisible();
		expect(reads).toBe(1);
		await expect.poll(history).toEqual(['/prefetch-fixture', '/']);

		const parent = files.getByRole('button', { name: 'Parent directory', exact: true });
		await parent.click();
		await folder.click();
		await expect(prefetchedFile).toBeVisible();
		expect(reads).toBe(1);
		await files.getByRole('button', { name: 'Refresh directory', exact: true }).click();
		await expect.poll(() => reads).toBe(2);
		await parent.click();
		await expect(entry).toBeVisible();
	} finally {
		releaseDirectory.resolve();
		await page.unroute(directoryRequests);
	}
	const address = files.getByRole('combobox', { name: 'Remote path' });
	const historyButton = files.getByRole('button', { name: 'Path history', exact: true });
	const historyList = page.getByRole('listbox', { name: 'Path history', exact: true });
	const savedFolder = historyList.getByRole('option', { name: '/prefetch-fixture', exact: true });
	await address.click();
	await address.fill('prefetch');
	await expect(savedFolder).toBeVisible();
	const fieldBounds = (await files.locator('.workspace-path-field').boundingBox())!;
	const historyBounds = (await page.locator('.workspace-path-history').boundingBox())!;
	expect(historyBounds.x).toBeCloseTo(fieldBounds.x, 0);
	expect(historyBounds.width).toBeCloseTo(fieldBounds.width, 0);
	await expect(historyList.getByRole('option')).toHaveCount(1);
	await address.press('ArrowDown');
	await expect(savedFolder).toHaveAttribute('aria-selected', 'true');
	await address.press('Enter');
	await expect(prefetchedFile).toBeVisible();
	await expect.poll(history).toEqual(['/prefetch-fixture', '/']);
	await files.getByRole('button', { name: 'Parent directory', exact: true }).click();
	await expect(entry).toBeVisible();
	await historyButton.click();
	await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
	await savedFolder.click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Copy path', exact: true }).click();
	await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('/prefetch-fixture');
	await savedFolder.click({ button: 'right' });
	const removal = page.waitForResponse(
		(response) =>
			response.request().method() === 'DELETE' && new URL(response.url()).pathname.endsWith('/path-history'),
	);
	await page.getByRole('menuitem', { name: 'Remove from history', exact: true }).click();
	const removed = await removal;
	expect(removed.status(), await removed.text()).toBe(204);
	await expect(savedFolder).toHaveCount(0);
	await expect.poll(history).toEqual(['/']);
	await historyButton.click();
	await expect(folder).toBeVisible();
	const toolbar = files.locator('.workspace-file-tools');
	await expect(toolbar.getByRole('button')).toHaveCount(8);
	for (const name of [
		'Upload files',
		'Refresh directory',
		'Search this folder and subfolders',
		'Sort files',
		'Show hidden files',
		'Change terminal to this directory',
		'Follow terminal directory',
		'Favorite paths',
	]) {
		await expect(toolbar.getByRole('button', { name, exact: true })).toHaveAttribute('title', name);
	}
	const follow = toolbar.getByRole('button', { name: 'Follow terminal directory', exact: true });
	const refresh = toolbar.getByRole('button', { name: 'Refresh directory', exact: true });
	const releaseFollow = Promise.withResolvers<void>();
	const directorySync = '**/terminal-directory';
	await page.route(directorySync, async (route) => {
		await releaseFollow.promise;
		await route.fulfill({ json: { path: '/' } });
	});
	try {
		await follow.click();
		await expect(follow).toHaveAttribute('data-loading-animation', 'spinner');
		await expect(follow).toBeDisabled();
		await expect(refresh).not.toHaveAttribute('aria-busy', 'true');
		await expect(entry).toBeVisible();
		releaseFollow.resolve();
		await expect(follow).toBeEnabled();
		await expect(follow).not.toHaveAttribute('data-loading-animation', 'spinner');
		await expect(entry).toBeVisible();
	} finally {
		releaseFollow.resolve();
		await page.unroute(directorySync);
	}
	const favorites = toolbar.getByRole('button', { name: 'Favorite paths' });
	const manageFavorites = page.getByRole('dialog', { name: 'Favorite paths' });
	await favorites.click();
	await page.getByRole('menuitem', { name: 'Fixture path', exact: true }).click();
	await expect(prefetchedFile).toBeVisible();
	await expect(manageFavorites).toHaveCount(0);
	await favorites.click();
	await page.getByRole('menuitem', { name: 'Manage favorite paths', exact: true }).click();
	await expect(manageFavorites).toBeVisible();
	await manageFavorites.getByRole('button', { name: 'Close', exact: true }).click();
	await files.getByRole('button', { name: 'Parent directory', exact: true }).click();
	await expect(entry).toBeVisible();
	const fileSize = entry.locator('.workspace-file-size');
	await expect(fileSize).toBeVisible();
	await files.evaluate((element) => {
		element.style.maxWidth = '250px';
	});
	await expect(fileSize).toBeHidden();
	await expect(entry).toBeVisible();
	await files.evaluate((element) => element.style.removeProperty('max-width'));
	await entry.click();
	const listBounds = (await list.boundingBox())!;
	await list.dispatchEvent('contextmenu', {
		button: 2,
		clientX: listBounds.x + 16,
		clientY: listBounds.y + listBounds.height - 8,
	});
	await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeDisabled();
	await expect(page.getByRole('menuitem', { name: 'Delete', exact: true })).toBeDisabled();
	await expect(page.getByRole('menuitem', { name: 'New file', exact: true })).toBeEnabled();
	await page.keyboard.press('Escape');
	const fileRow = (await entry.boundingBox())!;
	await entry.dispatchEvent('pointerdown', {
		pointerType: 'touch',
		pointerId: 9,
		button: 0,
		buttons: 1,
		clientX: fileRow.x + 12,
		clientY: fileRow.y + 8,
	});
	await expect(page.getByRole('menuitem', { name: 'Rename', exact: true })).toBeVisible();
	await entry.dispatchEvent('pointerup', { pointerType: 'touch', pointerId: 9, button: 0 });
	await page.keyboard.press('Escape');

	await entry.hover();
	await page.mouse.wheel(0, -90);
	await expect(list).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
	await page.keyboard.down('Control');
	try {
		await page.mouse.wheel(0, -90);
	} finally {
		await page.keyboard.up('Control');
	}
	await expect(list).toHaveCSS('transform', 'matrix(1.1, 0, 0, 1.1, 0, 0)');
	await expect.poll(async () => (await entry.boundingBox())!.height).toBeGreaterThan(fileRow.height);
	const ids = SessionListResponseSchema.parse(await host.json(base + '/sessions')).items.map((session) => session.id);
	const divider = workspace
		.locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash:visible')
		.first();
	const pane = workspace.locator('.workspace-terminal-slot');
	const before = (await pane.boundingBox())!.width;
	const bounds = (await divider.boundingBox())!;
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width / 2 + 38, bounds.y + bounds.height / 2, { steps: 8 });
	await page.mouse.up();
	await expect.poll(async () => Math.abs((await pane.boundingBox())!.width - before)).toBeGreaterThan(5);
	for (const width of [470, 1600]) {
		await page.setViewportSize({ width, height: 1000 });
		await expect(workspace.locator('.xterm')).toBeVisible();
		if (width === 470) {
			await workspace.getByRole('button', { name: 'Files', exact: true }).click();
			const sheet = page.getByRole('dialog', { name: 'Files', exact: true });
			await sheet.getByRole('button', { name: 'Path history', exact: true }).click();
			await sheet.getByRole('option', { name: '/', exact: true }).click();
			await expect(sheet.getByRole('combobox', { name: 'Remote path' })).toHaveValue('/');
			await sheet.getByRole('button', { name: 'Close', exact: true }).click();
		}
		expect(
			SessionListResponseSchema.parse(await host.json(base + '/sessions')).items.map((session) => session.id),
		).toEqual(ids);
	}
	await expect(list).toHaveCSS('transform', 'matrix(1.1, 0, 0, 1.1, 0, 0)');
}

export async function verifyWorkspaceSessionPresentation(
	page: Page,
	workspace: Locator,
	host: Host,
	pauseStatus: () => () => void,
): Promise<string> {
	const active = workspace.locator('.workspace-tab-panel[data-state="active"]');
	const files = active.locator('.workspace-file-list');
	const terminal = active.locator('.workspace-terminal-slot');
	const terminalRows = terminal.locator('.xterm-rows');
	const commands = active.locator('[data-pane="commands"]');
	const address = active.getByRole('button', { name: 'Copy server address: sdk-repository.test' });

	const width = async () => (await terminal.boundingBox())!.width;

	const session = SessionListResponseSchema.parse(await host.json(base + '/sessions')).items[0];
	const profile = await active.locator('.workspace-surface').getAttribute('data-profile');

	await workspace.getByRole('button', { name: 'New session', exact: true }).click();
	await workspace.getByRole('button', { name: 'Workspace test SSH', exact: true }).click();
	const first = workspace.getByRole('tab', { name: 'Workspace test SSH · 1', exact: true });
	const second = workspace.getByRole('tab', { name: 'Workspace test SSH · 2', exact: true });
	await expect(second).toHaveAttribute('aria-selected', 'true');
	await expect(address).toBeVisible();
	await expect(files).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
	const secondWidth = await width();

	const releaseStatus = pauseStatus();
	try {
		await first.click();
		await expect(address).toBeVisible();
		await expect(active.locator('.metric-row')).toHaveCount(5);
	} finally {
		releaseStatus();
	}
	await expect(files).toHaveCSS('transform', 'matrix(1.1, 0, 0, 1.1, 0, 0)');
	const before = await width();
	const divider = active
		.locator('.dv-split-view-container.dv-horizontal > .dv-sash-container > .dv-sash:visible')
		.first();
	const bounds = (await divider.boundingBox())!;
	await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
	await page.mouse.down();
	await page.mouse.move(bounds.x + bounds.width / 2 - 30, bounds.y + bounds.height / 2, { steps: 6 });
	await page.mouse.up();
	await expect.poll(async () => Math.abs((await width()) - before)).toBeGreaterThan(5);
	const firstWidth = await width();

	await second.click();
	await expect.poll(width).toBeCloseTo(secondWidth, 0);
	await first.click();
	await expect.poll(width).toBeCloseTo(firstWidth, 0);
	await expect(commands).toBeVisible();
	await workspace.getByRole('button', { name: 'Layout', exact: true }).click();
	await page.getByRole('menuitem', { name: 'Quick commands', exact: true }).click();
	await expect(commands).toHaveCount(0);
	await second.click();
	await expect(commands).toHaveCount(0);
	await expect.poll(width).toBeCloseTo(secondWidth, 0);
	await expect(files).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');

	await first.click();
	await expect(commands).toHaveCount(0);
	await expect(files).toHaveCSS('transform', 'matrix(1.1, 0, 0, 1.1, 0, 0)');
	const suspendedWidth = await width();
	const fontSize = await terminalRows.evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
	await active.locator('.workspace-terminal').dispatchEvent('wheel', { ctrlKey: true, deltaY: -90 });
	await expect(terminalRows).toHaveCSS('font-size', `${fontSize + 1}px`);
	const markPath = base + '/sessions/' + session.id + '/mark';

	// Mutations made outside the window must still arrive via the shared topic
	// after the desktop tile has been remounted by the viewport changes above.
	await host.json(markPath, { marked: true }, 'PATCH');
	await expect(first).toHaveAttribute('aria-description', 'Marked for suspend');
	await host.json(markPath, { marked: false }, 'PATCH');
	await expect(first).toHaveAttribute('aria-description', 'Connected');

	async function setMark(marked: boolean, tab: Locator) {
		await tab.click({ button: 'right' });
		const response = page.waitForResponse(
			(value) => new URL(value.url()).pathname === markPath && value.request().method() === 'PATCH',
		);
		await page.getByRole('menuitem', { name: marked ? 'Mark for suspend' : 'Unmark suspend', exact: true }).click();
		const result = await response;
		expect(result.status(), await result.text()).toBe(200);
		expect(await result.json()).toMatchObject({ id: session.id, state: 'attached', markedForSuspend: marked });
		expect(
			SessionListResponseSchema.parse(await host.json(base + '/sessions')).items.find(
				(item) => item.id === session.id,
			),
		).toMatchObject({ state: 'attached', markedForSuspend: marked });
		await expect(tab).toHaveAttribute('aria-description', marked ? 'Marked for suspend' : 'Connected');
	}

	await setMark(true, first);
	await expect(active.locator('.xterm')).toBeVisible();
	const release = page.waitForResponse(
		(value) =>
			new URL(value.url()).pathname === base + '/sessions/' + session.id + '/release' &&
			value.request().method() === 'POST',
	);
	await workspace.getByRole('button', { name: 'Close tab Workspace test SSH · 1', exact: true }).click();
	const released = await release;
	expect(released.status(), await released.text()).toBe(204);
	await expect(first).toHaveCount(0);
	await workspace.getByRole('button', { name: 'New session', exact: true }).click();
	const resume = workspace.getByRole('button', { name: 'Resume · Workspace test SSH', exact: true });
	const suspended = SessionListResponseSchema.parse(await host.json(base + '/sessions')).items.find(
		(item) => item.id === session.id,
	);
	expect(suspended).toMatchObject({
		state: 'suspended',
		presentation: { [profile!]: { scales: { files: 1.1, terminal: fontSize + 1 } } },
	});
	await expect(resume).toBeVisible();
	await resume.click();
	await expect.poll(width, { message: JSON.stringify(suspended?.presentation) }).toBeCloseTo(suspendedWidth, 0);
	await expect(files).toHaveCSS('transform', 'matrix(1.1, 0, 0, 1.1, 0, 0)');
	await expect(terminalRows).toHaveCSS('font-size', `${fontSize + 1}px`);
	await expect(commands).toHaveCount(0);
	const resumedTab = workspace.getByRole('tab', { selected: true });
	await expect(resumedTab).toHaveAttribute('aria-description', 'Marked for suspend');
	await setMark(false, resumedTab);
	const resumedLabel = await resumedTab.innerText();
	const closed = page.waitForResponse(
		(value) =>
			new URL(value.url()).pathname === base + '/sessions/' + session.id + '/release' &&
			value.request().method() === 'POST',
	);
	await workspace.getByRole('button', { name: 'Close tab ' + resumedLabel.trim(), exact: true }).click();
	const closeResponse = await closed;
	expect(closeResponse.status(), await closeResponse.text()).toBe(204);
	await expect(workspace.getByRole('tab', { name: 'Workspace test SSH', exact: true })).toHaveAttribute(
		'aria-selected',
		'true',
	);
	await expect(workspace.getByRole('button', { name: 'Close tab Workspace test SSH', exact: true })).toBeVisible();
	const remaining = SessionListResponseSchema.parse(await host.json(base + '/sessions')).items;
	expect(remaining.some((item) => item.id === session.id)).toBe(false);
	expect(remaining).toEqual([
		expect.objectContaining({ connectionId: session.connectionId, state: 'attached', terminal: 'running' }),
	]);
	return remaining[0].id;
}

export async function verifyTerminalSelection(workspace: Locator): Promise<void> {
	const terminal = workspace.locator('.workspace-terminal');
	const row = terminal.locator('.xterm-rows > div').filter({ hasText: 'audit selectable' }).first();
	await expect(row).toBeVisible();
	const { x, y, height } = (await row.boundingBox())!;
	await terminal.evaluate(
		(element, point) => {
			const touch = { identifier: 1, target: element, clientX: point.x, clientY: point.y };
			const event = new Event('touchstart', { bubbles: true, cancelable: true });
			Object.defineProperties(event, {
				touches: { value: [touch] },
				targetTouches: { value: [touch] },
				changedTouches: { value: [touch] },
			});
			element.dispatchEvent(event);
		},
		{ x: x + 10, y: y + height / 2 },
	);
	await expect(workspace.getByRole('button', { name: 'Adjust selection start', exact: true })).toBeVisible();
	await terminal.evaluate((element) => {
		const event = new Event('touchend', { bubbles: true, cancelable: true });
		Object.defineProperty(event, 'touches', { value: [] });
		element.dispatchEvent(event);
	});
	await expect(workspace.getByRole('button', { name: 'Copy selection', exact: true })).toBeEnabled();
	await workspace.getByRole('button', { name: 'Clear selection', exact: true }).click();
}

/** Operate on disposable remote files through the same controls a user sees. */
export async function verifyFileMutations(page: Page, workspace: Locator, directory: string) {
	const files = workspace.locator('.workspace-files');

	const entry = (name: string) => files.getByRole('button', { name, exact: true });

	const list = files.locator('.workspace-file-list');
	await list.focus();
	await list.press('Control+Shift+n');
	const folder = page.getByRole('dialog', { name: 'New directory', exact: true });
	await folder.getByRole('textbox', { name: 'Name', exact: true }).fill('qa-folder');
	await folder.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(entry('qa-folder')).toBeVisible();
	expect((await stat(join(directory, 'qa-folder'))).isDirectory()).toBe(true);
	await entry('qa-folder').click();
	await expect(entry('Parent directory')).toBeVisible();

	await list.click({ button: 'right', position: { x: 20, y: 60 } });
	await page.getByRole('menuitem', { name: 'New file', exact: true }).click();
	const create = page.getByRole('dialog', { name: 'New file', exact: true });
	await create.getByRole('textbox', { name: 'Name', exact: true }).fill('qa-file.txt');
	await create.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(entry('qa-file.txt')).toBeVisible();
	await entry('qa-file.txt').click();
	await entry('qa-file.txt').press('F2');
	const rename = page.getByRole('dialog', { name: 'Rename', exact: true });
	await rename.getByRole('textbox', { name: 'Name', exact: true }).fill('renamed.txt');
	await rename.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(entry('renamed.txt')).toBeVisible();
	await entry('renamed.txt').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Permissions', exact: true }).click();
	const permissions = page.getByRole('dialog', { name: 'Permissions', exact: true });
	await permissions.getByRole('textbox', { name: 'Permissions (octal)', exact: true }).fill('600');
	await permissions.getByRole('button', { name: 'Save', exact: true }).click();
	await expect(permissions).toHaveCount(0);
	expect((await stat(join(directory, 'qa-folder', 'renamed.txt'))).mode & 0o777).toBe(0o600);

	await entry('renamed.txt').click();
	await entry('renamed.txt').press('Delete');
	const deletion = page.getByRole('dialog', { name: 'Delete', exact: true });
	await expect(deletion).toBeVisible();
	await deletion.getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(entry('renamed.txt')).toBeVisible();
	await entry('renamed.txt').press('Delete');
	await deletion.getByRole('contentinfo').getByRole('button', { name: 'Delete', exact: true }).click();
	await expect(entry('renamed.txt')).toHaveCount(0);
	await expect(stat(join(directory, 'qa-folder', 'renamed.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

	// A same-name file must not be replaced before explicit confirmation.
	const existing = join(directory, 'qa-folder', 'file.txt');
	await writeFile(existing, 'existing bytes');
	await entry('Parent directory').click();
	await entry('file.txt').click();
	await entry('file.txt').press('Control+c');
	await entry('qa-folder').click();
	await files.getByRole('button', { name: 'Refresh directory', exact: true }).click();
	await expect(entry('file.txt')).toBeVisible();
	await list.focus();
	await list.press('Control+v');
	const overwrite = page.getByRole('dialog', { name: 'Replace existing files?', exact: true });
	await expect(overwrite).toBeVisible();
	expect(await readFile(existing, 'utf8')).toBe('existing bytes');
	await overwrite.getByRole('contentinfo').getByRole('button', { name: 'Cancel', exact: true }).click();
	await expect(overwrite).toHaveCount(0);
	expect(await readFile(existing, 'utf8')).toBe('existing bytes');
	await list.focus();
	await list.press('Control+v');
	await expect(overwrite).toBeVisible();
	await overwrite.getByRole('button', { name: 'Continue', exact: true }).click();
	await expect(overwrite).toHaveCount(0);
	await expect.poll(() => readFile(existing, 'utf8')).toBe('example file');

	await entry('Parent directory').click();
	await expect(entry('qa-folder')).toBeVisible();
	await expect(entry('file.txt')).toBeVisible();
	await entry('qa-folder').click({ button: 'right' });
	await page.getByRole('menuitem', { name: 'Delete', exact: true }).click();
	await expect(deletion).toBeVisible();
	const removed = page.waitForResponse(
		(response) =>
			new URL(response.url()).pathname.endsWith('/files/remove') && response.request().method() === 'POST',
	);
	await deletion.getByRole('contentinfo').getByRole('button', { name: 'Delete', exact: true }).click();
	const result = await removed;
	expect(result.request().postDataJSON()).toEqual({ paths: ['/qa-folder'] });
	expect(result.status(), await result.text()).toBe(204);
	await expect(deletion).toHaveCount(0);
	await expect(entry('qa-folder')).toHaveCount(0);
	await expect(stat(join(directory, 'qa-folder'))).rejects.toMatchObject({ code: 'ENOENT' });
	await expect(entry('file.txt')).toBeVisible();
	expect(await readFile(join(directory, 'file.txt'), 'utf8')).toBe('example file');

	// An explicit file picker is usable without drag and drop, including by keyboard.
	const upload = files.getByRole('button', { name: 'Upload files', exact: true });
	const chooser = page.waitForEvent('filechooser');
	await upload.press('Enter');
	await (
		await chooser
	).setFiles([
		{ name: 'qa-upload.txt', mimeType: 'text/plain', buffer: Buffer.from('picker upload') },
		{ name: 'qa-second.txt', mimeType: 'text/plain', buffer: Buffer.from('second upload') },
	]);
	await expect(entry('qa-upload.txt')).toBeVisible();
	await expect(entry('qa-second.txt')).toBeVisible();
	expect(await readFile(join(directory, 'qa-upload.txt'), 'utf8')).toBe('picker upload');
	expect(await readFile(join(directory, 'qa-second.txt'), 'utf8')).toBe('second upload');

	// Search, hidden-file toggle and return to the normal listing.
	await writeFile(join(directory, '.qa-hidden'), 'hidden');
	await files.getByRole('button', { name: 'Refresh directory', exact: true }).click();
	await expect(entry('.qa-hidden')).toHaveCount(0);
	await files.getByRole('button', { name: 'Show hidden files', exact: true }).click();
	await expect(entry('.qa-hidden')).toBeVisible();
	await files.getByRole('button', { name: 'Show hidden files', exact: true }).click();
	await expect(entry('.qa-hidden')).toHaveCount(0);
	await files.getByRole('button', { name: 'Search this folder and subfolders', exact: true }).click();
	const search = files.getByRole('textbox', { name: 'Search this folder and subfolders', exact: true });
	await search.fill('qa-upload');
	await search.press('Enter');
	await expect(entry('qa-upload.txt')).toBeVisible();
	await expect(entry('qa-second.txt')).toHaveCount(0);
	await files.getByRole('button', { name: 'Close search', exact: true }).click();
	await expect(entry('qa-second.txt')).toBeVisible();
}

export async function verifyWorkspaceTransfers(
	page: Page,
	workspace: Locator,
	fixture: {
		sourceId: string;
		destinationId: string;
		directory: string;
		readStarted: Promise<void>;
		releaseRead: () => void;
	},
): Promise<void> {
	const start = async (name: string) => {
		const response = await page.request.post(
			new URL(base + '/sessions/' + fixture.destinationId + '/files/transfer', page.url()).href,
			{
				data: {
					sourceSessionId: fixture.sourceId,
					paths: ['/' + name],
					destination: '/',
					move: false,
					overwrite: false,
				},
			},
		);
		expect(response.status()).toBe(202);
		return TransferTaskSchema.parse(await response.json());
	};

	await workspace.getByRole('button', { name: 'Transfers', exact: true }).click();
	const center = page.getByRole('dialog', { name: /^Transfers(?:\s*\d+)?$/u });
	await start('file.txt');
	await center.getByRole('tab', { name: 'History', exact: true }).click();
	await expect(
		center
			.locator('.workspace-transfer-task[data-state="completed"]')
			.filter({ hasText: 'file.txt' })
			.filter({ hasText: 'Workspace transfer destination' }),
	).toBeVisible();
	expect(await readFile(join(fixture.directory, 'file.txt'), 'utf8')).toBe('example file');

	await center.getByRole('tab', { name: 'Active', exact: true }).click();
	try {
		const task = await start('blocked.txt');
		const pending = center.locator('.workspace-transfer-task').filter({ hasText: 'blocked.txt' });
		let reading = false;
		void fixture.readStarted.then(() => {
			reading = true;
		});
		await expect.poll(() => reading).toBe(true);
		await pending.getByRole('button', { name: 'Task actions', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Cancel transfer', exact: true }).click();
		const confirmation = page.getByRole('dialog', { name: 'Cancel transfer?', exact: true });
		const canceled = page.waitForResponse((response) =>
			response.url().endsWith('/transfers/' + task.id + '/cancel'),
		);
		await confirmation.getByRole('button', { name: 'Cancel transfer', exact: true }).click();
		expect((await canceled).status()).toBe(204);
	} finally {
		fixture.releaseRead();
	}

	await center.getByRole('tab', { name: 'History', exact: true }).click();
	await expect(
		center.locator('.workspace-transfer-task[data-state="canceled"]').filter({ hasText: 'blocked.txt' }),
	).toBeVisible();
	await expect(readFile(join(fixture.directory, 'blocked.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
	await center.getByRole('button', { name: 'Collapse', exact: true }).click();
}
