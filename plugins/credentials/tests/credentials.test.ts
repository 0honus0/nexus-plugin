import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { chromium, expect } from '@playwright/test';
import { collectBrowserErrors, expectFormFields } from '../../test/tests/browser-checks.js';
import { pluginFixture, startHost } from '../../test/tests/host.js';
import { CredentialSchema, CredentialsSnapshotSchema } from '../src/shared/credentials-types.js';

const pluginId = '@nexus-terminal/credentials';
const path = '/api/plugins/' + encodeURIComponent(pluginId) + '/credentials';

test(
	'packaged Credentials validates keys, preserves secrets on edits, and exposes summaries only',
	{ timeout: 60000 },
	async () => {
		await using resources = new AsyncDisposableStack();
		const host = await startHost(resources, pluginId, [
			pluginFixture(new URL('../../ssh/', import.meta.url), '@nexus-terminal/ssh'),
			pluginFixture(new URL('../', import.meta.url), pluginId),
		]);
		const secret = 'test-password-never-returned';
		const password = CredentialSchema.parse(
			await host.json(
				path,
				{
					credential: { name: 'Password fixture', username: 'owner', type: 'password', password: secret },
				},
				'POST',
				201,
			),
		);
		const renamed = CredentialSchema.parse(
			await host.json(
				path + '/' + password.id,
				{
					patch: { name: 'Renamed fixture' },
				},
				'PATCH',
			),
		);
		assert.equal(renamed.name, 'Renamed fixture');

		const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const privateKey = pair.privateKey.export({
			type: 'pkcs8',
			format: 'pem',
			cipher: 'aes-256-cbc',
			passphrase: 'fixture',
		});
		const invalid = await host.json(
			path,
			{
				credential: {
					name: 'Invalid key',
					username: 'owner',
					type: 'privateKey',
					privateKey,
					passphrase: 'wrong',
				},
			},
			'POST',
			400,
		);
		assert.equal((invalid as { code: string }).code, 'CREDENTIALS_KEY_INVALID');
		const key = CredentialSchema.parse(
			await host.json(
				path,
				{
					credential: {
						name: 'SSH key fixture',
						username: 'owner',
						type: 'privateKey',
						privateKey,
						passphrase: 'fixture',
					},
				},
				'POST',
				201,
			),
		);
		assert.equal(key.hasPassphrase, true);
		const result = CredentialsSnapshotSchema.parse(await host.json(path));
		assert.equal(result.items.length, 2);
		assert.doesNotMatch(JSON.stringify(result), /test-password-never-returned|BEGIN ENCRYPTED PRIVATE KEY/u);
		assert.equal((await host.request(path + '/' + key.id + '/material')).status, 404);

		const browser = await chromium.launch();
		resources.defer(() => browser.close());
		const page = await browser.newPage({ locale: 'en-US', reducedMotion: 'reduce' });
		const browserErrors = collectBrowserErrors(page);
		await page.goto(host.origin);
		await page.getByRole('textbox', { name: 'Username' }).fill('owner');
		await page.locator('input[type=password]').fill('sdk-fixture-password');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await page.getByRole('button', { name: 'Credentials', exact: true }).click();
		const app = page.getByRole('region', { name: 'Credentials', exact: true });
		await expect(app.getByText('Renamed fixture')).toBeVisible();
		await expect(app.getByText('SSH key fixture')).toBeVisible();
		for (const [name, type] of [
			['Renamed fixture', 'Password'],
			['SSH key fixture', 'Private key'],
		]) {
			const card = app.locator('.credentials-card').filter({ hasText: name });
			const label = card.getByText(type, { exact: true });
			const edit = card.getByRole('button', { name: 'Edit credential · ' + name, exact: true });
			await expect(label).toHaveCount(1);
			await expect(card.getByRole('button', { name: 'Delete · ' + name, exact: true })).toBeVisible();
			await expect(card.locator('.ui-card__description')).toBeVisible();
			await edit.click();
			const editor = page.getByRole('dialog', { name: 'Edit credential', exact: true });
			await expect(editor.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name);
			await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
		}

		await app.getByRole('button', { name: 'Add credential', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Add credential' });
		await expectFormFields(dialog);
		const nameInput = dialog.getByRole('textbox', { name: 'Name', exact: true });
		const usernameInput = dialog.getByRole('textbox', { name: 'Username', exact: true });
		const nameBounds = (await nameInput.boundingBox())!;
		const usernameBounds = (await usernameInput.boundingBox())!;
		assert.equal(nameBounds.x, usernameBounds.x);
		assert.equal(nameBounds.width, usernameBounds.width);
		assert.ok(usernameBounds.y >= nameBounds.y + nameBounds.height);
		await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Browser credential');
		await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('browser-user');
		await dialog.locator('input[type=password]').fill('browser-fixture-password');
		await dialog.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(app.getByText('Browser credential')).toBeVisible();
		await expect(page.locator('[data-ui="toast"]').getByText('Credential saved.')).toBeVisible();
		await app.getByText('Browser credential', { exact: true }).click();
		const edit = page.getByRole('dialog', { name: 'Edit credential', exact: true });
		await expect(edit.locator('input[type=password]')).toHaveValue('');
		await edit.getByRole('textbox', { name: 'Name', exact: true }).fill('Edited browser credential');
		await edit.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(app.getByText('Edited browser credential', { exact: true })).toBeVisible();
		const search = app.getByRole('textbox', { name: 'Search name or username', exact: true });
		await search.fill('browser-user');
		await expect(app.locator('.credentials-card')).toHaveCount(1);
		const filters = app.getByRole('combobox', { name: 'Authentication', exact: true });
		await filters.click();
		await page.getByRole('option', { name: 'Private key', exact: true }).click();
		await expect(filters).toContainText('Private key');
		await expect(app.getByText('No matching credentials', { exact: true })).toBeVisible();
		await filters.click();
		await page.getByRole('option', { name: 'All types', exact: true }).click();
		await search.clear();
		await expect(app.getByText('Edited browser credential', { exact: true })).toBeVisible();

		await app.getByRole('button', { name: 'Add credential', exact: true }).click();
		await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Invalid browser key');
		await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('browser-user');
		await dialog.getByRole('combobox', { name: 'Authentication' }).click();
		await page.getByRole('option', { name: 'Private key', exact: true }).click();
		const upload = dialog.getByRole('button', { name: 'Choose private key file' });
		const keyInput = dialog.getByRole('textbox', { name: 'Private key', exact: true });
		await expectFormFields(dialog);
		assert.equal((await upload.boundingBox())!.width, (await keyInput.boundingBox())!.width);
		await dialog.getByRole('textbox', { name: 'Private key', exact: true }).fill('invalid key');
		await dialog.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(page.locator('[data-ui="toast"]').getByText('Invalid private key or passphrase.')).toBeVisible();
		await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();

		await app.getByRole('button', { name: 'Add credential', exact: true }).click();
		await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('Imported key fixture');
		await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('browser-user');
		await dialog.getByRole('combobox', { name: 'Authentication' }).click();
		await page.getByRole('option', { name: 'Private key', exact: true }).click();
		await dialog.locator('input[type=file]').setInputFiles({
			name: 'fixture.pem',
			mimeType: 'application/x-pem-file',
			buffer: Buffer.from(privateKey),
		});
		await expect(keyInput).toHaveValue(privateKey);
		await dialog.getByLabel('Key passphrase', { exact: true }).fill('fixture');
		await dialog.getByRole('button', { name: 'Save', exact: true }).click();
		await expect(app.getByText('Imported key fixture', { exact: true })).toBeVisible();
		const remove = app.getByRole('button', { name: 'Delete · Imported key fixture', exact: true });

		await remove.click();
		const confirmation = page.getByRole('dialog', { name: 'Delete credential', exact: true });
		await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click();
		await expect(app.getByText('Imported key fixture', { exact: true })).toBeVisible();
		await remove.click();
		await confirmation.getByRole('button', { name: 'Delete', exact: true }).click();
		await expect(app.getByText('Imported key fixture', { exact: true })).toHaveCount(0);

		const response = await host.request(path + '/' + key.id, { method: 'DELETE' });
		assert.equal(response.status, 204);
		await expect(app.getByText('SSH key fixture')).toHaveCount(0);
		expect(browserErrors).toEqual([]);
	},
);
