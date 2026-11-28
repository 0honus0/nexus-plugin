import { defineAsyncComponent, defineComponent, h, onScopeDispose, shallowRef, type ShallowRef } from 'vue';
import { Monitor } from '@lucide/vue';
import type { PluginModuleApi, PluginWindowApi, PluginWindowProps } from 'nexus-terminal/browser';
import type { ConnectionsClientApi } from '@nexus-terminal/connections/connections-client-api';
import { messages } from './messages';
import './desktop.css';

export const activate: PluginModuleApi['activate'] = (context) => {
	context.onDispose(context.app.log.registerMessages({ en: messages.en.notices, zh: messages.zh.notices }));
	const style = document.createElement('link');
	style.rel = 'stylesheet';
	style.href = new URL(/* @vite-ignore */ 'index.css', import.meta.url).href;
	document.head.append(style);
	context.onDispose(() => style.remove());

	type OpenRequest = { id: string };
	const pending: OpenRequest[] = [];
	const desktops = new Map<PluginWindowApi, { request: ShallowRef<OpenRequest | undefined>; target?: string }>();
	const connections = shallowRef<ConnectionsClientApi>();
	const App = defineAsyncComponent(() => import('./DesktopApp.vue'));
	const component = defineComponent({
		props: ['context', 'view'],

		setup(props: PluginWindowProps) {
			const request = shallowRef<OpenRequest | undefined>(pending.shift());
			const desktop = { request, target: undefined as string | undefined };
			desktops.set(props.view, desktop);
			onScopeDispose(() => desktops.delete(props.view));
			return () =>
				connections.value
					? h(App, {
							...props,
							connections: connections.value,
							request: request.value,

							onRequestHandled(handled) {
								if (request.value === handled) request.value = undefined;
							},

							onTargetChanged(target) {
								desktop.target = target;
							},
						})
					: null;
		},
	});
	context.contribute({
		applications: [
			{
				id: 'main',

				label: (locale?: string) => (locale === 'zh' ? messages.zh.title : messages.en.title),

				icon: Monitor,
				component,
				multipleWindows: true,
				defaultWindowSize: { width: 1080, height: 720 },
				scrollMode: 'content',
			},
		],
	});
	context.use({ connections: ['@nexus-terminal/connections', 'connections'] }, ({ plugin, onDispose }) => {
		connections.value = plugin.connections;
		const unregister = plugin.connections.registerDesktopOpener((id) => {
			const windows = [...desktops].filter(([view]) => !view.signal.aborted);
			const existing = windows.find(([, desktop]) => desktop.target === id || desktop.request.value?.id === id);
			if (existing) {
				existing[0].focus();
				return;
			}
			if (pending.some((request) => request.id === id)) return;
			const next = { id };
			const idle = windows.find(([, desktop]) => !desktop.target && !desktop.request.value);
			if (idle) {
				idle[1].request.value = next;
				idle[0].focus();
				return;
			}
			pending.push(next);
			try {
				context.app.windows.open('main');
			} catch (cause) {
				const index = pending.indexOf(next);
				if (index !== -1) pending.splice(index, 1);
				throw cause;
			}
		});
		onDispose(() => {
			connections.value = undefined;
			pending.length = 0;
			unregister();
		});
		context.self.readiness.set({ state: 'ready' });
	});
};
