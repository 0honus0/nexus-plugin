import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { devices, expect, type Locator, type Page } from '@playwright/test';
import { CredentialSchema } from '../../credentials/src/shared/credentials-types.js';
import { ConnectionSchema } from '../../connections/src/shared/connection-types.js';
import { startBrowser } from '../../test/tests/browser-session.js';
import { pluginFixture, reload, setEnabled, startHost } from '../../test/tests/host.js';
import { DesktopSessionResponseSchema } from '../src/shared/desktop-session.js';

const exec = promisify(execFile);
const desktopId = '@nexus-terminal/remote-desktop';
const target = 'desktop-target';
const gateway = 'desktop-gateway';
const password = 'nexus-local-fixture';
const display = { width: 1280, height: 720, dpi: 96 };

const api = (name: string) => '/api/plugins/' + encodeURIComponent('@nexus-terminal/' + name);

async function docker(...args: string[]): Promise<string> {
	const { stdout } = await exec('docker', args, { timeout: 10000 });
	return stdout.trim();
}

async function startFixtures(resources: AsyncDisposableStack) {
	const network = 'nexus-desktop-test-' + randomUUID().slice(0, 8);
	await docker('network', 'create', network);
	resources.defer(async () => {
		await docker('network', 'rm', network);
	});

	async function container(alias: string, image: string): Promise<string> {
		const id = await docker('run', '--detach', '--network', network, '--network-alias', alias, image);
		resources.defer(async () => {
			await docker('rm', '--force', '--volumes', id);
		});
		return id;
	}

	const server = await container(target, process.env.NEXUS_TEST_DESKTOP_IMAGE ?? 'nexus-desktop-test:fixtures');
	await container(gateway, process.env.NEXUS_TEST_GUACD_IMAGE ?? 'guacamole/guacd:1.6.0');
	await expect
		.poll(
			() =>
				docker('top', server, '-eo', 'pid,args').then(
					(processes) => /^\s*\d+\s+xterm -title Nexus-VNC-fixture$/m.test(processes),
					() => false,
				),
			{ timeout: 10000 },
		)
		.toBe(true);
	return { network, server };
}

async function choose(page: Page, window: Locator, label: string, option: string, touchscreen = false): Promise<void> {
	const control = window.getByRole('combobox', { name: label, exact: true });
	if ((await control.innerText()).trim() === option) return;
	const select = page.getByRole('option', { name: option, exact: true });
	if (touchscreen) {
		await control.tap();
		await select.tap();
	} else {
		await control.click();
		await select.click();
	}
}

async function waitForPixels(canvas: Locator): Promise<void> {
	await expect(canvas).toBeVisible({ timeout: 15000 });
	await expect
		.poll(
			() =>
				canvas.evaluate((element: HTMLCanvasElement) => {
					const context = element.getContext('2d');
					if (!context || element.width < 100 || element.height < 100) return false;
					const { data } = context.getImageData(0, 0, element.width, element.height);
					for (let index = 0; index < data.length; index += 4) {
						if (data[index + 3] && data[index] + data[index + 1] + data[index + 2] > 20) return true;
					}
					return false;
				}),
			{ timeout: 15000 },
		)
		.toBe(true);
}

async function waitForRdpLogin(canvas: Locator): Promise<void> {
	await expect
		.poll(
			() =>
				canvas.evaluate((element: HTMLCanvasElement) => {
					const pixel = element.getContext('2d')?.getImageData(element.width - 15, 20, 1, 1).data;
					return !!pixel && pixel[0] + pixel[1] + pixel[2] < 30;
				}),
			{ timeout: 15000 },
		)
		.toBe(true);
}

async function waitForMarker(server: string, marker: string): Promise<void> {
	await expect
		.poll(
			() =>
				docker('exec', server, 'test', '-f', marker).then(
					() => true,
					() => false,
				),
			{ timeout: 10000 },
		)
		.toBe(true);
}

