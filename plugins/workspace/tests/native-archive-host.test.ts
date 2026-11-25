import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { expect as browserExpect, type Download } from '@playwright/test';
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
	'uses native OpenSSH for archive, shell directory and cross-connection file workflows',
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
				'mkdir -p /run/sshd "$1/output" "$1/target"',
				'printf "%s\n" "$2" > "$1/authorized_keys"',
				'printf "%s" "native archive bytes" > "$1/source.txt"',
				'ssh-keygen -q -t ed25519 -N "" -f "$1/host"',
				'printf "%s\n" "Port 22022" "ListenAddress 127.0.0.1" "HostKey $1/host" "PidFile $1/pid" "AuthorizedKeysFile $1/authorized_keys" "StrictModes no" "PubkeyAuthentication yes" "PasswordAuthentication no" "KbdInteractiveAuthentication no" "UsePAM no" "PermitRootLogin yes" "Subsystem sftp internal-sftp" > "$1/sshd_config"',
				'/usr/sbin/sshd -f "$1/sshd_config"',
				'ssh-keygen -q -t ed25519 -N "" -f "$1/target-host"',
				'sed -e "s/Port 22022/Port 22023/" -e "s|HostKey $1/host|HostKey $1/target-host|" -e "s|PidFile $1/pid|PidFile $1/target-pid|" "$1/sshd_config" > "$1/target-config"',
				'/usr/sbin/sshd -f "$1/target-config"',
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
		await host.json(
			resource('connections') + '/connections',
			{
				connection: {
					name: 'Native transfer target',
					type: 'ssh',
					host: '127.0.0.1',
					port: 22023,
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
		// A remote Windows Chrome cannot save to the Linux Playwright artifact directory.
		// Only an explicitly supplied, disposable Windows directory enables remote disk assertions.
		const remoteDownloadDir = process.env.NEXUS_TEST_CDP_DOWNLOAD_DIR;
		if (remoteDownloadDir) {
			if (!process.env.NEXUS_TEST_CDP || !/^[a-z]:[\\/]/iu.test(remoteDownloadDir))
				throw new Error('CDP download assertions require a dedicated absolute Windows directory');
			const context = page.context();
			const browserSession = await context.browser()!.newBrowserCDPSession();
			// Keep the browser session alive: detaching drops its download behavior.
			resources.defer(() => browserSession.detach());
			const pageSession = await context.newCDPSession(page);
			try {
				const { targetInfo } = await pageSession.send('Target.getTargetInfo');
				const { browserContextIds } = await browserSession.send('Target.getBrowserContexts');
				if (!targetInfo.browserContextId || !browserContextIds.includes(targetInfo.browserContextId))
					throw new Error('Downloads must be configured only on a disposable browser context');
				await browserSession.send('Browser.setDownloadBehavior', {
					behavior: 'allow',
					browserContextId: targetInfo.browserContextId,
					downloadPath: remoteDownloadDir,
					eventsEnabled: true,
				});
			} finally {
				await pageSession.detach();
			}
		}

		async function confirmRemoteSave(download: Download) {
			const deadline = new AbortController();
			try {
				expect(
					await Promise.race([
						download.failure(),
						delay(30000, undefined, { signal: deadline.signal }).then(() => {
							throw new Error('Timed out waiting for remote browser download completion');
						}),
					]),
				).toBeNull();
			} finally {
				deadline.abort();
			}
		}

		async function remoteFileDigest(name: string) {
			if (!remoteDownloadDir) throw new Error('No remote download directory');
			const context = page.context();
			const verifier = await context.newPage();
			try {
				await verifier.goto(origin);
				await verifier.setContent('<input type="file" id="fixture-download">');
				const session = await context.newCDPSession(verifier);
				try {
					const { root } = await session.send('DOM.getDocument');
					const { nodeId } = await session.send('DOM.querySelector', {
						nodeId: root.nodeId,
						selector: '#fixture-download',
					});
					await session.send('DOM.setFileInputFiles', {
						nodeId,
						files: [win32.join(remoteDownloadDir, name)],
					});
					return await verifier.locator('input').evaluate(async (input: HTMLInputElement) => {
						const file = input.files?.[0];
						if (!file) throw new Error('Saved file is missing');
						const hash = Array.from(
							new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())),
							(byte) => byte.toString(16).padStart(2, '0'),
						).join('');
						return { size: file.size, hash };
					});
				} finally {
					await session.detach();
				}
			} finally {
				await verifier.close();
			}
		}

		const checkNativeSave = !process.env.NEXUS_TEST_CDP || !!remoteDownloadDir;

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
		const files = workspace.locator('.workspace-tab-panel[data-state="active"] .workspace-files');
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
		await workspace.getByRole('button', { name: 'Transfers', exact: true }).click();
		await center.getByRole('tab', { name: 'History', exact: true }).click();
		await browserExpect(completedArchives).toHaveCount(3);
		await center.getByRole('button', { name: 'Collapse', exact: true }).click();
		await file('output').click();
		await browserExpect(path).toHaveValue(directory + '/output');
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
		await workspace.getByRole('button', { name: 'Transfers', exact: true }).click();
		await center.getByRole('tab', { name: 'History', exact: true }).click();
		await browserExpect(completedArchives).toHaveCount(4);
		await center.getByRole('button', { name: 'Collapse', exact: true }).click();
		expect((await docker('cat', directory + '/output/source.txt')).stdout).toBe('native archive bytes');
		await file('output').click();
		await browserExpect(path).toHaveValue(directory + '/output');
		await browserExpect(file('source.txt')).toBeVisible();

		await file('source.txt').click({ button: 'right' });
		const downloadHead = page.waitForResponse(
			(response) => response.request().method() === 'HEAD' && new URL(response.url()).pathname.endsWith('/file'),
		);
		const downloadEvent = page.waitForEvent('download');
		await page.getByRole('menuitem', { name: 'Download file', exact: true }).click();
		const download = await downloadEvent;
		expect(download.suggestedFilename()).toBe('source.txt');
		if (remoteDownloadDir) {
			await confirmRemoteSave(download);
			expect(await remoteFileDigest('source.txt')).toEqual({
				size: Buffer.byteLength('native archive bytes'),
				hash: createHash('sha256').update('native archive bytes').digest('hex'),
			});
		} else if (!process.env.NEXUS_TEST_CDP) {
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
		await center.getByRole('button', { name: 'Collapse', exact: true }).click();

		// A multi-window native SFTP read must complete both the HTTP body and the transfer history.
		const largeName = 'large-download.bin';
		const largePath = directory + '/output/' + largeName;
		const largeSize = 64 * 1024 * 1024;
		await docker('dd', 'if=/dev/urandom', 'of=' + largePath, 'bs=1048576', 'count=64');
		const largeHash = (await docker('sha256sum', largePath)).stdout.split(' ')[0];
		await files.getByRole('button', { name: 'Refresh directory', exact: true }).click();
		await browserExpect(file(largeName)).toBeVisible();
		const largeUrl = new URL((await downloadHead).url());
		largeUrl.search = '';
		largeUrl.searchParams.set('path', largePath);
		const received = await page.evaluate(async (url) => {
			const response = await fetch(url);
			const bytes = await response.arrayBuffer();
			const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
				byte.toString(16).padStart(2, '0'),
			).join('');
			return { status: response.status, size: bytes.byteLength, hash };
		}, largeUrl.toString());
		expect(received).toEqual({ status: 200, size: largeSize, hash: largeHash });
		if (checkNativeSave) {
			await file(largeName).click({ button: 'right' });
			const event = page.waitForEvent('download');
			await page.getByRole('menuitem', { name: 'Download file', exact: true }).click();
			const artifact = await event;
			expect(artifact.suggestedFilename()).toBe(largeName);
			if (remoteDownloadDir) {
				await confirmRemoteSave(artifact);
				expect(await remoteFileDigest(largeName)).toEqual({ size: largeSize, hash: largeHash });
			} else {
				const local = await mkdtemp(join(tmpdir(), 'nexus-large-download-'));
				try {
					const destination = join(local, largeName);
					await artifact.saveAs(destination);
					const bytes = await readFile(destination);
					expect(bytes.length).toBe(largeSize);
					expect(createHash('sha256').update(bytes).digest('hex')).toBe(largeHash);
				} finally {
					await rm(local, { recursive: true, force: true });
				}
			}
		}
		await workspace.getByRole('button', { name: 'Transfers', exact: true }).click();
		await center.getByRole('tab', { name: 'History', exact: true }).click();
		const largeHistory = center.locator('.workspace-transfer-task').filter({ hasText: largeName });
		await browserExpect(largeHistory).toHaveCount(checkNativeSave ? 2 : 1);
		await browserExpect(largeHistory.and(center.locator('[data-state="completed"]'))).toHaveCount(
			checkNativeSave ? 2 : 1,
		);
		await center.getByRole('button', { name: 'Collapse', exact: true }).click();

		// Both directions must observe the actual interactive shell, not an exec-channel cwd.
		const syncToTerminal = page.waitForResponse(
			(response) => response.url().endsWith('/terminal-directory') && response.request().method() === 'POST',
		);
		await files.getByRole('button', { name: 'Change terminal to this directory', exact: true }).click();
		const changed = await syncToTerminal;
		expect(changed.status(), await changed.text()).toBe(200);
		expect(await changed.json()).toEqual({ path: directory + '/output' });
		const terminal = workspace.locator('.workspace-tab-panel[data-state="active"] .workspace-terminal');
		const input = terminal.locator('.xterm-helper-textarea');
		await input.focus();
		await page.keyboard.type('cd ' + directory + '; printf "nexus-shell-cwd-ready\\n"');
		await page.keyboard.press('Enter');
		await browserExpect(terminal.locator('.xterm-rows')).toContainText('nexus-shell-cwd-ready');
		await expect
			.poll(async () => {
				const response = await page.request.get(changed.url());
				return response.ok() ? await response.json() : null;
			})
			.toEqual({ path: directory });
		await files.getByRole('button', { name: 'Follow terminal directory', exact: true }).click();
		await browserExpect(path).toHaveValue(directory);
		await browserExpect(file('qa.tar.gz')).toBeVisible();

		// Connect a second native endpoint from the actual send dialog without losing the source.
		await file('source.txt').click({ button: 'right' });
		await page.getByRole('menuitem', { name: 'Send to server', exact: true }).click();
		const send = page.getByRole('dialog', { name: 'Send to server', exact: true });
		await send.getByRole('combobox', { name: 'Destination server' }).click();
		await page.getByRole('option', { name: 'Native transfer target', exact: true }).click();
		await browserExpect(send.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await send.getByRole('button', { name: 'Connect to server', exact: true }).click();
		const identity = page.getByRole('dialog', { name: 'Verify server identity' });
		await browserExpect(identity).toBeVisible();
		await browserExpect(send).toHaveCount(0);
		await identity.getByRole('button', { name: 'Cancel', exact: true }).click();
		await browserExpect(send).toBeVisible();
		await browserExpect(send.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
		await send.getByRole('button', { name: 'Connect to server', exact: true }).click();
		await identity.getByRole('button', { name: 'Trust and connect' }).click();
		await browserExpect(send).toBeVisible();
		await browserExpect(send.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
		await send.getByRole('textbox', { name: 'Destination directory' }).fill(directory);
		await send.getByRole('button', { name: 'Browse directories', exact: true }).click();
		await send.getByRole('button', { name: 'target', exact: true }).click();
		await browserExpect(send.getByRole('textbox', { name: 'Destination directory' })).toHaveValue(
			directory + '/target',
		);
		const sent = page.waitForResponse(
			(response) => response.url().endsWith('/files/transfer') && response.request().method() === 'POST',
		);
		await send.getByRole('button', { name: 'Save', exact: true }).click();
		const accepted = await sent;
		expect(accepted.status(), await accepted.text()).toBe(202);
		expect(accepted.request().postDataJSON()).toMatchObject({
			paths: [directory + '/source.txt'],
			destination: directory + '/target',
			move: false,
			overwrite: false,
		});
		await browserExpect(send).toHaveCount(0);
		await browserExpect(workspace.getByRole('tab', { name: 'Native archive SSH', exact: true })).toHaveAttribute(
			'aria-selected',
			'true',
		);
		await workspace.getByRole('button', { name: 'Transfers', exact: true }).click();
		await center.getByRole('tab', { name: 'History', exact: true }).click();
		const completedCopy = center
			.locator('.workspace-transfer-task[data-state="completed"]')
			.filter({ hasText: 'Native transfer target' })
			.filter({ hasText: 'source.txt' });
		await browserExpect(completedCopy).toBeVisible({ timeout: 15000 });
		await browserExpect(completedCopy).toContainText('rsync');
		expect((await docker('cat', directory + '/target/source.txt')).stdout).toBe('native archive bytes');
		expect((await docker('cat', directory + '/source.txt')).stdout).toBe('native archive bytes');
		expect(errors).toEqual([]);
	},
	120000,
);
