import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { HttpFailure } from 'nexus-terminal/node';
import type { ConnectionsApi, Connection } from '@nexus-terminal/connections/connections-api';
import type { CredentialsApi } from '@nexus-terminal/credentials/credentials-api';
import type WebSocket from 'ws';
import type { z } from 'zod';
import {
	DesktopProtocolSchema,
	type DesktopSessionInput,
	type DesktopSessionResponseSchema,
} from '../shared/desktop-session.js';
import { BrowserDesktopAdapter } from './adapters/browser-desktop.js';
import { bridgeGuacamole, type guacamoleEndpoint } from './adapters/guacamole.js';
import type { DesktopStorage } from './desktop-storage.js';

const ticketLifetime = 30_000;
const pendingLimit = 64;
const activeLimit = 16;

interface Grant {
	readonly input: DesktopSessionInput;
	readonly connection: Connection;
	readonly expires: number;
	readonly fingerprint: string | null;
}

export class DesktopService {
	readonly #native = new BrowserDesktopAdapter();
	readonly #grants = new Map<string, Grant>();
	#issuing = 0;
	#active = 0;

	constructor(
		private readonly connections: Pick<ConnectionsApi, 'get'>,
		private readonly credentials: Pick<CredentialsApi, 'resolve'>,
		private readonly gateway: ReturnType<typeof guacamoleEndpoint>,
		private readonly storage: Pick<DesktopStorage, 'getFingerprint' | 'rememberFingerprint'>,
	) {}

	async issue(
		input: DesktopSessionInput,
		signal: AbortSignal,
	): Promise<z.infer<typeof DesktopSessionResponseSchema>> {
		const now = Date.now();
		for (const [key, grant] of this.#grants) {
			if (grant.expires <= now) this.#grants.delete(key);
		}
		if (this.#issuing + this.#grants.size >= pendingLimit) throw new HttpFailure(429, 'DESKTOP_BUSY');
		if (input.mode === 'guacamole' && !this.gateway) throw new HttpFailure(503, 'DESKTOP_GATEWAY_UNAVAILABLE');
		this.#issuing++;
		try {
			const connection = await this.connections.get(input.connectionId);
			signal.throwIfAborted();
			if (!connection) throw new HttpFailure(404, 'DESKTOP_CONNECTION_NOT_FOUND');
			const protocol = DesktopProtocolSchema.safeParse(connection.type);
			if (!protocol.success) throw new HttpFailure(422, 'DESKTOP_PROTOCOL_UNSUPPORTED');
			if (connection.type === 'vnc' && input.trust) throw new HttpFailure(422, 'DESKTOP_PROTOCOL_UNSUPPORTED');

			const identity = await this.#identity(connection);
			signal.throwIfAborted();
			let fingerprint: string | null = null;
			if (connection.type === 'rdp') {
				const probe = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
				const { host, port } = connection;
				const certificate = await this.#native.probeCertificate(host, port, probe).catch(() => {
					signal.throwIfAborted();
					throw new HttpFailure(502, 'DESKTOP_ENDPOINT_UNAVAILABLE');
				});
				signal.throwIfAborted();
				fingerprint = certificate.fingerprint;
				let previousFingerprint = await this.storage.getFingerprint(host, port);
				signal.throwIfAborted();
				const { trust } = input;
				let trusted =
					!trust &&
					(previousFingerprint
						? previousFingerprint === fingerprint
						: certificate.systemTrusted && certificate.hostMatches);
				if (trust?.host === host && trust.port === port && trust.fingerprint === fingerprint) {
					trusted =
						!trust.permanent ||
						(await this.storage.rememberFingerprint(
							host,
							port,
							fingerprint,
							trust.previousFingerprint,
							signal,
						));
					if (!trusted) previousFingerprint = await this.storage.getFingerprint(host, port);
				}
				signal.throwIfAborted();
				if (!trusted) {
					return {
						result: {
							kind: 'certificate',
							host,
							port,
							fingerprint,
							previousFingerprint,
							subject: certificate.subject,
							issuer: certificate.issuer,
						},
					};
				}
			}

			const ticket = randomBytes(32).toString('base64url');
			this.#grants.set(ticket, { connection, input, expires: Date.now() + ticketLifetime, fingerprint });
			return {
				result:
					input.mode === 'native'
						? {
								kind: 'native',
								ticket,
								protocol: protocol.data,
								host: connection.host,
								port: connection.port,
								...identity,
							}
						: { kind: 'guacamole', ticket },
			};
		} finally {
			this.#issuing--;
		}
	}

	async attach(socket: WebSocket, token: string | null, signal: AbortSignal): Promise<void> {
		const grant = token ? this.#grants.get(token) : undefined;
		if (!grant || !token) return socket.close(1008);
		this.#grants.delete(token);
		if (grant.expires <= Date.now() || signal.aborted) return socket.close(1008);
		if (this.#active >= activeLimit) return socket.close(1013);
		this.#active++;

		let released = false;

		const release = () => {
			if (!released) {
				released = true;
				this.#active--;
			}
		};

		let peer: ReturnType<BrowserDesktopAdapter['bind']> | undefined;
		try {
			if (grant.input.mode === 'native') peer = this.#native.bind(socket);
			const current = await this.connections.get(grant.connection.id);
			signal.throwIfAborted();
			if (!current || !isDeepStrictEqual(current, grant.connection))
				throw new Error('DESKTOP_CONNECTION_CHANGED');
			const protocol = DesktopProtocolSchema.parse(current.type);
			const endpoint = { protocol, host: current.host, port: current.port };
			if (peer) {
				await peer.open({ ...endpoint, certificateFingerprint: grant.fingerprint }, release);
			} else if (this.gateway) {
				const identity = await this.#identity(current);
				signal.throwIfAborted();
				await bridgeGuacamole(
					socket,
					this.gateway,
					{
						...endpoint,
						...identity,
						fingerprint: grant.fingerprint,
						display: grant.input.display,
					},
					signal,
				);
			}
		} catch {
			socket.close(1011);
		} finally {
			if (!peer) release();
			else if (signal.aborted || socket.readyState !== socket.OPEN) release();
		}
	}

	async dispose(): Promise<void> {
		this.#grants.clear();
		await this.#native.close();
	}

	async #identity(connection: Connection): Promise<{ username: string; domain: string; password: string }> {
		if (!connection.credentialId) {
			if (connection.type === 'vnc') return { username: '', domain: '', password: '' };
			throw new HttpFailure(422, 'DESKTOP_PASSWORD_REQUIRED');
		}
		const saved = await this.credentials.resolve(connection.credentialId).catch(() => {
			throw new HttpFailure(422, 'DESKTOP_PASSWORD_REQUIRED');
		});
		if (saved.type !== 'password') throw new HttpFailure(422, 'DESKTOP_PASSWORD_REQUIRED');
		const username = connection.type === 'rdp' ? saved.username || connection.username : '';
		const slash = username.indexOf('\\');
		return {
			username: slash < 0 ? username : username.slice(slash + 1),
			domain: connection.domain || (slash < 0 ? '' : username.slice(0, slash)),
			password: saved.password,
		};
	}
}
