import GuacdClient from 'guacamole-lite/lib/GuacdClient.js';
import type WebSocket from 'ws';
import type { RawData } from 'ws';
import type { DesktopDisplay, DesktopProtocol } from '../../shared/desktop-session.js';

export interface GuacamoleTarget {
	protocol: DesktopProtocol;
	host: string;
	port: number;
	username: string;
	domain: string;
	password: string;
	fingerprint: string | null;
	display: DesktopDisplay;
}

export function guacamoleEndpoint(env: {
	NEXUS_GUACD_HOST?: string;
	NEXUS_GUACD_PORT?: string;
}): { host: string; port: number } | null {
	const host = env.NEXUS_GUACD_HOST?.trim();
	if (!host) return null;
	const port = Number(env.NEXUS_GUACD_PORT ?? 4822);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? { host, port } : null;
}

const browserBufferLimit = 4 * 1024 * 1024;
const inputBufferLimit = 1024 * 1024;

export function bridgeGuacamole(
	browser: WebSocket,
	endpoint: NonNullable<ReturnType<typeof guacamoleEndpoint>>,
	target: GuacamoleTarget,
	signal: AbortSignal,
): Promise<void> {
	signal.throwIfAborted();
	const { protocol, host, port, username, domain, password, fingerprint, display } = target;
	const client = new GuacdClient(
		endpoint,
		protocol,
		{
			...display,
			hostname: host,
			port,
			username,
			password,
			image: ['image/webp', 'image/png', 'image/jpeg'],
			audio: ['audio/L16', 'audio/L8'],
			...(protocol === 'rdp' && {
				domain,
				security: 'any',
				'ignore-cert': 'false',
				'cert-fingerprints': fingerprint ? 'sha256:' + fingerprint.toLowerCase() : '',
				'resize-method': 'display-update',
			}),
		},
		{ log() {} },
	);
	const upstream = client.guacdConnection;
	// Guacamole protocol strings may contain UTF-8 split across TCP reads.
	upstream.setEncoding('utf8');
	upstream.setNoDelay(true);
	return new Promise<void>((resolve) => {
		let closed = false;
		let ready = false;
		const deadline = setTimeout(() => close(1011), 20_000);
		deadline.unref();

		function close(code: number): void {
			if (closed) return;
			closed = true;
			clearTimeout(deadline);
			signal.removeEventListener('abort', abort);
			browser.off('close', abort);
			browser.off('message', input);
			client.close();
			if (browser.readyState === browser.OPEN) browser.close(code);
		}

		function abort(): void {
			close(1000);
		}

		function input(data: RawData, binary: boolean): void {
			if (closed) return;
			if (binary) return close(1003);
			const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
			const message = bytes.toString('utf8');
			// The empty opcode is internal to WebSocketTunnel, including its ping.
			if (message.startsWith('0.,')) {
				if (message.startsWith('0.,4.ping,') && browser.bufferedAmount < browserBufferLimit)
					browser.send(message, { binary: false }, (error) => {
						if (error) close(1011);
					});
				return;
			}
			if (!ready) return;
			if (upstream.writableLength >= inputBufferLimit) return close(1013);
			client.send(message);
		}

		browser.once('close', abort);
		browser.on('message', input);
		signal.addEventListener('abort', abort, { once: true });
		client.on('open', () => {
			ready = true;
			clearTimeout(deadline);
		});
		client.once('close', () => {
			close(1000);
			// GuacdClient removes socket close listeners before destroying the socket.
			if (upstream.closed) resolve();
			else upstream.once('close', resolve);
		});
		client.on('error', () => close(1011));
		const receive = client.processReceivedData.bind(client);
		client.processReceivedData = (data) => {
			try {
				receive(data);
			} catch {
				close(1011);
			}
		};
		client.on('data', (message: string) => {
			if (closed || browser.readyState !== browser.OPEN) return;
			if (browser.bufferedAmount + Buffer.byteLength(message) > browserBufferLimit) return close(1013);
			browser.send(message, { binary: false }, (error) => {
				if (error) close(1011);
				else if (!closed && browser.bufferedAmount < 128 * 1024) upstream.resume();
			});
			if (browser.bufferedAmount > 512 * 1024) upstream.pause();
		});
		if (signal.aborted || browser.readyState !== browser.OPEN) abort();
	});
}
