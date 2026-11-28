import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Socket } from 'node:net';
import { test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { DesktopService } from '../src/node/desktop-service.js';
import { DesktopSessionResponseSchema, type DesktopSessionInput } from '../src/shared/desktop-session.js';

const connectionId = randomUUID();
const display = { width: 960, height: 640, dpi: 96 };
const input: DesktopSessionInput = { connectionId, mode: 'native', display };
const unusedTrust = {
	getFingerprint: async () => assert.fail(),

	rememberFingerprint: async () => assert.fail(),
};

function connection(port: number, credentialId: string | null = null) {
	return {
		id: connectionId,
		name: 'VNC test',
		type: 'vnc' as const,
		host: '127.0.0.1',
		port,
		credentialId,
		username: '',
		domain: '',
		notes: '',
		tags: [],
		createdAt: 1,
		updatedAt: 1,
	};
}

async function target(resources: AsyncDisposableStack, handle: (socket: Socket) => void): Promise<number> {
	const sockets = new Set<Socket>();
	const server = createServer((socket) => {
		sockets.add(socket);
		socket.once('close', () => sockets.delete(socket));
		handle(socket);
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	resources.defer(async () => {
		for (const socket of sockets) socket.destroy();
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	return address.port;
}

async function sockets(resources: AsyncDisposableStack, service: DesktopService) {
	const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
	const attached = new Set<Promise<void>>();
	server.on('connection', (socket, request) => {
		const scope = new AbortController();
		socket.once('close', () => scope.abort());
		const token = new URL(request.url ?? '/', 'ws://localhost').searchParams.get('ticket');
		const handling = service.attach(socket, token, scope.signal);
		attached.add(handling);
		void handling.finally(() => attached.delete(handling));
	});
	await once(server, 'listening');
	resources.defer(async () => {
		for (const client of server.clients) client.terminate();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await Promise.all(attached);
		await service.dispose();
	});
	const address = server.address();
	assert.ok(address && typeof address !== 'string');
	return (ticket: string) => new WebSocket('ws://127.0.0.1:' + address.port + '/?ticket=' + ticket);
}

test(
	'native VNC grants are single-use and cannot be redirected by changing the saved target',
	{ timeout: 8000 },
	async () => {
		await using resources = new AsyncDisposableStack();
		let connected = 0;
		const port = await target(resources, (socket) => {
			connected++;
			socket.write('RFB 003.008\n');
		});
		let current = connection(port);
		const service = new DesktopService(
			{ get: async () => current },
			{ resolve: async () => assert.fail() },
			null,
			unusedTrust,
		);
		const connect = await sockets(resources, service);
		const { signal } = new AbortController();
		const session = DesktopSessionResponseSchema.parse(await service.issue(input, signal)).result;
		assert.equal(session.kind, 'native');
		const socket = connect(session.ticket);
		const [message, binary] = await once(socket, 'message');
		assert.equal(binary, true);
		assert.equal(String(message), 'RFB 003.008\n');
		const [replayClose] = await once(connect(session.ticket), 'close');
		assert.equal(replayClose, 1008);
		assert.equal(connected, 1);
		socket.close();

		const stale = (await service.issue(input, signal)).result;
		assert.equal(stale.kind, 'native');
		current = { ...current, port: port + 1, updatedAt: 2 };
		const [changedClose] = await once(connect(stale.ticket), 'close');
		assert.equal(changedClose, 1011);
		assert.equal(connected, 1);
	},
);

test('Guacamole keeps passwords out of the browser grant and forwards through guacd', { timeout: 8000 }, async () => {
	await using resources = new AsyncDisposableStack();
	const handshake = Promise.withResolvers<string>();
	const gatewayPort = await target(resources, (socket) => {
		socket.setEncoding('utf8');
		let data = '';
		let sent = false;
		socket.on('data', (chunk: string) => {
			data += chunk;
			if (data === '6.select,3.vnc;') {
				socket.write('4.args,13.VERSION_1_1_0,8.hostname,4.port,8.password;');
			}
			if (!sent && data.includes('7.connect,')) {
				sent = true;
				handshake.resolve(data);
				socket.write('5.ready,7.fixture;');
			}
		});
	});
	const credentialId = randomUUID();
	const service = new DesktopService(
		{ get: async () => connection(5900, credentialId) },
		{
			resolve: async () => ({
				name: 'Fixture',
				type: 'password',
				username: 'unused',
				password: 'vnc-test-password',
			}),
		},
		{ host: '127.0.0.1', port: gatewayPort },
		unusedTrust,
	);
	const connect = await sockets(resources, service);
	const response = await service.issue({ ...input, mode: 'guacamole' }, new AbortController().signal);
	const session = DesktopSessionResponseSchema.parse(response).result;
	assert.equal(session.kind, 'guacamole');
	assert.deepEqual(Object.keys(session).sort(), ['kind', 'ticket']);
	const socket = connect(session.ticket);
	const [message, binary] = await once(socket, 'message');
	assert.equal(binary, false);
	assert.equal(String(message), '0.,7.fixture;');
	assert.match(
		await handshake.promise,
		/7\.connect,13\.VERSION_1_1_0,9\.127\.0\.0\.1,4\.5900,17\.vnc-test-password;/u,
	);
	socket.close();
});

test('session admission rejects unsupported targets and invalid credentials before connecting', async () => {
	const signal = new AbortController().signal;
	const fingerprint = Array.from({ length: 32 }, () => 'AA').join(':');
	let current:
		ReturnType<typeof connection> | (Omit<ReturnType<typeof connection>, 'type'> & { type: 'ssh' }) | undefined;
	const service = new DesktopService(
		{ get: async () => current },
		{ resolve: async () => ({ type: 'privateKey', username: 'test', name: 'Test key', privateKey: 'fixture' }) },
		null,
		unusedTrust,
	);
	try {
		await assert.rejects(service.issue({ ...input, mode: 'guacamole' }, signal), {
			status: 503,
			code: 'DESKTOP_GATEWAY_UNAVAILABLE',
		});
		await assert.rejects(service.issue(input, signal), { status: 404, code: 'DESKTOP_CONNECTION_NOT_FOUND' });
		current = { ...connection(22), type: 'ssh' };
		await assert.rejects(service.issue(input, signal), { status: 422, code: 'DESKTOP_PROTOCOL_UNSUPPORTED' });
		current = connection(5900);
		await assert.rejects(
			service.issue(
				{
					...input,
					trust: { host: '127.0.0.1', port: 5900, fingerprint, previousFingerprint: null, permanent: false },
				},
				signal,
			),
			{
				status: 422,
				code: 'DESKTOP_PROTOCOL_UNSUPPORTED',
			},
		);
		current = connection(5900, randomUUID());
		await assert.rejects(service.issue(input, signal), { status: 422, code: 'DESKTOP_PASSWORD_REQUIRED' });
	} finally {
		await service.dispose();
	}
});

test('expired and cancelled tickets leave room for new grants', { timeout: 8000 }, async (t) => {
	await using resources = new AsyncDisposableStack();
	t.mock.timers.enable({ apis: ['Date'], now: 1000 });
	const service = new DesktopService(
		{ get: async () => connection(5900) },
		{ resolve: async () => assert.fail() },
		null,
		unusedTrust,
	);
	const connect = await sockets(resources, service);
	const { signal } = new AbortController();
	const first = (await service.issue(input, signal)).result;
	assert.equal(first.kind, 'native');
	for (let i = 1; i < 64; i++) await service.issue(input, signal);
	await assert.rejects(service.issue(input, signal), { status: 429, code: 'DESKTOP_BUSY' });
	t.mock.timers.tick(30_000);
	const [expired] = await once(connect(first.ticket), 'close');
	assert.equal(expired, 1008);
	const aborted = new AbortController();
	aborted.abort();
	await assert.rejects(service.issue(input, aborted.signal), { name: 'AbortError' });
	assert.equal((await service.issue(input, signal)).result.kind, 'native');
});

test(
	'Guacamole disconnect during the handshake closes upstream and releases all session slots',
	{ timeout: 12000 },
	async () => {
		await using resources = new AsyncDisposableStack();
		const ready = new Map<
			number,
			{
				connected: ReturnType<typeof Promise.withResolvers<Socket>>;
				closed: ReturnType<typeof Promise.withResolvers<void>>;
			}
		>();
		for (let index = 0; index < 16; index++)
			ready.set(index, { connected: Promise.withResolvers<Socket>(), closed: Promise.withResolvers<void>() });
		let accepted = 0;
		const gatewayPort = await target(resources, (upstream) => {
			const lifecycle = ready.get(accepted++);
			upstream.on('error', () => undefined);
			upstream.once('data', () => lifecycle?.connected.resolve(upstream));
			upstream.once('close', () => lifecycle?.closed.resolve());
		});
		const service = new DesktopService(
			{ get: async () => connection(5900) },
			{ resolve: async () => assert.fail() },
			{ host: '127.0.0.1', port: gatewayPort },
			unusedTrust,
		);
		const connect = await sockets(resources, service);
		const { signal } = new AbortController();

		async function open() {
			const session = (await service.issue({ ...input, mode: 'guacamole' }, signal)).result;
			assert.equal(session.kind, 'guacamole');
			return connect(session.ticket);
		}

		const clients = await Promise.all(Array.from({ length: 16 }, () => open()));
		await Promise.all([...ready.values()].map(({ connected }) => connected.promise));
		const [busy] = await once(await open(), 'close');
		assert.equal(busy, 1013);
		assert.equal(accepted, 16);
		await Promise.all(
			clients.map(async (client) => {
				const closed = once(client, 'close');
				client.close();
				await closed;
			}),
		);
		await Promise.all([...ready.values()].map(({ closed }) => closed.promise));
		const additional = await open();
		await once(additional, 'open');
		await tWaitFor(() => accepted === 17);
		additional.close();
	},
);

async function tWaitFor(predicate: () => boolean): Promise<void> {
	const deadline = AbortSignal.timeout(2000);
	while (!predicate()) {
		deadline.throwIfAborted();
		await new Promise((resolve) => setTimeout(resolve, 15));
	}
}
