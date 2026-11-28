import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { CredentialSchema } from '../../credentials/src/shared/credentials-types.js';
import { startBrowser } from '../../test/tests/browser-session.js';
import { pluginFixture, startHost } from '../../test/tests/host.js';
import { startWorkspaceSsh } from '../../workspace/tests/fixtures/workspace-ssh.js';
import { decodeText, encodeText, UnrepresentableTextError } from '../src/browser/text-encoding.js';

const api = (plugin: string) => '/api/plugins/' + encodeURIComponent('@nexus-terminal/' + plugin);

test('encoded text preserves Unicode signatures and automatically opens legacy text', async () => {
	const text = '路径：文件 ✨\r\nsecond line';
	for (const encoding of ['utf-8', 'utf-16le', 'utf-16be'] as const) {
		const bytes = await encodeText(text, encoding, true);
		assert.deepEqual(await decodeText(bytes.buffer, 'auto'), { text, encoding, bom: true });
	}
	const gbk = Uint8Array.of(0xd6, 0xd0, 0xce, 0xc4).buffer;
	assert.deepEqual(await decodeText(gbk, 'auto'), { text: '中文', encoding: 'gb18030', bom: false });
	assert.equal((await decodeText(gbk, 'gb18030')).text, '中文');
	await assert.rejects(decodeText(gbk, 'utf-8'));
	const misdetectedGbk = Uint8Array.of(0x93, 0xed, 0xd9, 0xf1, 0x8f, 0xf0).buffer;
	await assert.rejects(decodeText(misdetectedGbk, 'shift_jis'));
	assert.deepEqual(await decodeText(misdetectedGbk, 'auto'), { text: '擁亳忦', encoding: 'gb18030', bom: false });
	await assert.rejects(decodeText(Uint8Array.of(0, 1, 2).buffer, 'auto'), /Binary file/);
});

test('write back uses the selected codec and rejects lossy substitutions', async () => {
	for (const [encoding, text, hex] of [
		['gbk', '中文', 'd6d0cec4'],
		['gb18030', '中文', 'd6d0cec4'],
		['big5', '中文', 'a4a4a4e5'],
		['shift_jis', '日本', '93fa967b'],
		['windows-1252', 'café €', '636166e92080'],
	] as const) {
		const bytes = await encodeText(text, encoding, false);
		assert.equal(Buffer.from(bytes).toString('hex'), hex);
		assert.equal((await decodeText(bytes.buffer, encoding)).text, text);
	}
	const supplementary = await encodeText('中文😀', 'gb18030', false);
	assert.equal((await decodeText(supplementary.buffer, 'gb18030')).text, '中文😀');
	await assert.rejects(encodeText('中文😀', 'gbk', false), UnrepresentableTextError);
	await assert.rejects(encodeText('中文', 'windows-1252', false), UnrepresentableTextError);
});

