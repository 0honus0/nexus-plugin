import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { isIP, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type BrowserContextOptions } from '@playwright/test';

const exec = promisify(execFile);

/** CDP is opt-in. The relay exposes only the disposable test host to the specified browser peer. */
export async function startBrowser(
	resources: AsyncDisposableStack,
	origin: string,
	options: BrowserContextOptions = {},
) {
	const cdp = process.env.NEXUS_TEST_CDP;
	if (!cdp) {
		const browser = await chromium.launch({ headless: true });
		resources.defer(() => browser.close());
		const context = await browser.newContext(options);
		resources.defer(() => context.close());
		return { page: await context.newPage(), origin };
	}

	const bind = process.env.NEXUS_TEST_CDP_BIND ?? '';
	const peer = new URL(cdp).hostname;
	if (isIP(bind) !== 4 || isIP(peer) !== 4) throw new Error('CDP requires explicit IPv4 bind and browser peer');
	const target = new URL(origin);
	if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1')
		throw new Error('Only an isolated loopback test host may be relayed');

	const directory = await mkdtemp(join(tmpdir(), 'nexus-test-cdp-'));
	resources.defer(() => rm(directory, { recursive: true, force: true }));
	const key = join(directory, 'key.pem');
	const cert = join(directory, 'cert.pem');
	await exec('openssl', [
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-days',
		'1',
		'-subj',
		'/CN=' + bind,
		'-addext',
		'subjectAltName=IP:' + bind,
		'-keyout',
		key,
		'-out',
		cert,
	]);
	const server = createServer({ key: await readFile(key), cert: await readFile(cert) }, (incoming, outgoing) => {
		if (incoming.socket.remoteAddress !== peer && incoming.socket.remoteAddress !== bind)
			return void outgoing.writeHead(403).end();
		const upstream = request(
			new URL(target.origin + (incoming.url?.startsWith('/') ? incoming.url : '/')),
			{
				method: incoming.method,
				headers: incoming.headers,
			},
			(response) => {
				outgoing.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(outgoing);
			},
		);
		upstream.on('error', () => outgoing.destroy());
		outgoing.on('close', () => upstream.destroy());
		incoming.pipe(upstream);
	});
	const sockets = new Set<import('node:net').Socket>();
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
	});
	server.on('upgrade', (incoming, socket, head) => {
		if (incoming.socket.remoteAddress !== peer && incoming.socket.remoteAddress !== bind)
			return void socket.destroy();
		const upstream = request(new URL(target.origin + (incoming.url?.startsWith('/') ? incoming.url : '/')), {
			method: incoming.method,
			headers: incoming.headers,
		});
		upstream.on('upgrade', (response, remote, initial) => {
			socket.write(
				'HTTP/1.1 101 Switching Protocols\r\n' +
					response.rawHeaders.reduce(
						(result, value, index) => result + value + (index % 2 === 0 ? ': ' : '\r\n'),
						'',
					) +
					'\r\n',
			);
			if (initial.length) socket.write(initial);
			if (head.length) remote.write(head);
			remote.on('error', () => socket.destroy());
			socket.on('error', () => remote.destroy());
			socket.on('close', () => remote.destroy());
			remote.on('close', () => socket.destroy());
			socket.pipe(remote).pipe(socket);
		});
		upstream.on('response', (response) => {
			response.resume();
			socket.destroy();
		});
		upstream.on('error', () => socket.destroy());
		upstream.end();
	});
	server.listen(0, bind);
	await once(server, 'listening');
	resources.defer(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const browser = await chromium.connectOverCDP(cdp, { noDefaults: true });
	resources.defer(() => browser.close());
	const context = await browser.newContext({ ...options, ignoreHTTPSErrors: true });
	resources.defer(() => context.close());
	return { page: await context.newPage(), origin: 'https://' + bind + ':' + (server.address() as AddressInfo).port };
}
