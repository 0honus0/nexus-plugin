declare module 'guacamole-lite/lib/GuacdClient.js' {
	import type { EventEmitter } from 'node:events';
	import type { Socket } from 'node:net';

	export default class GuacdClient extends EventEmitter {
		readonly guacdConnection: Socket;

		constructor(
			endpoint: { host: string; port: number },
			protocol: 'rdp' | 'vnc',
			settings: Record<string, string | number | readonly string[]>,
			logger: { log: () => void },
		);

		send(data: string): void;

		processReceivedData(data: string): void;

		close(): void;
	}
}
