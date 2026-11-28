import type { CredentialsClientApi } from '@nexus-terminal/credentials/credentials-client-api';
import { PluginHttpError, type PluginContextApi, type PluginViewApi } from 'nexus-terminal/browser';
import { computed, readonly, ref, shallowReadonly, shallowRef, type Ref } from 'vue';
import { z } from 'zod';
import { ConnectionCatalogResponseSchema } from '../shared/connection-http-types.js';
import {
	ConnectionEditorRequestSchema,
	ConnectionInputSchema,
	ConnectionSchema,
	ConnectionsRevisionSchema,
	type Connection,
	type ConnectionCatalog,
	type ConnectionInput,
	type ConnectionEditorRequest,
} from '../shared/connection-types.js';

export type {
	Connection,
	ConnectionCatalog,
	ConnectionInput,
	ConnectionEditorRequest,
	ConnectionType,
	Tag,
} from '../shared/connection-types.js';

export interface ConnectionCreateOptions {
	readonly view?: PluginViewApi;
	readonly signal?: AbortSignal;
}

export interface ConnectionsClientApi {
	readonly catalog: Readonly<Ref<ConnectionCatalog>>;
	readonly loaded: Readonly<Ref<boolean>>;
	readonly desktopAvailable: Readonly<Ref<boolean>>;
	refresh(signal?: AbortSignal): Promise<void>;
	openManager(): void;
	openDesktop(id: string): void;
	registerDesktopOpener(open: (id: string) => void): () => void;
	openEditor(request: ConnectionEditorRequest, signal?: AbortSignal): Promise<void>;
	create(input: ConnectionInput, options?: ConnectionCreateOptions): Promise<Connection>;
}

declare module 'nexus-terminal/browser' {
	interface PluginServicesApi {
		readonly '@nexus-terminal/connections': { readonly connections: ConnectionsClientApi };
	}
}