async function verifyInput(page: Page, canvas: Locator, server: string, nativeRdp: boolean): Promise<void> {
	const bounds = await canvas.boundingBox();
	assert.ok(bounds);
	if (nativeRdp) {
		// The fixture uses the built-in xrdp sign-in panel under TLS.
		await page.mouse.click(bounds.x + bounds.width * 0.53, bounds.y + bounds.height * 0.59);
		await page.evaluate((text) => {
			const clipboardData = new DataTransfer();
			clipboardData.setData('text/plain', text);
			document.activeElement?.dispatchEvent(
				new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }),
			);
		}, password);
		await page.keyboard.press('Enter');
		await waitForRdpLogin(canvas);
	}
	const desktop = await canvas.boundingBox();
	assert.ok(desktop);
	await page.mouse.click(desktop.x + 50, desktop.y + 14);
	const marker = '/tmp/nexus-input-' + randomUUID();
	await page.keyboard.type('touch ' + marker, { delay: 8 });
	await page.keyboard.press('Enter');
	await waitForMarker(server, marker);
}

const combinations = [
	['VNC', 'Native'],
	['VNC', 'Guacamole gateway'],
	['RDP', 'Native'],
	['RDP', 'Guacamole gateway'],
] as const;

test(
	'real RDP and VNC render and accept input in both modes',
	{
		skip: process.env.NEXUS_TEST_REAL_DESKTOP !== '1',
		timeout: 210000,
	},
	async (t) => {
		await using resources = new AsyncDisposableStack();
		const { network, server } = await startFixtures(resources);
		const host = await startHost(
			resources,
			desktopId,
			[
				pluginFixture(new URL('../../ssh/', import.meta.url), '@nexus-terminal/ssh'),
				pluginFixture(new URL('../../credentials/', import.meta.url), '@nexus-terminal/credentials'),
				pluginFixture(new URL('../../connections/', import.meta.url), '@nexus-terminal/connections'),
				pluginFixture(new URL('../', import.meta.url), desktopId),
			],
			{ network, guacamoleHost: gateway },
		);
		const base = api('remote-desktop');
		assert.deepEqual(await host.json(base + '/modes'), { guacamole: true });
		const credential = CredentialSchema.parse(
			await host.json(
				api('credentials') + '/credentials',
				{
					credential: { name: 'Desktop fixture', username: 'desktop', password, type: 'password' },
				},
				'POST',
				201,
			),
		);

		async function profile(name: string, type: 'rdp' | 'vnc', port: number, credentialId: string | null = null) {
			return ConnectionSchema.parse(
				await host.json(
					api('connections') + '/connections',
					{
						connection: {
							name,
							type,
							host: target,
							port,
							credentialId,
						},
					},
					'POST',
					201,
				),
			);
		}

		await profile('VNC fixture', 'vnc', 5907);
		const rdp = await profile('RDP fixture', 'rdp', 3389, credential.id);
		await profile('RDP without credentials', 'rdp', 3389);
		await profile('Unavailable VNC', 'vnc', 5917);
		const incorrect = Array.from({ length: 32 }, () => '00').join(':');
		const checked = DesktopSessionResponseSchema.parse(
			await host.json(base + '/sessions', {
				connectionId: rdp.id,
				mode: 'guacamole',
				display,
				trust: {
					host: target,
					port: 3389,
					fingerprint: incorrect,
					previousFingerprint: null,
					permanent: false,
				},
			}),
		).result;
		assert.equal(checked.kind, 'certificate');
		assert.notEqual(checked.fingerprint, incorrect);

		const browser = await startBrowser(resources, host.origin, {
			viewport: { width: 1440, height: 900 },
			locale: 'en-US',
		});
		const { page, origin } = browser;
		await page.goto(origin);
		await page.getByRole('textbox', { name: 'Username' }).fill('owner');
		await page.locator('input[type=password]').fill('sdk-fixture-password');
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();

		const launcher = page.getByRole('button', { name: 'Remote Desktop', exact: true });
		const desktop = page.getByRole('region', { name: 'Remote Desktop', exact: true });

		const button = (name: string) => desktop.getByRole('button', { name, exact: true });

		const canvas = desktop.locator('.remote-desktop-viewport canvas').first();
		let opened = 0;
		let closed = 0;
		page.on('websocket', (socket) => {
			if (!new URL(socket.url()).pathname.endsWith('/desktop')) return;
			opened++;
			socket.on('close', () => closed++);
		});
		await launcher.click();
		await expect(desktop.getByRole('combobox', { name: 'Connection method' })).toContainText('Guacamole gateway');

		const certificate = page.getByRole('dialog', { name: 'Verify the RDP certificate', exact: true });
		await choose(page, desktop, 'Saved desktop', 'RDP fixture · RDP');
		await button('Connect').click();
		await expect(certificate.locator('code')).toContainText(checked.fingerprint);
		await certificate.getByRole('button', { name: 'Cancel', exact: true }).last().click();
		await expect(certificate).toHaveCount(0);
		assert.equal(opened, 0);

		for (const [protocol, mode] of combinations) {
			await t.test(protocol + ' / ' + mode, async (scenario) => {
				scenario.after(async () => {
					await page.evaluate(async () => {
						if (document.fullscreenElement) await document.exitFullscreen();
					});
					if (await button('Disconnect').isVisible()) await button('Disconnect').click();
				});
				await choose(page, desktop, 'Saved desktop', protocol + ' fixture · ' + protocol);
				await choose(page, desktop, 'Connection method', mode);
				await choose(page, desktop, 'Resolution', '1280 × 720');
				const before = opened;
				await button('Connect').click();
				if (protocol === 'RDP') {
					await expect(certificate.locator('code')).toContainText(checked.fingerprint);
					assert.equal(opened, before);
					await certificate.getByRole('button', { name: 'Trust for this connection' }).click();
				}
				await expect(button('Fullscreen')).toBeVisible({ timeout: 15000 });
				await waitForPixels(canvas);
				await verifyInput(page, canvas, server, protocol === 'RDP' && mode === 'Native');
				const width = (await desktop.boundingBox())!.width;
				const handle = button('Show remote desktop controls');
				const toolbar = desktop.locator('.remote-desktop-toolbar');
				await button('Fullscreen').click();
				await expect
					.poll(() =>
						page.evaluate(() => document.fullscreenElement?.classList.contains('remote-desktop-app')),
					)
					.toBe(true);
				await expect(toolbar).toBeHidden();
				await handle.hover();
				await expect(toolbar).toBeVisible();
				if (protocol === 'RDP' && mode === 'Native') {
					await button('File clipboard').click();
					const files = page.getByRole('dialog', { name: 'File clipboard', exact: true });
					await expect(files).toBeVisible();
					assert.equal(
						await page.evaluate(() => {
							const panel = document.querySelector('[role=dialog]');
							return !!panel && document.fullscreenElement?.contains(panel);
						}),
						true,
					);
					await files.getByRole('button', { name: 'Cancel', exact: true }).click();
					await handle.hover();
				}
				await button('Exit fullscreen').click();
				await expect
					.poll(
						async () =>
							!(await page.evaluate(() => !!document.fullscreenElement)) &&
							Math.abs((await desktop.boundingBox())!.width - width) < 3,
					)
					.toBe(true);
				if (protocol === 'VNC' && mode === 'Native') {
					await button('Pin toolbar').click();
					await expect(toolbar).toBeHidden();
					await handle.hover();
					await expect(toolbar).toBeVisible();
					await page.mouse.move(15, 400);
					await expect(toolbar).toBeHidden();
					await handle.hover();
					await button('Pin toolbar').click();
					await expect(button('Pin toolbar')).toHaveAttribute('aria-pressed', 'true');
				}
				await button('Disconnect').click();
				await expect(desktop.getByRole('status')).toHaveText('Disconnected');
				await expect(canvas).toHaveCount(0);
				await expect.poll(() => closed).toBe(opened);
				assert.equal(opened, before + 1);
			});
		}

		await t.test('adaptive RDP fills the viewport when the toolbar is unpinned', async () => {
			for (const mode of ['Native', 'Guacamole gateway']) {
				await choose(page, desktop, 'Saved desktop', 'RDP fixture · RDP');
				await choose(page, desktop, 'Connection method', mode);
				await choose(page, desktop, 'Resolution', 'Fit window');
				await button('Connect').click();
				await certificate.getByRole('button', { name: 'Trust for this connection' }).click();
				await waitForPixels(canvas);
				const viewport = desktop.locator('.remote-desktop-viewport');
				const surface = mode === 'Native' ? canvas : viewport.locator('.remote-desktop-guacamole > div');
				const initial = (await viewport.boundingBox())!.height;
				await button('Pin toolbar').click();
				await expect
					.poll(async () => {
						const frame = (await viewport.boundingBox())!;
						const picture = (await surface.boundingBox())!;
						return (
							frame.height > initial &&
							Math.abs(picture.width - frame.width) <= 1 &&
							Math.abs(picture.height - frame.height) <= 1
						);
					})
					.toBe(true);
				await button('Show remote desktop controls').hover();
				await button('Pin toolbar').click();
				await button('Disconnect').click();
			}
		});

		await t.test('missing credentials surface an error before opening a socket', async () => {
			await choose(page, desktop, 'Saved desktop', 'RDP without credentials · RDP');
			const before = opened;
			await button('Connect').click();
			await expect(desktop.getByRole('alert')).toHaveText('Select a password credential in Connections.');
			await expect(certificate).toHaveCount(0);
			assert.equal(opened, before);
		});

		await t.test('closed endpoint, retry and plugin stop during an active gateway session', async () => {
			await choose(page, desktop, 'Saved desktop', 'Unavailable VNC · VNC');
			await choose(page, desktop, 'Connection method', 'Guacamole gateway');
			await button('Connect').click();
			await expect(desktop.getByRole('alert')).toHaveText('The desktop connection failed.', { timeout: 15000 });
			await choose(page, desktop, 'Saved desktop', 'VNC fixture · VNC');
			await button('Connect').click();
			await waitForPixels(canvas);
			await setEnabled(host, desktopId, false);
			await expect(desktop).toHaveCount(0);
			await expect.poll(() => closed).toBe(opened);

			await setEnabled(host, desktopId, true);
			await launcher.click();
			await choose(page, desktop, 'Saved desktop', 'VNC fixture · VNC');
			await choose(page, desktop, 'Resolution', 'Fit window');
			await button('Connect').click();
			await waitForPixels(canvas);
			await button('Close application').click();
			await expect(desktop).toHaveCount(0);
			await expect.poll(() => closed).toBe(opened);
			await launcher.click();
			await expect(button('Connect')).toBeEnabled();
			await reload(host, desktopId);
			await expect(desktop).toHaveCount(0);
		});

		const mobile = await startBrowser(resources, host.origin, { ...devices['Pixel 7'], locale: 'en-US' });
		const phone = mobile.page;
		phone.setDefaultTimeout(10_000);
		await phone.bringToFront();
		await phone.goto(mobile.origin);
		await phone.getByRole('textbox', { name: 'Username' }).fill('owner');
		await phone.locator('input[type=password]').fill('sdk-fixture-password');
		await phone.getByRole('button', { name: 'Sign in', exact: true }).tap();
		await phone.getByRole('button', { name: 'Remote Desktop', exact: true }).tap();
		const window = phone.getByRole('region', { name: 'Remote Desktop', exact: true });
		const remoteCanvas = window.locator('.remote-desktop-viewport canvas').first();
		const keyboard = window.getByRole('button', { name: 'Keyboard', exact: true });
		const field = window.getByRole('textbox', { name: 'Remote keyboard input', exact: true });
		const mobileCertificate = phone.getByRole('dialog', { name: 'Verify the RDP certificate', exact: true });
		const touch = await phone.context().newCDPSession(phone);
		const gatewayFrames: string[] = [];
		const portrait = phone.viewportSize()!;
		const disconnect = window.getByRole('button', { name: 'Disconnect', exact: true });
		phone.on('websocket', (socket) => {
			if (!new URL(socket.url()).pathname.endsWith('/desktop')) return;
			socket.on('framesent', ({ payload }) => {
				if (typeof payload === 'string' && payload.startsWith('5.mouse,')) gatewayFrames.push(payload);
			});
		});

		for (const [protocol, mode] of combinations) {
			await t.test('touchscreen ' + protocol + ' / ' + mode, async (scenario) => {
				scenario.after(async () => {
					await phone.evaluate(async () => {
						if (document.fullscreenElement) await document.exitFullscreen();
					});
					await phone.setViewportSize(portrait);
					if (await disconnect.isVisible()) await disconnect.tap();
				});
				await choose(phone, window, 'Saved desktop', protocol + ' fixture · ' + protocol, true);
				await choose(phone, window, 'Connection method', mode, true);
				await choose(phone, window, 'Resolution', '1280 × 720', true);
				await window.getByRole('button', { name: 'Connect', exact: true }).tap();
				if (protocol === 'RDP') {
					await mobileCertificate.getByRole('button', { name: 'Trust for this connection' }).tap();
				}
				await expect(keyboard).toBeVisible({ timeout: 15000 });
				await waitForPixels(remoteCanvas);
				assert.equal(
					await window.locator('.remote-desktop-toolbar').evaluate((toolbar) => {
						const bounds = toolbar.getBoundingClientRect();
						const controls = Array.from(toolbar.querySelectorAll('button'), (button) =>
							button.getBoundingClientRect(),
						);
						const rows = new Set(controls.map((control) => Math.round((control.top + control.bottom) / 2)));
						return (
							rows.size === 1 &&
							controls.every((control) => control.left >= bounds.left && control.right <= bounds.right)
						);
					}),
					true,
					'Connected portrait controls fit in one row',
				);
				if (protocol === 'RDP' && mode === 'Native') {
					const bounds = (await remoteCanvas.boundingBox())!;
					await phone.touchscreen.tap(bounds.x + bounds.width * 0.53, bounds.y + bounds.height * 0.59);
					await keyboard.tap();
					await expect(field).toBeFocused();
					await phone.keyboard.insertText(password);
					await phone.keyboard.press('Enter');
					await waitForRdpLogin(remoteCanvas);
					await keyboard.tap();
					await expect(field).not.toBeFocused();
				}

				const bounds = (await remoteCanvas.boundingBox())!;
				await phone.touchscreen.tap(bounds.x + bounds.width * 0.08, bounds.y + bounds.height * 0.04);
				if (mode === 'Guacamole gateway') {
					await expect
						.poll(() => gatewayFrames.splice(0).some((frame) => frame.endsWith(',1.1;')))
						.toBe(true);
				}
				await expect(field).not.toBeFocused();
				await keyboard.tap();
				await expect(field).toBeFocused();
				await expect(keyboard).toHaveAttribute('aria-pressed', 'true');

				const marker = '/tmp/nexus-mobile-' + randomUUID();
				if (protocol === 'VNC' && mode === 'Guacamole gateway') {
					await touch.send('Input.imeSetComposition', { text: 'test', selectionStart: 0, selectionEnd: 4 });
				}
				await phone.keyboard.insertText('touch ' + marker + 'x');
				await phone.keyboard.press('Backspace');
				await phone.keyboard.press('Enter');
				await waitForMarker(server, marker);
				await keyboard.tap();
				await expect(field).not.toBeFocused();

				if (protocol === 'VNC' && mode === 'Guacamole gateway') {
					const x = Math.round(bounds.x + bounds.width * 0.2);
					const y = Math.round(bounds.y + bounds.height * 0.35);
					await phone.touchscreen.tap(x + 40, y);
					await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
					try {
						await expect
							.poll(() => gatewayFrames.some((frame) => frame.endsWith(',1.4;')), {
								message: 'A long press away from the previous tap opens the remote context menu',
							})
							.toBe(true);
					} finally {
						await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
					}
					await touch.send('Input.dispatchTouchEvent', {
						type: 'touchStart',
						touchPoints: [
							{ x, y, id: 0 },
							{ x: x + 35, y, id: 1 },
						],
					});
					await touch.send('Input.dispatchTouchEvent', {
						type: 'touchMove',
						touchPoints: [
							{ x, y: y - 85, id: 0 },
							{ x: x + 35, y: y - 85, id: 1 },
						],
					});
					await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
					await expect.poll(() => gatewayFrames.some((frame) => /,(?:1\.8|2\.16);$/u.test(frame))).toBe(true);
					await phone.setViewportSize({ width: portrait.height, height: portrait.width });
					await expect(keyboard).toBeInViewport();
					const fullscreen = window.getByRole('button', { name: 'Fullscreen', exact: true });
					await phone.bringToFront();
					await fullscreen.tap();
					await expect
						.poll(() => phone.evaluate(() => !!document.fullscreenElement), {
							message: 'Enter fullscreen in landscape',
						})
						.toBe(true);
					await expect(window.locator('.remote-desktop-toolbar')).toBeHidden();
					await window.getByRole('button', { name: 'Show remote desktop controls', exact: true }).tap();
					await window.getByRole('button', { name: 'Exit fullscreen', exact: true }).tap();
					await expect
						.poll(() => phone.evaluate(() => !!document.fullscreenElement), {
							message: 'Exit fullscreen in landscape',
						})
						.toBe(false);
					await phone.setViewportSize(portrait);
				}

				await disconnect.tap();
				await expect(keyboard).toHaveCount(0);
				await expect(remoteCanvas).toHaveCount(0);
			});
		}

		await t.test(
			'permanently trusted RDP certificates survive plugin reload and prompt after rotation',
			async () => {
				await page.bringToFront();
				if (!(await desktop.isVisible())) await launcher.click();
				await choose(page, desktop, 'Saved desktop', 'RDP fixture · RDP');
				await choose(page, desktop, 'Connection method', 'Guacamole gateway');
				await button('Connect').click();
				await expect(certificate.getByRole('button', { name: 'Trust permanently' })).toBeVisible();
				await certificate.getByRole('button', { name: 'Trust permanently' }).click();
				await waitForPixels(canvas);
				await button('Disconnect').click();
				await reload(host, desktopId);
				const result = DesktopSessionResponseSchema.parse(
					await host.json(base + '/sessions', { connectionId: rdp.id, mode: 'native', display }),
				).result;
				assert.equal(result.kind, 'native');

				await docker(
					'exec',
					server,
					'sh',
					'-c',
					'openssl req -x509 -nodes -newkey rsa:2048 -days 1 -subj /CN=rotated-rdp-fixture -keyout /tmp/rdp-key.pem -out /tmp/rdp-cert.pem >/dev/null 2>&1 && cat /tmp/rdp-key.pem > /etc/xrdp/key.pem && cat /tmp/rdp-cert.pem > /etc/xrdp/cert.pem',
				);
				const rotated = DesktopSessionResponseSchema.parse(
					await host.json(base + '/sessions', { connectionId: rdp.id, mode: 'guacamole', display }),
				).result;
				assert.equal(rotated.kind, 'certificate');
				assert.notEqual(rotated.fingerprint, checked.fingerprint);
				assert.equal(rotated.previousFingerprint, checked.fingerprint);
			},
		);
	},
);
