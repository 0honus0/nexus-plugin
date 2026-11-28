import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { startBrowser } from '../../test/tests/browser-session.js';
import { backupPath, pluginFixture, setEnabled, startHost, until } from '../../test/tests/host.js';
import { collectBrowserErrors, expectFormFields } from '../../test/tests/browser-checks.js';
import { z } from 'zod';
import { CredentialSchema } from '../../credentials/src/shared/credentials-types.js';
import { ConnectionCatalogSchema, ConnectionSchema } from '../src/shared/connection-types.js';

const pluginId = '@nexus-terminal/connections';
const credentials = '/api/plugins/' + encodeURIComponent('@nexus-terminal/credentials') + '/credentials';
const base = '/api/plugins/' + encodeURIComponent(pluginId);
const connections = base + '/connections';

test(
	'packaged Connections handles profile types, normalized tags and cross-plugin credential references',
	{ timeout: process.env.NEXUS_TEST_CDP ? 120000 : 45000 },
	async () => {
		await using resources = new AsyncDisposableStack();
		const host = await startHost(resources, pluginId, [
			pluginFixture(new URL('../../ssh/', import.meta.url), '@nexus-terminal/ssh'),
			pluginFixture(new URL('../../credentials/', import.meta.url), '@nexus-terminal/credentials'),
			pluginFixture(new URL('../', import.meta.url), pluginId),
		]);

		async function credential(name: string) {
			return CredentialSchema.parse(
				await host.json(
					credentials,
					{
						credential: { name, username: 'user', type: 'password', password: 'fixture-password' },
					},
					'POST',
					201,
				),
			).id;
		}

		const linked = await credential('Linked');
		const spare = await credential('Spare');
		const input = {
			name: 'SSH fixture',
			host: 'example.test',
			type: 'ssh',
			port: 22,
			credentialId: linked,
			tags: ['QA', 'ｑａ'],
		};
		const ssh = ConnectionSchema.parse(await host.json(connections, { connection: input }, 'POST', 201));
		assert.equal(ssh.tags.length, 1);
		for (const [type, port] of [
			['rdp', 3389],
			['vnc', 5900],
		] as const)
			await host.json(
				connections,
				{ connection: { name: type.toUpperCase() + ' fixture', type, port, host: 'example.test' } },
				'POST',
				201,
			);
		const catalog = ConnectionCatalogSchema.parse(await host.json(base + '/catalog'));
		assert.equal(catalog.connections.length, 3);
		assert.equal(catalog.tags[0].count, 1);
		const blocked = await host.json(credentials + '/' + linked, undefined, 'DELETE', 409);
		assert.equal((blocked as { code: string }).code, 'CREDENTIALS_IN_USE');

		// A failed connection write releases the new reservation and retains the original association.
		await host.json(
			connections + '/' + randomUUID(),
			{ connection: { ...input, credentialId: spare } },
			'PUT',
			404,
		);
		assert.equal((await host.request(credentials + '/' + spare, { method: 'DELETE' })).status, 204);

		const password = 'fixture-backup-password';
		const file = z
			.object({ format: z.literal(1), payload: z.string().min(1) })
			.parse(await host.json(backupPath + '/export', { password }));

		const { page, origin } = await startBrowser(resources, host.origin, { locale: 'en-US' });
		const browserErrors = collectBrowserErrors(page);
		page.setDefaultTimeout(8000);
		const requested = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let catalogRequests = 0;
		await page.route('**' + base + '/catalog', async (route) => {
			catalogRequests++;
			requested.resolve();
			await release.promise;
			await route.fallback();
		});
		await page.goto(origin);
		await page.getByRole('textbox', { name: 'Username' }).fill('owner');
		await page.locator('input[type=password]').fill('sdk-fixture-password');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		const tile = page.locator('[data-tile="@nexus-terminal/connections:applications:main"]');
		try {
			await requested.promise;
			await expect(tile).toHaveCount(0);
		} finally {
			release.resolve();
		}
		await expect(tile.locator('.connections-tile__total strong')).toHaveText('3');
		await expect(tile.locator('[data-type="ssh"] strong')).toHaveText('1');

		await page.locator('.dock-reveal').evaluate((button: HTMLElement) => button.click());
		await page.getByRole('button', { name: 'Edit desktop' }).click();
		const sizeButton = tile.locator('.desktop-tile__size');
		await sizeButton.click();
		const size = page.getByRole('dialog', { name: 'Tile size' });
		await size.getByRole('button', { name: '2 × 1', exact: true }).click();
		await size.getByRole('button', { name: 'Close application' }).click();
		const wideCountOffsets: number[][] = [];
		for (const width of [2, 3]) {
			if (width === 3) await tile.getByRole('button', { name: 'Move Connections' }).press('Shift+ArrowRight');
			await expect(sizeButton).toHaveText(width + ' × 1');
			wideCountOffsets.push(
				await tile.locator('.connections-tile').evaluate((element) => {
					const bottom = element.getBoundingClientRect().bottom;
					return [...element.querySelectorAll('.connections-tile__group > strong')].map((count) => {
						const rect = count.getBoundingClientRect();
						return Math.round(bottom - rect.top - rect.height / 2);
					});
				}),
			);
		}
		expect(wideCountOffsets[0]).toHaveLength(3);
		expect(wideCountOffsets[1]).toEqual(wideCountOffsets[0]);

		await sizeButton.click();
		await size.getByRole('button', { name: '1 × 1', exact: true }).click();
		await size.getByRole('button', { name: 'Close application' }).click();
		await page.locator('.dock-reveal').evaluate((button: HTMLElement) => button.click());
		await page.getByRole('button', { name: 'Finish editing' }).click();

		await expect(tile.locator('.connections-tile')).toHaveAttribute('data-shape', 'compact');
		await expect(tile.locator('.connections-tile__groups')).toHaveCount(0);
		await expect(tile.locator('.connections-tile__total strong')).toHaveText('3');
		await tile.getByRole('button', { name: 'Connections', exact: true }).click();
		const app = page.getByRole('region', { name: 'Connections', exact: true }).first();
		await expect(app.getByText('SSH fixture')).toBeVisible();
		await expect(app.getByText('RDP fixture')).toBeVisible();
		await expect(app.getByText('VNC fixture')).toBeVisible();
		for (const type of ['SSH', 'RDP', 'VNC']) {
			const card = app.locator('.connections-card').filter({ hasText: type + ' fixture' });
			await expect(card.getByText(type, { exact: true })).toHaveCount(1);
			await expect(card.getByRole('button', { name: 'Edit connection · ' + type + ' fixture' })).toBeVisible();
			await expect(card.getByRole('button', { name: 'Duplicate · ' + type + ' fixture' })).toBeVisible();
			await expect(card.getByRole('button', { name: 'Delete · ' + type + ' fixture' })).toBeVisible();
			await expect(card.locator('.ui-card__description')).toContainText('example.test');
		}
		const cards = app.locator('.connections-card');
		await expect(cards.getByText(catalog.tags[0].name, { exact: true })).toHaveCount(0);
		const tagFilter = app.getByRole('combobox', { name: 'Tags', exact: true });
		await tagFilter.click();
		await page.getByRole('option', { name: catalog.tags[0].name, exact: true }).click();
		await expect(cards).toHaveCount(1);
		await expect(cards.first()).toContainText('SSH fixture');
		await tagFilter.click();
		await page.getByRole('option', { name: 'All tags', exact: true }).click();
		await expect(cards).toHaveCount(3);

		const search = app.getByRole('textbox', { name: 'Search name, address or username', exact: true });
		await search.fill('user');
		await expect(app.getByText('SSH fixture', { exact: true })).toBeVisible();
		await expect(app.getByText('user@example.test:22', { exact: true })).toBeVisible();
		await expect(app.getByText('RDP fixture', { exact: true })).toHaveCount(0);
		await expect(app.getByText('VNC fixture', { exact: true })).toHaveCount(0);
		await search.clear();
		await expect(app.getByText('RDP fixture', { exact: true })).toBeVisible();
		expect(catalogRequests).toBe(1);

		await app.getByRole('button', { name: 'Add connection', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Add connection' });
		await dialog
			.locator('label[for]')
			.filter({ hasText: /^Tags$/u })
			.click();
		await expect(dialog.getByRole('combobox', { name: 'Tags', exact: true })).toBeFocused();
		await expectFormFields(dialog);
		await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Browser connection');
		await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('browser.example.test');
		await dialog.getByRole('button', { name: 'Use existing', exact: true }).click();
		await dialog.getByRole('button', { name: 'Manage', exact: true }).click();
		const manager = page.getByRole('region', { name: 'Credentials', exact: true });
		await expect(manager).toBeVisible();
		await expect(dialog).toHaveCount(0);
		await manager.getByRole('button', { name: 'Close application' }).click();
		await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('Browser connection');
		await expect(dialog.getByRole('textbox', { name: 'Host', exact: true })).toHaveValue('browser.example.test');
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		const add = app.getByRole('button', { name: 'Add connection', exact: true });
		await expect(add).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(dialog.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('');
		await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Browser connection');
		await dialog.getByRole('textbox', { name: 'Host', exact: true }).fill('browser.example.test');
		await dialog.getByRole('button', { name: 'Tags', exact: true }).click();
		await dialog.getByRole('button', { name: 'Delete tag “' + catalog.tags[0].name + '”' }).click();
		const deleteTag = page.getByRole('dialog', { name: 'Delete tag', exact: true });
		await deleteTag.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(deleteTag).toHaveCount(0);
		await dialog.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(app.getByText('Browser connection')).toBeVisible();
		for (const message of ['Connection saved.', 'Tag deleted.']) {
			const toast = page.locator('[data-ui="toast"]').filter({ hasText: message });
			await toast.locator('.ui-toast__close').click();
			await expect(toast).toHaveCount(0);
		}
		await expect(tile.locator('.connections-tile__total strong')).toHaveText('4');

		// An empty tag catalog must not trap Escape in an invisible overlay.
		await add.click();
		const tags = dialog.getByRole('combobox', { name: 'Tags', exact: true });
		await tags.click();
		await expect(tags).toHaveAttribute('aria-expanded', 'true');
		await expect(dialog.getByRole('status').filter({ hasText: 'No tags available' })).toBeVisible();
		await tags.fill('QA draft tag');
		await dialog.getByRole('option', { name: 'Create “QA draft tag”' }).click();
		await expect(dialog.getByRole('button', { name: 'Deselect “QA draft tag”' })).toBeVisible();
		await dialog.getByRole('button', { name: 'Deselect “QA draft tag”' }).click();
		await tags.click();
		await expect(dialog.getByRole('status').filter({ hasText: 'No tags available' })).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(tags).toHaveAttribute('aria-expanded', 'false');
		await expect(dialog).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(dialog).toHaveCount(0);
		await expect(add).toBeFocused();

		assert.deepEqual(ConnectionSchema.parse(await host.json(connections + '/' + ssh.id)).tags, []);
		assert.equal((await host.request(connections + '/' + ssh.id, { method: 'DELETE' })).status, 204);
		assert.equal((await host.request(credentials + '/' + linked, { method: 'DELETE' })).status, 204);
		await expect(app.getByText('SSH fixture')).toHaveCount(0);

		await app.getByRole('button', { name: 'Close application' }).click();
		await page.getByRole('button', { name: 'Settings', exact: true }).click();
		await page.getByRole('combobox', { name: 'Language' }).click();
		await page.getByRole('option', { name: '简体中文' }).click();
		await page.getByRole('region', { name: '设置', exact: true }).getByRole('button', { name: '关闭应用' }).click();
		await tile.getByRole('button', { name: '连接管理', exact: true }).click();
		const localizedApp = page.getByRole('region', { name: '连接管理', exact: true }).first();
		await localizedApp.getByRole('button', { name: '添加连接', exact: true }).click();
		await page.getByRole('dialog', { name: '添加连接' }).getByRole('button', { name: '关闭', exact: true }).click();
		await localizedApp.getByRole('button', { name: '关闭应用' }).click();
		await expect(localizedApp).toHaveCount(0);
		await expect(tile.getByRole('button', { name: '连接管理', exact: true })).toBeVisible();

		const preview = z
			.object({
				token: z.uuid(),
				tables: z.array(z.object({ pluginId: z.string(), table: z.string(), rows: z.number() })),
			})
			.parse(await host.json(backupPath + '/preview', { password, file }));
		assert.ok(preview.tables.some(({ table, rows }) => table === 'credential_references' && rows === 1));
		assert.ok(preview.tables.some(({ table, rows }) => table === 'connections' && rows === 3));
		const { id: restoreId } = z
			.object({ id: z.uuid() })
			.parse(await host.json(backupPath + '/restore', { password, file, token: preview.token }, 'POST', 202));
		const restore = await until(async () => {
			const { job } = z
				.object({ job: z.object({ id: z.string(), state: z.string() }).nullable() })
				.parse(await host.json(backupPath + '/status'));
			if (job?.id === restoreId && job.state !== 'restoring') return job;
		});
		assert.equal(restore.state, 'succeeded', JSON.stringify(restore));
		const restored = ConnectionSchema.parse(await host.json(connections + '/' + ssh.id));
		assert.equal(restored.credentialId, linked);
		assert.deepEqual(restored.tags, ssh.tags);
		const patched = CredentialSchema.parse(
			await host.json(
				credentials + '/' + linked,
				{
					patch: { name: 'Restored encrypted credential' },
				},
				'PATCH',
			),
		);
		assert.equal(patched.id, linked);
		await host.json(credentials + '/' + linked, undefined, 'DELETE', 409);
		await setEnabled(host, pluginId, false);
		await expect(tile.locator('.connections-tile')).toHaveCount(0);
		expect(browserErrors).toEqual([]);
	},
);