test(
	'File Manager and Workspace use the same file presentation and open tabs with encoding controls',
	{ timeout: 55_000 },
	async () => {
		await using resources = new AsyncDisposableStack();
		const directory = await mkdtemp(join(tmpdir(), 'nexus-file-manager-'));
		resources.defer(() => rm(directory, { recursive: true, force: true }));
		await writeFile(join(directory, 'fixture.json'), '{\n  "project": {\n    "name": "nexus"\n  }\n}\n');
		await writeFile(join(directory, 'legacy.txt'), Uint8Array.of(0x93, 0xed, 0xd9, 0xf1, 0x8f, 0xf0));
		const gbkFixture = Buffer.from('d6d0cec40d0a41', 'hex');
		await writeFile(join(directory, 'explicit.gbk'), gbkFixture);
		await mkdir(join(directory, 'nested'));
		const server = await startWorkspaceSsh(resources, directory);
		const host = await startHost(resources, '@nexus-terminal/file-manager', [
			...['ssh', 'credentials', 'connections', 'remote-tools', 'workspace'].map((name) =>
				pluginFixture(new URL('../../' + name + '/', import.meta.url), '@nexus-terminal/' + name),
			),
			pluginFixture(new URL('../', import.meta.url), '@nexus-terminal/file-manager'),
		]);
		const credential = CredentialSchema.parse(
			await host.json(
				api('credentials') + '/credentials',
				{
					credential: {
						name: 'SSH fixture',
						username: 'fixture',
						password: 'fixture-only',
						type: 'password',
					},
				},
				'POST',
				201,
			),
		);
		await host.json(
			api('connections') + '/connections',
			{
				connection: {
					name: 'Test files',
					type: 'ssh',
					host: 'sdk-repository.test',
					port: server.port,
					credentialId: credential.id,
				},
			},
			'POST',
			201,
		);
		const { page, origin } = await startBrowser(resources, host.origin, {
			viewport: { width: 1440, height: 900 },
			locale: 'en-US',
		});
		await page.goto(origin);
		await page.getByLabel('Username', { exact: true }).fill('owner');
		await page.getByLabel('Password', { exact: true }).fill('sdk-fixture-password');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();

		const launch = (id: string) =>
			page
				.locator('[data-tile="@nexus-terminal/' + id + ':applications:main"]')
				.getByRole('button')
				.click();

		await launch('file-manager');
		await expect(page.locator('[data-tile="@nexus-terminal/file-manager:applications:preview"]')).toHaveCount(0);
		const files = page.getByRole('region', { name: 'File Manager', exact: true });
		await files.getByRole('button', { name: 'Test files', exact: true }).click();
		await page.getByRole('button', { name: 'Trust and connect' }).click();
		await expect(files.locator('.workspace-file-row').first()).toHaveCSS('display', 'grid');
		const searchDock = files.locator('.workspace-file-status-search');
		const searchButton = searchDock.getByRole('button', { name: 'Search this folder and subfolders' });
		await searchButton.click();
		const search = searchDock.getByRole('searchbox', { name: 'Search this folder and subfolders' });
		await expect(search).toBeFocused();
		await search.fill('fixture.json');
		await expect(files.getByRole('button', { name: 'fixture.json', exact: true })).toBeVisible();
		await expect(files.getByRole('button', { name: 'nested', exact: true })).toHaveCount(0);
		await search.press('Escape');
		await expect(searchButton).toBeFocused();
		await files.getByRole('button', { name: 'nested', exact: true }).click();
		const parent = files.getByRole('button', { name: 'Parent directory', exact: true });
		await expect(parent.locator('.workspace-file-icon')).toHaveAttribute('data-file-icon', 'parent');
		await expect(parent).toHaveText('..');
		await parent.click();
		await files.getByRole('button', { name: 'fixture.json', exact: true }).dblclick();
		const json = page.getByRole('region', { name: 'fixture.json', exact: true }).last();
		await expect(json.locator('.view-lines')).toContainText('"project"');
		await expect(json.locator('.monaco-editor')).toHaveClass(/\bvs-dark\b/);
		await expect(json.locator('.view-lines')).toHaveCSS('font-size', '14px');
		await json.getByRole('button', { name: 'Zoom · 100%', exact: true }).click();
		await page.getByRole('menuitem', { name: 'Zoom in', exact: true }).click();
		await expect(json.locator('.view-lines')).toHaveCSS('font-size', '15.4px');
		await expect(json.locator('.codicon-folding-expanded').first()).toHaveCSS('opacity', '1');
		await json.locator('.codicon-folding-expanded').first().click();
		await expect(json.locator('.view-lines')).not.toContainText('"name"');
		await json.locator('.codicon-folding-collapsed').first().click();
		await expect(json.locator('.view-lines')).toContainText('"name"');
		await json.getByRole('button', { name: 'Find in file', exact: true }).click();
		const find = json.locator('.find-widget .find-part textarea');
		await expect(find).toBeFocused();
		await find.fill('project');
		await expect(json.locator('.find-widget .matchesCount')).toHaveText('1 of 1');
		await find.press('Escape');
		await json.getByRole('button', { name: 'Preview', exact: true }).click();
		await json.locator('.view-lines').click();
		await page.keyboard.insertText('read-only-check');
		await expect(json.locator('.view-lines')).not.toContainText('read-only-check');
		await page.setViewportSize({ width: 320, height: 800 });
		const footer = json.locator('.file-preview__footer');
		const more = footer.getByRole('button', { name: 'More file actions' });
		await expect(more).toBeVisible();
		await expect(footer.getByRole('combobox', { name: 'File encoding' })).toBeInViewport();
		const singleRow = await footer.evaluate((element) => {
			const [info, tools] = Array.from(element.children, (child) => child.getBoundingClientRect());
			return Math.abs(info.top + info.height / 2 - tools.top - tools.height / 2) < 1;
		});
		assert.ok(singleRow);
		await more.click();
		await expect(page.getByRole('menuitem', { name: 'Download' })).toBeVisible();
		await page.getByRole('menuitem', { name: 'Reset zoom · 110%', exact: true }).click();
		await expect(json.locator('.view-lines')).toHaveCSS('font-size', '14px');
		await more.click();
		await page.getByRole('menuitem', { name: 'Find in file' }).click();
		await expect(find).toBeFocused();
		await find.press('Escape');
		await page.setViewportSize({ width: 1440, height: 900 });
		await page
			.locator('.application-window')
			.filter({ has: json })
			.getByRole('button', { name: 'Close application', exact: true })
			.click();
		await files.getByRole('button', { name: 'explicit.gbk', exact: true }).dblclick();
		const explicit = page.getByRole('region', { name: 'explicit.gbk', exact: true }).last();
		await expect(explicit.locator('.view-lines')).toContainText('中文');
		await expect(explicit.getByRole('combobox', { name: 'File encoding' })).toHaveText('GBK');
		await expect(explicit.locator('.file-preview__info')).toHaveText('GBK · CRLF');
		const writes: { hash: string | null; body: Buffer | null }[] = [];
		await page.route(
			(url) => /\/sessions\/[^/]+\/file$/u.test(url.pathname) && url.searchParams.get('path') === '/explicit.gbk',
			async (route) => {
				const request = route.request();
				if (request.method() !== 'PUT') return route.fallback();
				writes.push({
					hash: new URL(request.url()).searchParams.get('expectedHash'),
					body: request.postDataBuffer(),
				});
				// The synthetic SFTP server does not advertise the OpenSSH atomic rename extension.
				await route.fulfill({ status: 204 });
			},
		);
		await explicit.locator('.view-lines').click();
		await page.keyboard.press('Control+End');
		await page.keyboard.insertText('中');
		const save = explicit.getByRole('button', { name: 'Save', exact: true });
		await save.click();
		await expect(explicit.locator('.file-preview__info')).toHaveText('Saved');
		const savedBytes = Buffer.from('d6d0cec40d0a41d6d0', 'hex');
		assert.deepEqual(writes, [{ hash: createHash('sha256').update(gbkFixture).digest('hex'), body: savedBytes }]);
		await explicit.locator('.view-lines').click();
		await page.keyboard.press('Control+End');
		await page.keyboard.insertText('😀');
		await save.click();
		await expect(explicit.locator('.file-preview__info')).toContainText('Some characters cannot be saved');
		await expect(explicit.locator('.view-lines')).toContainText('😀');
		assert.equal(writes.length, 1);

		await launch('workspace');
		const workspace = page.getByRole('region', { name: 'Workspace', exact: true }).first();
		await workspace.getByRole('button', { name: 'Test files', exact: true }).click();
		await workspace.getByRole('button', { name: 'legacy.txt', exact: true }).dblclick();
		const legacy = page.getByRole('region', { name: 'legacy.txt', exact: true }).last();
		await expect(legacy.locator('.view-lines')).toHaveText('擁亳忦');
		await expect(legacy.locator('.file-preview__info')).toContainText('GB18030');
		await legacy.getByRole('combobox', { name: 'File encoding' }).click();
		await page.getByRole('option', { name: 'GB18030', exact: true }).click();
		await expect(legacy.locator('.view-lines')).toHaveText('擁亳忦');
	},
);
