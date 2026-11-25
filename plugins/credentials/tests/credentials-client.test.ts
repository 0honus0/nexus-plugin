import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginContextApi } from 'nexus-terminal/browser';
import { CredentialsClient } from '../src/browser/credentials-client-api.js';
import type { CredentialsSnapshot } from '../src/shared/credentials-types.js';

function fixture() {
	let subscriptions = 0;
	let reads = 0;
	let fail = false;
	let observer!: { updated(value: { revision: number }): void; unconfirmed?(): void };
	const responses: Promise<CredentialsSnapshot>[] = [];
	const client = new CredentialsClient({
		signal: new AbortController().signal,
		app: {
			state: {
				subscribe(_name: string, _schema: unknown, next: typeof observer) {
					subscriptions++;
					if (fail) throw new Error('fixture subscription failed');
					observer = next;
				},
			},
			http: {
				json() {
					reads++;
					const response = responses.shift();
					assert.ok(response);
					return response;
				},
			},
			log: { report() {} },
		},
	} as unknown as PluginContextApi);
	return {
		client,
		responses,

		counts: () => [subscriptions, reads],

		fail: (value: boolean) => {
			fail = value;
		},

		observer: () => observer,
	};
}

test('a failed subscription can be registered again on refresh', async () => {
	const f = fixture();
	f.fail(true);
	await assert.rejects(f.client.refresh(), /fixture subscription failed/u);
	f.fail(false);
	f.responses.push(Promise.resolve({ revision: 0, items: [] }));
	await f.client.refresh();
	assert.deepEqual(f.counts(), [2, 1]);
});

test('reconfirms catalog metadata at the same revision after topic withdrawal and ignores the old read', async () => {
	const f = fixture();
	const old = {
		id: 'f89f14a1-792d-48ea-93c7-3c34ec7bb37c',
		name: 'Old fixture',
		username: 'fixture',
		type: 'password' as const,
		hasPassphrase: false,
		createdAt: 1,
		updatedAt: 1,
	};
	const fresh = { ...old, name: 'New fixture' };
	f.responses.push(Promise.resolve({ revision: 0, items: [old] }));
	await f.client.refresh();
	const pending = Promise.withResolvers<CredentialsSnapshot>();
	f.responses.push(pending.promise);
	const reading = f.client.refresh();
	f.observer().unconfirmed?.();
	pending.resolve({ revision: 0, items: [old] });
	await reading;
	f.responses.push(Promise.resolve({ revision: 0, items: [fresh] }));
	f.observer().updated({ revision: 0 });
	await Promise.resolve();
	assert.deepEqual(f.counts(), [1, 3]);
	assert.deepEqual(f.client.items.value, [fresh]);
});