export class ConnectionsClient implements ConnectionsClientApi {
	readonly #catalog = shallowRef<ConnectionCatalog>({ connections: [], tags: [] });
	readonly #requests = ref(0);
	readonly #loaded = ref(false);
	readonly #credentials = shallowRef<CredentialsClientApi>();
	readonly #editor = shallowRef<ConnectionEditorRequest>();
	readonly #desktopOpener = shallowRef<(id: string) => void>();
	readonly catalog = shallowReadonly(this.#catalog);
	readonly loaded = readonly(this.#loaded);
	readonly requests = readonly(this.#requests);
	readonly credentials = shallowReadonly(this.#credentials);
	readonly editorRequest = shallowReadonly(this.#editor);
	readonly desktopAvailable = computed(() => !!this.#desktopOpener.value);
	#subscribed = false;
	#reading: Promise<void> | undefined;
	#revision: number | undefined;
	#snapshotRevision: number | undefined;
	#generation = 0;
	#navigation = 0;

	readonly #context: PluginContextApi;

	constructor(ctx: PluginContextApi) {
		this.#context = ctx;
		ctx.use({ credentials: ['@nexus-terminal/credentials', 'credentials'] }, (scope) => {
			this.#credentials.value = scope.plugin.credentials;
			scope.onDispose(() => {
				this.#credentials.value = undefined;
			});
		});
	}

	openManager(): void {
		this.#context.app.windows.open('main');
	}

	openDesktop(id: string): void {
		this.#context.signal.throwIfAborted();
		this.#desktopOpener.value?.(id);
	}

	registerDesktopOpener(open: (id: string) => void): () => void {
		this.#context.signal.throwIfAborted();
		this.#desktopOpener.value = open;
		return () => {
			if (this.#desktopOpener.value === open) this.#desktopOpener.value = undefined;
		};
	}

	async openEditor(input: ConnectionEditorRequest, signal?: AbortSignal): Promise<void> {
		const request = ConnectionEditorRequestSchema.parse(input);
		const navigation = ++this.#navigation;
		await this.refresh(signal);
		this.#context.signal.throwIfAborted();
		signal?.throwIfAborted();
		if (navigation !== this.#navigation) return;
		if (!this.#catalog.value.connections.some(({ id }) => id === request.connectionId))
			throw new Error('CONNECTIONS_NOT_FOUND');

		const previous = this.#editor.value;
		this.#editor.value = request;
		try {
			this.openManager();
		} catch (cause) {
			this.#editor.value = previous;
			throw cause;
		}
	}

	clearEditorRequest(request: ConnectionEditorRequest): void {
		if (this.#editor.value === request) this.#editor.value = undefined;
	}

	async refresh(signal?: AbortSignal): Promise<void> {
		this.#context.signal.throwIfAborted();
		signal?.throwIfAborted();

		const reading = (this.#reading ??= Promise.resolve()
			.then(() => this.#read())
			.finally(() => {
				this.#reading = undefined;
			}));
		if (!signal) return reading;

		// 关闭一个窗口只取消它的等待，桌面和其他窗口仍可使用共享读取。
		return new Promise((resolve, reject) => {
			const abort = () => reject(signal.reason);

			signal.addEventListener('abort', abort, { once: true });
			void reading.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
		});
	}

	async #read(): Promise<void> {
		const signal = AbortSignal.any([this.#context.signal, AbortSignal.timeout(5_000)]);
		signal.throwIfAborted();
		if (!this.#subscribed) {
			this.#context.app.state.subscribe('connections', ConnectionsRevisionSchema, {
				updated: ({ revision }) => {
					this.#revision = revision;
					if (!this.#reading && revision !== this.#snapshotRevision)
						void this.refresh().catch((cause) => this.report(cause, undefined, false));
				},

				unconfirmed: () => {
					if (this.#revision !== undefined) this.#generation++;
					this.#revision = undefined;
					this.#snapshotRevision = undefined;
				},
			});
			this.#subscribed = true;
		}
		this.#requests.value++;
		try {
			for (;;) {
				const observed = this.#revision;
				const generation = this.#generation;
				const { revision, ...catalog } = await this.#context.app.http.json(
					'/catalog',
					ConnectionCatalogResponseSchema,
					{ signal },
				);
				signal.throwIfAborted();
				if (
					generation !== this.#generation ||
					(this.#revision !== observed && this.#revision !== undefined && this.#revision !== revision)
				)
					continue;
				this.#snapshotRevision = revision ?? observed;
				this.#catalog.value = catalog;
				this.#loaded.value = true;
				return;
			}
		} finally {
			this.#requests.value--;
		}
	}

	report(cause: unknown, signal?: AbortSignal, userVisible = true): void {
		if (this.#context.signal.aborted || signal?.aborted) return;
		const code =
			cause instanceof PluginHttpError
				? cause.code
				: cause instanceof Error && /^(?:CONNECTIONS|CREDENTIALS)_[A-Z_]+$/u.test(cause.message)
					? cause.message
					: 'CONNECTIONS_OPERATION_FAILED';
		this.#context.app.log.report({ level: 'error', code, userVisible });
	}

	async create(input: ConnectionInput, options?: ConnectionCreateOptions): Promise<Connection> {
		const parsed = ConnectionInputSchema.safeParse(input);
		if (!parsed.success)
			throw Object.assign(new Error('CONNECTIONS_INVALID_REQUEST'), { code: 'CONNECTIONS_INVALID_REQUEST' });
		const created = await this.save(parsed.data, undefined, options?.view, options?.signal);
		// 立即同步本地目录，调用方在保存后即可直接基于返回 ID 发起连接。
		this.#catalog.value = {
			...this.#catalog.value,
			connections: [...this.#catalog.value.connections.filter(({ id }) => id !== created.id), created],
		};
		this.#loaded.value = true;
		void this.refresh().catch((cause) => this.report(cause, undefined, false));
		return created;
	}

	save(connection: ConnectionInput, id: string | undefined, view?: PluginViewApi, signal?: AbortSignal) {
		return this.#context.app.tasks.run(
			async (activeSignal) => {
				const result = await this.#context.app.http.json(
					id ? '/connections/' + encodeURIComponent(id) : '/connections',
					ConnectionSchema,
					{
						method: id ? 'PUT' : 'POST',
						signal: activeSignal,
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ connection }),
					},
				);
				activeSignal.throwIfAborted();
				this.#generation++;
				this.#context.app.log.report({ level: 'info', code: 'CONNECTION_SAVED', userVisible: true });
				return result;
			},
			{ view, signal },
		);
	}

	remove(id: string, view: PluginViewApi) {
		return this.#delete('/connections/' + encodeURIComponent(id), 'CONNECTION_DELETED', view);
	}

	removeTag(id: string, view: PluginViewApi) {
		return this.#delete('/tags/' + encodeURIComponent(id), 'CONNECTION_TAG_DELETED', view);
	}

	#delete(path: string, code: string, view: PluginViewApi) {
		return this.#context.app.tasks.run(
			async (signal) => {
				await this.#context.app.http.json(path, z.undefined(), { method: 'DELETE', signal });
				signal.throwIfAborted();
				this.#generation++;
				this.#context.app.log.report({ level: 'info', code, userVisible: true });
			},
			{ view },
		);
	}
}
