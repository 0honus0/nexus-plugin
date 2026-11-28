import type { PluginModuleApi } from 'nexus-terminal/node';
import type {} from '@nexus-terminal/connections/connections-api';
import type {} from '@nexus-terminal/credentials/credentials-api';
import { z } from 'zod';
import {
	DesktopSessionInputSchema,
	DesktopSessionResponseSchema,
	type DesktopSessionInput,
	remoteDesktopFrameMaxBytes,
} from '../shared/desktop-session.js';
import { guacamoleEndpoint } from './adapters/guacamole.js';
import { DesktopService } from './desktop-service.js';
import { DesktopStorage } from './desktop-storage.js';

export { migrations } from './desktop-storage.js';

export const activate: PluginModuleApi['activate'] = (context) => {
	const { http, ws } = context.app;
	const storage = new DesktopStorage(context.app.database);
	const gateway = guacamoleEndpoint({
		NEXUS_GUACD_HOST: process.env.NEXUS_GUACD_HOST,
		NEXUS_GUACD_PORT: process.env.NEXUS_GUACD_PORT,
	});
	context.use(
		{
			connections: ['@nexus-terminal/connections', 'connections'],
			credentials: ['@nexus-terminal/credentials', 'credentials'],
		},
		(scope) => {
			const service = new DesktopService(scope.plugin.connections, scope.plugin.credentials, gateway, storage);
			scope.onDispose(() => service.dispose());
			http.register([
				{
					method: 'get',
					path: '/modes',
					lifetime: scope,
					input: z.strictObject({}),
					output: z.strictObject({ guacamole: z.boolean() }),

					handler: () => ({ guacamole: gateway !== null }),
				},
				{
					method: 'post',
					path: '/sessions',
					lifetime: scope,
					input: DesktopSessionInputSchema,
					output: DesktopSessionResponseSchema,

					handler: (input: DesktopSessionInput, signal) => service.issue(input, signal),
				},
			] as const);
			ws.register({
				path: '/desktop',
				lifetime: scope,
				maxPayload: remoteDesktopFrameMaxBytes,

				handler: (socket, { query, signal }) => service.attach(socket, query.get('ticket'), signal),
			});
			context.self.readiness.set({ state: 'ready' });
		},
	);
};
