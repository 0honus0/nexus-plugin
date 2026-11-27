import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginContextApi } from 'nexus-terminal/browser';
import { ConnectionsClient } from '../src/browser/connections-client-api.js';
import { parseQuickAddress } from '../src/browser/connection-presentation.js';
import type { ConnectionCatalog } from '../src/shared/connection-types.js';

test('合并目录请求并丢弃读取期间被新修订替代的结果', async () => {
	type Snapshot = ConnectionCatalog & { revision: number };
	const first = Promise.withResolvers<Snapshot>();
	const second = Promise.withResolvers<Snapshot>();
	const firstRequest = Promise.withResolvers<void>();
	const secondRequest = Promise.withResolvers<void>();
	let calls = 0;
	let publish!: (value: { revision: number }) => void;
	const client = new ConnectionsClient({
		signal: new AbortController().signal,

		use() {},

		app: {
			state: {
				subscribe(_name: string, _schema: unknown, observer: { updated: typeof publish }) {
					publish = observer.updated;
				},
			},
			http: {
				json() {
					calls++;
					if (calls === 1) {
						firstRequest.resolve();
						return first.promise;
					}
					secondRequest.resolve();
					return second.promise;
				},
			},
		},
	} as unknown as PluginContextApi);

	const shared = client.refresh();
	const view = new AbortController();
	const waiting = assert.rejects(client.refresh(view.signal), { name: 'AbortError' });
	await firstRequest.promise;
	view.abort();
	await waiting;
	assert.equal(calls, 1);
	publish({ revision: 2 });
	first.resolve({ revision: 1, connections: [], tags: [] });
	await secondRequest.promise;
	assert.equal(client.loaded.value, false);

	second.resolve({ revision: 2, connections: [], tags: [] });
	await shared;
	assert.equal(client.loaded.value, true);
	assert.equal(client.requests.value, 0);
	publish({ revision: 2 });
	await Promise.resolve();
	assert.equal(calls, 2);
});

test('retrying an initial failed subscription restores live updates', async () => {
	let subscriptions = 0;
	let reads = 0;
	let publish!: (value: { revision: number }) => void;
	const client = new ConnectionsClient({
		signal: new AbortController().signal,

		use() {},

		app: {
			state: {
				subscribe(_name: string, _schema: unknown, observer: { updated: typeof publish }) {
					if (++subscriptions === 1) throw new Error('fixture subscription failure');
					publish = observer.updated;
				},
			},
			http: {
				async json() {
					return { revision: ++reads, connections: [], tags: [] };
				},
			},
			log: { report() {} },
		},
	} as unknown as PluginContextApi);
	await assert.rejects(client.refresh(), /fixture subscription failure/u);
	await client.refresh();
	assert.equal(subscriptions, 2);
	assert.equal(reads, 1);
	publish({ revision: 2 });
	await client.refresh();
	assert.equal(reads, 2);
});

test('parseQuickAddress splits ssh commands, user@host:port, and IPv6 endpoints safely', () => {
	assert.deepEqual(parseQuickAddress('ssh -p 2222 root@192.168.1.10'), {
		host: '192.168.1.10',
		port: 2222,
		username: 'root',
	});
	assert.deepEqual(parseQuickAddress('ubuntu@[2001:db8::1]:2200'), {
		host: '2001:db8::1',
		port: 2200,
		username: 'ubuntu',
	});
	assert.deepEqual(parseQuickAddress('10.0.0.5:2202'), {
		host: '10.0.0.5',
		port: 2202,
	});
	assert.equal(parseQuickAddress('2001:db8::1'), undefined);
	assert.equal(parseQuickAddress('example.com'), undefined);
});
