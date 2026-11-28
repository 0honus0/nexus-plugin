import { computed, defineAsyncComponent, defineComponent, h, onScopeDispose, provide, shallowRef } from 'vue';
import { SquareTerminal } from '@lucide/vue';
import { useI18n } from 'vue-i18n';
import type { PluginModuleApi, PluginWindowProps } from 'nexus-terminal/browser';
import { createWorkspaceI18n, registerWorkspaceNotices, workspaceTitle } from './workspace-i18n.js';
import type { FileManagerPresentation, WorkspaceFileManagerApi } from './file-manager-api.js';
import { fileListKey } from './file-list-key.js';
import WorkspaceTile from './WorkspaceTile.vue';
import WorkspaceLoading from './WorkspaceLoading.vue';
import 'dockview-vue/dist/styles/dockview.css';
import './workspace.css';

export const activate: PluginModuleApi['activate'] = (context) => {
	registerWorkspaceNotices(context);
	const css = document.createElement('link');
	css.rel = 'stylesheet';
	css.href = new URL(/* @vite-ignore */ 'index.css', import.meta.url).href;
	document.head.append(css);
	context.onDispose(() => css.remove());

	let appModule: Promise<typeof import('./WorkspaceApp.vue')> | undefined;
	const filePresentation = shallowRef<FileManagerPresentation>();

	function preload() {
		context.signal.throwIfAborted();
		return (appModule ??= import('./WorkspaceApp.vue').catch((cause: unknown) => {
			appModule = undefined;
			throw cause;
		}));
	}

	context.provide('fileManager', {
		createView: (presentation) => createApplication(true, presentation),

		registerFilePresentation(presentation) {
			filePresentation.value = presentation;
			return () => {
				if (filePresentation.value === presentation) filePresentation.value = undefined;
			};
		},
	} satisfies WorkspaceFileManagerApi);

	function createApplication(filesOnly: boolean, presentation?: FileManagerPresentation) {
		return defineAsyncComponent({
			async loader() {
				const { default: App } = await preload();
				context.signal.throwIfAborted();
				return defineComponent({
					props: ['context', 'view'],

					setup(props: PluginWindowProps) {
						const { locale } = useI18n({ useScope: 'global' });
						const i18n = createWorkspaceI18n(locale);
						onScopeDispose(i18n.dispose);
						const files = computed(() => presentation ?? filePresentation.value);
						provide(
							fileListKey,
							computed(() => files.value?.list),
						);
						return () => h(App, { ...props, ctx: context, i18n, filesOnly, openFile: files.value?.open });
					},
				});
			},

			loadingComponent: WorkspaceLoading,
			delay: 0,
		});
	}

	const application = {
		id: 'main',
		label: workspaceTitle,
		component: createApplication(false),
		scrollMode: 'content',
		tile: { component: WorkspaceTile, showAtIconSize: true },
	} as const;
	const defaultWindowSize = { width: 1080, height: 700 } as const;
	context.contribute({ applications: [{ ...application, icon: SquareTerminal, preload, defaultWindowSize }] });
	context.self.readiness.set({ state: 'ready' });
};
