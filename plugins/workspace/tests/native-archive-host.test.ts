import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect as browserExpect } from '@playwright/test';
import ssh2 from 'ssh2';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { pluginFixture, startHost } from '../../test/tests/host.js';
import { startBrowser } from '../../test/tests/browser-session.js';
import { collectBrowserErrors } from '../../test/tests/browser-checks.js';

const exec = promisify(execFile);
const id = '@nexus-terminal/workspace';

const resource = (name: string) => '/api/plugins/' + encodeURIComponent('@nexus-terminal/' + name);

const directory = '/tmp/nexus-archive-fixture';

// The optional image is built by scripts/ci/native-transfer.sh, and this test is
// required in its separate CI invocation. All files and the loopback sshd live
// inside the disposable host container, not on the runner or a user server.
it.skipIf(!process.env.NEXUS_TEST_NATIVE_IMAGE)(
	'compresses, extracts and downloads real files using the Workspace UI over native OpenSSH',
	async () => {
		await using resources = new AsyncDisposableStack();
		const host = await startHost(resources, id, [
			...['ssh', 'credentials', 'connections', 'remote-tools'].map((name) =>
				pluginFixture(new URL('../../' + name + '/', import.meta.url), '@nexus-terminal/' + name),
			),
			pluginFixture(new URL('../', import.meta.url), id),
		]);
		const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const privateKey = pair.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
		const key = ssh2.utils.parseKey(privateKey);
		if (key instanceof Error) throw key;
		const publicKey = key.type + ' ' + key.getPublicSSH().toString('base64');

		const docker = (...args: string[]) =>
			exec('docker', ['exec', '--user', '0', host.container, ...args], { timeout: 15000 });

		await docker(
			'sh',
			'-c',
			[
				'set -eu',
				'umask 077',
				'mkdir -p /run/sshd "$1/output"',
				'printf "%s\n" "$2" > "$1/authorized_keys"',
				'printf "%s" "native archive bytes" > "$1/source.txt"',
				'ssh-keygen -q -t ed25519 -N "" -f "$1/host"',
				'printf "%s\n" "Port 22022" "ListenAddress 127.0.0.1" "HostKey $1/host" "PidFile $1/pid" "AuthorizedKeysFile $1/authorized_keys" "StrictModes no" "PubkeyAuthentication yes" "PasswordAuthentication no" "KbdInteractiveAuthentication no" "UsePAM no" "PermitRootLogin yes" "Subsystem sftp internal-sftp" > "$1/sshd_config"',
				'/usr/sbin/sshd -f "$1/sshd_config"',
			].join('\n'),
			'fixture',
			directory,
			publicKey,
		);
		const credential = z.object({ id: z.uuid() }).parse(
			await host.json(
				resource('credentials') + '/credentials',
				{
					credential: {
						name: 'Native archive fixture',
						username: 'root',
						type: 'privateKey',
						privateKey,
					},
				},
				'POST',
				201,
			),
		);
		await host.json(
			resource('connections') + '/connections',
			{
				connection: {
					name: 'Native archive SSH',
					type: 'ssh',
					host: '127.0.0.1',
					port: 22022,
					credentialId: credential.id,
					tags: [],
				},
			},
			'POST',
			201,
		);
		const { page, origin } = await startBrowser(resources, host.origin, {
			viewport: { width: 1600, height: 1000 },
			locale: 'en-US',
			reducedMotion: 'reduce',
		});
		page.setDefaultTimeout(10000);
		const errors = collectBrowserErrors(page);
		await page.goto(origin);
		await page.getByLabel('Username', { exact: true }).fill('owner');
		await page.getByLabel('Password', { exact: true }).fill('sdk-fixture-password');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await page
			.locator('[data-tile="@nexus-terminal/workspace:applications:main"]')
			.getByRole('button', { name: 'Workspace', exact: true })
			.click();
		const workspace = page.getByRole('region', { name: 'Workspace', exact: true }).first();
		await workspace.getByRole('button', { name: 'Native archive SSH', exact: true }).click();
		await page
			.getByRole('dialog', { name: 'Verify server identity' })
			.getByRole('button', { name: 'Trust and connect' })
			.click();
		const files = workspace.locator('.workspace-files');
		const path = files.getByRole('combobox', { name: 'Remote path' });
		await path.fill(directory);
		await path.press('Enter');

		const file = (name: string) => files.getByRole('button', { name, exact: true });

		await browserExpect(file('source.txt')).toBeVisible();
		await file('source.txt').click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Compress', exact: true }).click();
		const compress = page.getByRole('dialog', { name: 'Compress', exact: true });
		await compress.getByRole('combobox', { name: 'Archive format' }).click();
		await page.getByRole('option', { name: 'tar.gz', exact: true }).click();
		await browserExpect(compress.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(
			'source.txt.tar.gz',
		);
		await compress.getByRole('textbox', { name: 'Name', exact: true }).fill('qa.tar.gz');
		await compress.getByRole('button', { name: 'Save', exact: true }).click();
		await browserExpect(file('qa.tar.gz')).toBeVisible({ timeout: 15000 });
		expect((await docker('tar', '-tzf', directory + '/qa.tar.gz')).stdout.trim()).toBe('./source.txt');

		// Compression cannot silently replace an existing archive.
		const digest = () => docker('sha256sum', directory + '/qa.tar.gz').then(({ stdout }) => stdout);

		const original = await digest();
		await file('source.txt').click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Compress', exact: true }).click();
		await compress.getByRole('combobox', { name: 'Archive format' }).click();
		await page.getByRole('option', { name: 'tar.gz', exact: true }).click();
		await compress.getByRole('textbox', { name: 'Name', exact: true }).fill('qa.tar.gz');
		await compress.getByRole('button', { name: 'Save', exact: true }).click();
		const conflict = page.getByRole('dialog', { name: 'Replace existing files?', exact: true });
		await browserExpect(conflict).toBeVisible();
		expect(await digest()).toBe(original);
		await conflict.getByRole('contentinfo').getByRole('button', { name: 'Cancel', exact: true }).click();
		await browserExpect(conflict).toHaveCount(0);
		await browserExpect(compress).toBeVisible();
		expect(await digest()).toBe(original);
		await compress.getByRole('button', { name: 'Save', exact: true }).click();
		await browserExpect(conflict).toBeVisible();
		await conflict.getByRole('button', { name: 'Continue', exact: true }).click();
		await browserExpect(conflict).toHaveCount(0);
		await browserExpect(compress).toHaveCount(0);

		const center = page.getByRole('dialog', { name: /^Transfers(?:\s*\d+)?$/u });
		const completedArchives = center
			.locator('.workspace-transfer-task[data-state="completed"]')
			.filter({ hasText: 'qa.tar.gz' });
		await workspace.getByRole('button', { name: 'Transfers', exact: true }).click();
		await center.getByRole('tab', { name: 'History', exact: true }).click();
		await browserExpect(completedArchives).toHaveCount(2);
		await center.getByRole('button', { name: 'Collapse', exact: true }).click();

		await file('qa.tar.gz').click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Extract to…', exact: true }).click();
		const extract = page.getByRole('dialog', { name: 'Extract to…', exact: true });
		await extract.getByRole('textbox', { name: 'Destination directory', exact: true }).fill(directory + '/output');
		await extract.getByRole('button', { name: 'Save', exact: true }).click();
		await browserExpect(extract).toHaveCount(0);
		await file('output').click();
		await browserExpect(file('source.txt')).toBeVisible({ timeout: 15000 });
		expect((await docker('cat', directory + '/output/source.txt')).stdout).toBe('native archive bytes');

		// A new extraction must preserve existing files by default.
		await docker('sh', '-c', 'printf "%s" "keep existing" > "$1"', 'fixture', directory + '/output/source.txt');
		await file('Parent directory').click();
		await browserExpect(file('qa.tar.gz')).toBeVisible();
		await file('qa.tar.gz').click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Extract to…', exact: true }).click();
		const replace = extract.getByRole('checkbox', { name: 'Replace existing files when extracting' });
		await browserExpect(replace).not.toBeChecked();
		await extract.getByRole('textbox', { name: 'Destination directory', exact: true }).fill(directory + '/output');
		await extract.getByRole('button', { name: 'Save', exact: true }).click();
		await browserExpect(extract).toHaveCount(0);
		await workspace.getByRole('button', { name: 'Transfers', exact: true }).click();
		await center.getByRole('tab', { name: 'History', exact: true }).click();
		await browserExpect(
			center.locator('.workspace-transfer-task[data-state="failed"]').filter({ hasText: 'qa.tar.gz' }),
		).toContainText('The destination already exists.');
		expect((await docker('cat', directory + '/output/source.txt')).stdout).toBe('keep existing');
		await center.getByRole('button', { name: 'Collapse', exact: true }).click();
		await file('qa.tar.gz').click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Extract to…', exact: true }).click();
		await extract.getByRole('textbox', { name: 'Destination directory', exact: true }).fill(directory + '/output');
		await replace.check();
		await extract.getByRole('button', { name: 'Save', exact: true }).click();
		await browserExpect(extract).toHaveCount(0);
		await expect
			.poll(async () => (await docker('cat', directory + '/output/source.txt')).stdout)
			.toBe('native archive bytes');
		await file('output').click();
		await browserExpect(file('source.txt')).toBeVisible();

		await file('source.txt').click({ button: 'right' });
		const downloadEvent = page.waitForEvent('download');
		await page.getByRole('menuitem', { name: 'Download file', exact: true }).click();
		const download = await downloadEvent;
		expect(download.suggestedFilename()).toBe('source.txt');
		if (!process.env.NEXUS_TEST_CDP) {
			const local = await mkdtemp(join(tmpdir(), 'nexus-archive-download-'));
			try {
				const destination = join(local, 'source.txt');
				await download.saveAs(destination);
				expect(await readFile(destination, 'utf8')).toBe('native archive bytes');
			} finally {
				await rm(local, { recursive: true, force: true });
			}
		}
		await workspace.getByRole('button', { name: 'Transfers', exact: true }).click();
		await center.getByRole('tab', { name: 'History', exact: true }).click();
		await browserExpect(completedArchives).toHaveCount(4);
		await browserExpect(
			center.locator('.workspace-transfer-task[data-state="completed"]').filter({ hasText: 'source.txt' }),
		).toBeVisible();
		expect(errors).toEqual([]);
	},
	120000,
);
