import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expect } from '@playwright/test';
import { startBrowser } from '../../test/tests/browser-session.js';
import { manager as packageManager, pluginFixture, startHost } from '../../test/tests/host.js';
import { ConnectionSchema } from '../../connections/src/shared/connection-types.js';

const pluginId = '@nexus-terminal/remote-desktop';
const base = '/api/plugins/' + encodeURIComponent(pluginId);
const connections = '/api/plugins/' + encodeURIComponent('@nexus-terminal/connections');

test('packaged desktop registers a launcher and opens the saved VNC profile', { timeout: 45_000 }, async () => {
	await using resources = new AsyncDisposableStack();
	const host = await startHost(resources, pluginId, [
		pluginFixture(new URL('../../ssh/', import.meta.url), '@nexus-terminal/ssh'),
		pluginFixture(new URL('../../credentials/', import.meta.url), '@nexus-terminal/credentials'),
		pluginFixture(new URL('../../connections/', import.meta.url), '@nexus-terminal/connections'),
		pluginFixture(new URL('../', import.meta.url), pluginId),
	]);
	assert.deepEqual(await host.json(base + '/modes'), { guacamole: false });
	const profile = ConnectionSchema.parse(
		await host.json(
			connections + '/connections',
			{
				connection: { name: 'Desktop fixture', type: 'vnc', host: 'example.test', port: 5900 },
			},
			'POST',
			201,
		),
	);

	const browser = await startBrowser(resources, host.origin, { locale: 'en-US' });
	const { page, origin: url } = browser;
	const viewFailures: string[] = [];
	page.on('console', (message) => {
		if (message.text().includes('PLUGIN_VIEW_FAILED')) viewFailures.push(message.text());
	});
	await page.goto(url);
	await page.getByRole('textbox', { name: 'Username' }).fill('owner');
	await page.locator('input[type=password]').fill('sdk-fixture-password');
	await page.getByRole('button', { name: 'Sign in', exact: true }).click();
	await page.getByRole('button', { name: 'Connections', exact: true }).last().click();
	const manager = page.getByRole('region', { name: 'Connections', exact: true }).first();
	await manager.getByRole('button', { name: 'More actions · ' + profile.name, exact: true }).click();
	await page.getByRole('menuitem', { name: 'Open remote desktop', exact: true }).click();
	const desktop = page.getByRole('region', { name: 'Remote Desktop', exact: true });
	await expect(desktop.getByRole('combobox', { name: 'Saved desktop' })).toContainText(profile.name);
	const method = desktop.getByRole('combobox', { name: 'Connection method' });
	await expect(method).toContainText('Native');
	await method.click();
	await expect(page.getByRole('option')).toHaveText(['Native']);
	await page.keyboard.press('Escape');
	const connect = desktop.getByRole('button', { name: 'Connect', exact: true });
	await expect(connect).toBeEnabled();
	await page.clock.install();
	await page.route('**' + base + '/sessions', () => undefined);
	await connect.click();
	await expect(desktop.getByRole('status')).toHaveText('Connecting…');
	await page.clock.fastForward(25_001);
	await expect(desktop.getByRole('alert')).toContainText('did not respond in time');
	await expect(connect).toBeEnabled();
	const impact = (await host.json(
		packageManager + '/plugins/' + encodeURIComponent(pluginId) + '/runtime-impact',
	)) as {
		revision: string;
	};
	await host.operation(packageManager + '/reload', { pluginId, impactRevision: impact.revision });
	await expect(desktop).toHaveCount(0);
	assert.deepEqual(viewFailures, []);
});
