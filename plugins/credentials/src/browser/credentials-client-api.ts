import { PluginHttpError, type PluginContextApi, type PluginViewApi } from 'nexus-terminal/browser';
import { readonly, ref, shallowRef, type Ref } from 'vue';
import { z } from 'zod';
import {
	CredentialInputSchema,
	CredentialSchema,
	CredentialsRevisionSchema,
	CredentialsSnapshotSchema,
	type Credential,
	type CredentialInput,
	type CredentialPatch,
} from '../shared/credentials-types.js';

export type { Credential, CredentialInput, CredentialPatch } from '../shared/credentials-types.js';

export interface CredentialCreateOptions {
	readonly view?: PluginViewApi;
	readonly signal?: AbortSignal;
	readonly silent?: boolean;
}

export interface CredentialsClientApi {
	readonly items: Readonly<Ref<readonly Credential[]>>;
	readonly loaded: Readonly<Ref<boolean>>;
	refresh(signal?: AbortSignal): Promise<void>;
	openManager(): void;
	create(input: CredentialInput, options?: CredentialCreateOptions): Promise<Credential>;
}

declare module 'nexus-terminal/browser' {
	interface PluginServicesApi {
		readonly '@nexus-terminal/credentials': { readonly credentials: CredentialsClientApi };
	}
}

export class CredentialsClient implements CredentialsClientApi {
	readonly #items = shallowRef<readonly Credential[]>([]);
	readonly #loaded = ref(false);
	readonly #requests = ref(0);
	readonly items = readonly(this.#items);
	readonly loaded = readonly(this.#loaded);
	readonly pending = readonly(this.#requests);
	#revision: number | undefined;
	#request = 0;
	#applied = 0;
	#subscribed = false;

	readonly #context: PluginContextApi;

	constructor(context: PluginContextApi) {
		this.#context = context;
	}

	openManager(): void {
		this.#context.app.windows.open('main');
	}

	async refresh(signal?: AbortSignal): Promise<void> {
		this.#context.signal.throwIfAborted();
		signal?.throwIfAborted();
		if (!this.#subscribed) {
			this.#subscribed = true;
			try {
				this.#context.app.state.subscribe('credentials', CredentialsRevisionSchema, {
					updated: ({ revision }) => {
						if (revision !== this.#revision)
							void this.refresh().catch((cause) => this.report(cause, undefined, false));
					},

					unconfirmed: () => {
						this.#revision = undefined;
						// A late read from the previous topic instance cannot reconfirm its revision.
						this.#applied = ++this.#request;
					},
				});
			} catch (cause) {
				this.#subscribed = false;
				throw cause;
			}
		}
		const request = ++this.#request;
		this.#requests.value++;
		try {
			const data = await this.#context.app.http.json('/credentials', CredentialsSnapshotSchema, { signal });
			this.#context.signal.throwIfAborted();
			signal?.throwIfAborted();
			if (request < this.#applied) return;
			this.#applied = request;
			this.#revision = data.revision;
			this.#items.value = data.items;
			this.#loaded.value = true;
		} finally {
			this.#requests.value--;
		}
	}

	report(cause: unknown, signal?: AbortSignal, userVisible = true): void {
		if (this.#context.signal.aborted || signal?.aborted) return;
		const code =
			cause instanceof PluginHttpError
				? cause.code
				: cause instanceof Error && /^CREDENTIALS_[A-Z_]+$/u.test(cause.message)
					? cause.message
					: 'CREDENTIALS_OPERATION_FAILED';
		this.#context.app.log.report({ level: 'error', code, userVisible });
	}

	create(input: CredentialInput, options?: CredentialCreateOptions) {
		const parsed = CredentialInputSchema.safeParse(input);
		if (!parsed.success)
			return Promise.reject(
				Object.assign(new Error('CREDENTIALS_INVALID_REQUEST'), { code: 'CREDENTIALS_INVALID_REQUEST' }),
			);
		return this.save(parsed.data, undefined, options?.view, {
			signal: options?.signal,
			silent: options?.silent,
		});
	}

	save(
		value: CredentialInput | CredentialPatch,
		id: string | undefined,
		view?: PluginViewApi,
		options?: { signal?: AbortSignal; silent?: boolean },
	) {
		return this.#context.app.tasks.run(
			async (signal) => {
				const url = id ? '/credentials/' + encodeURIComponent(id) : '/credentials';
				const item = await this.#context.app.http.json(url, CredentialSchema, {
					method: id ? 'PATCH' : 'POST',
					signal,
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(id ? { patch: value } : { credential: value }),
				});
				signal.throwIfAborted();
				if (!options?.silent)
					this.#context.app.log.report({ level: 'info', code: 'CREDENTIALS_SAVED', userVisible: true });
				this.#items.value = [...this.#items.value.filter(({ id }) => id !== item.id), item];
				return item;
			},
			{ view, signal: options?.signal },
		);
	}

	remove(id: string, view: PluginViewApi) {
		return this.#context.app.tasks.run(
			async (signal) => {
				await this.#context.app.http.json('/credentials/' + encodeURIComponent(id), z.undefined(), {
					method: 'DELETE',
					signal,
				});
				signal.throwIfAborted();
				this.#context.app.log.report({ level: 'info', code: 'CREDENTIALS_DELETED', userVisible: true });
				this.#items.value = this.#items.value.filter((item) => item.id !== id);
			},
			{ view },
		);
	}
}
