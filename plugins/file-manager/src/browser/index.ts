import type { FileManagerFile, FileManagerOpenFile } from '@nexus-terminal/workspace/file-manager-api';
import { FolderOpen } from '@lucide/vue';
import { defineComponent, h, onScopeDispose, shallowRef, type Component } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PluginModuleApi, PluginWindowApi, PluginWindowProps } from 'nexus-terminal/browser';
import FilePreviewWindow from './FilePreviewWindow.vue';
import FileList from '#file-list';
import { language, messages } from './messages.js';
import { previewFormat } from './preview-formats.js';
import { createDocument, type PreviewDocument } from './preview-document.js';

export const activate: PluginModuleApi['activate'] = (context) => {
	const stylesheet = document.createElement('link');
	stylesheet.rel = 'stylesheet';
	stylesheet.href = new URL(/* @vite-ignore */ 'index.css', import.meta.url).href;
	document.head.append(stylesheet);
	context.onDispose(() => stylesheet.remove());

	const pending: PreviewDocument[][] = [];
	const previews = new Map<PluginWindowApi, (document: PreviewDocument) => void>();

	const openFile: FileManagerOpenFile = (file) => {
		const format = previewFormat(file.name);
		if (!format) return false;
		const document = createDocument(file, format);
		if (file.mode === 'reuse') {
			const targets = [...previews].filter(([view]) => !view.signal.aborted);
			const target = targets.find(([view]) => view.state.value.focused) ?? targets.at(-1);
			if (target) {
				const [view, add] = target;
				add(document);
				view.focus();
				return true;
			}
			const opening = pending.at(-1);
			if (opening) {
				if (!opening.some((tab) => tab.id === document.id)) opening.push(document);
				return true;
			}
		}
		const batch = [document];
		pending.push(batch);
		try {
			context.app.windows.open('main');
		} catch (cause) {
			const index = pending.indexOf(batch);
			if (index !== -1) pending.splice(index, 1);
			throw cause;
		}
		return true;
	};

	const fileManagerView = shallowRef<Component>();
	context.use({ workspace: ['@nexus-terminal/workspace', 'fileManager'] }, ({ plugin, onDispose }) => {
		const presentation = { list: FileList, open: openFile };
		const unregister = plugin.workspace.registerFilePresentation(presentation);
		onDispose(unregister);
		const component = plugin.workspace.createView(presentation);
		fileManagerView.value = component;
		onDispose(() => {
			if (fileManagerView.value === component) fileManagerView.value = undefined;
		});
	});

	const component = defineComponent({
		props: ['context', 'view'],

		setup(props: PluginWindowProps) {
			const { view } = props;
			const documents = pending.shift();
			if (!documents) {
				const { locale } = useI18n({ useScope: 'global' });
				return () =>
					fileManagerView.value
						? h(fileManagerView.value, props)
						: h('p', { role: 'status' }, messages[language(locale.value)].loading);
			}

			const tabs = shallowRef(documents);
			const active = shallowRef(tabs.value.at(-1)?.id);
			previews.set(view, (document) => {
				if (!tabs.value.some((tab) => tab.id === document.id)) tabs.value = [...tabs.value, document];
				active.value = document.id;
			});
			onScopeDispose(() => {
				previews.delete(view);
			});

			function close(id: string) {
				const index = tabs.value.findIndex((tab) => tab.id === id);
				tabs.value = tabs.value.filter((tab) => tab.id !== id);
				if (active.value === id) active.value = tabs.value[Math.min(index, tabs.value.length - 1)]?.id;
			}

			return () =>
				h(FilePreviewWindow, {
					tabs: tabs.value,
					view,
					active: active.value,

					'onUpdate:active': (id) => {
						active.value = id;
					},

					onClose: close,
				});
		},
	});

	context.contribute({
		applications: [
			{
				id: 'main',

				label: (locale) => messages[language(locale)].title,

				icon: FolderOpen,
				component,
				multipleWindows: true,
				scrollMode: 'content',
				defaultWindowSize: { width: 920, height: 600 },
			},
		],
	});
	context.self.readiness.set({ state: 'ready' });
};
