<script setup lang="ts">
	import { computed, nextTick, onMounted, onScopeDispose, ref, watch } from 'vue';
	import {
		ChevronDown,
		Clipboard,
		ClipboardType,
		Keyboard,
		Maximize,
		Minimize,
		Monitor,
		Pin,
		Plug2,
		Unplug,
	} from '@lucide/vue';
	import { useI18n } from 'vue-i18n';
	import { z } from 'zod';
	import { PluginHttpError, type PluginWindowProps } from 'nexus-terminal/browser';
	import { UiButton, UiDialog, UiField, UiInput, UiSelect } from 'nexus-terminal/browser/ui';
	import type { ConnectionsClientApi } from '@nexus-terminal/connections/connections-client-api';
	import {
		DesktopSessionResponseSchema,
		type DesktopDisplay,
		type DesktopMode,
		type DesktopSessionInput,
	} from '../shared/desktop-session';
	import type { RemoteDesktopPeer, RemoteDesktopPeerOptions, RemoteDesktopState } from './desktop-peer';
	import FileClipboardDialog from './FileClipboardDialog.vue';
	import { messages } from './messages';

	const props = defineProps<PluginWindowProps & { connections: ConnectionsClientApi; request?: { id: string } }>();
	const emit = defineEmits<{
		requestHandled: [request: { id: string }];
		targetChanged: [id: string | undefined];
	}>();
	const { t, te } = useI18n({ useScope: 'local', messages });
	const viewport = ref<HTMLElement>();
	const app = ref<HTMLElement>();
	const mobileInput = ref<HTMLTextAreaElement>();
	const keyboardOpen = ref(false);
	const hasTouch = navigator.maxTouchPoints > 0;
	const connectionId = ref('');
	const mode = ref<DesktopMode>('native');
	const resolution = ref('adaptive');
	const guacamole = ref(false);
	const modesReady = ref(false);
	const state = ref<RemoteDesktopState>('idle');
	const failure = ref('');
	const toolbarPinned = ref(true);
	const toolbarShown = ref(false);
	const nativeFullscreen = ref(false);
	const textDialog = ref(false);
	const pastedText = ref('');
	const filesDialog = ref(false);
	const fileClipboard = ref<RemoteDesktopPeer['fileClipboard']>();
	type Certificate = Extract<z.infer<typeof DesktopSessionResponseSchema>['result'], { kind: 'certificate' }>;
	const certificate = ref<Certificate>();
	const certificateChanged = computed(
		() =>
			!!certificate.value?.previousFingerprint &&
			certificate.value.previousFingerprint !== certificate.value.fingerprint,
	);
	const certificateFingerprints = computed(() => {
		const current = certificate.value;
		if (!current) return [];
		const fingerprints = [{ label: 'certificateFingerprint', octets: current.fingerprint.split(':') }];
		if (certificateChanged.value && current.previousFingerprint) {
			fingerprints.push({ label: 'previousFingerprint', octets: current.previousFingerprint.split(':') });
		}
		return fingerprints;
	});
	let peer: Pick<RemoteDesktopPeer, 'element' | 'close' | 'resize' | 'focus' | 'sendText'> | undefined;
	let attempt: AbortController | undefined;
	let connectionTimer: ReturnType<typeof setTimeout> | undefined;
	let observer: ResizeObserver | undefined;

	const catalog = computed(() => {
		try {
			return {
				items: props.connections.catalog.value.connections.filter(({ type }) => type !== 'ssh'),
				loaded: props.connections.loaded.value,
			};
		} catch (cause) {
			if (!(cause instanceof Error) || !('code' in cause) || cause.code !== 'PLUGIN_SERVICE_EXPIRED') throw cause;
			return { items: [], loaded: false };
		}
	});
	const connections = computed(() => catalog.value.items);
	const selected = computed(() => connections.value.find(({ id }) => id === connectionId.value));
	const active = computed(() => state.value === 'connecting' || state.value === 'connected');
	const toolbarOverlays = computed(
		() => state.value === 'connected' && (nativeFullscreen.value || !toolbarPinned.value),
	);
	const hideToolbar = computed(
		() => toolbarOverlays.value && !toolbarShown.value && !textDialog.value && !filesDialog.value,
	);
	const connectionOptions = computed(() =>
		connections.value.map(({ id, name, type }) => ({ value: id, label: name + ' · ' + type.toUpperCase() })),
	);
	const modes = computed(() => [
		{ value: 'native', label: t('native') },
		...(guacamole.value ? [{ value: 'guacamole', label: t('guacamole') }] : []),
	]);
	const resolutions = computed(() => [
		{ value: 'adaptive', label: t('adaptive') },
		{ value: '1280x720', label: '1280 × 720' },
		{ value: '1920x1080', label: '1920 × 1080' },
	]);
	const sessionDetails = computed(() =>
		[
			selected.value?.type.toUpperCase(),
			modes.value.find(({ value }) => value === mode.value)?.label,
			resolutions.value.find(({ value }) => value === resolution.value)?.label,
		]
			.filter(Boolean)
			.join(' · '),
	);

	function display(): DesktopDisplay {
		const { clientWidth = 1280, clientHeight = 720 } = viewport.value ?? {};
		const [width, height] =
			resolution.value === 'adaptive' ? [clientWidth, clientHeight] : resolution.value.split('x').map(Number);
		return { width: Math.max(320, Math.min(3840, width)), height: Math.max(240, Math.min(2160, height)), dpi: 96 };
	}

	function stop(next: RemoteDesktopState = 'disconnected'): void {
		clearTimeout(connectionTimer);
		attempt?.abort();
		attempt = undefined;
		mobileInput.value?.blur();
		if (mobileInput.value) mobileInput.value.value = '';
		peer?.close();
		peer?.element.remove();
		peer = undefined;
		fileClipboard.value = undefined;
		filesDialog.value = false;
		textDialog.value = false;
		pastedText.value = '';
		toolbarShown.value = false;
		certificate.value = undefined;
		state.value = next;
		emit('targetChanged', undefined);
		if (document.fullscreenElement === app.value) void document.exitFullscreen().catch(() => undefined);
	}

	function showFailure(code: string): void {
		stop('error');
		failure.value = code;
	}

	async function start(trust?: DesktopSessionInput['trust']): Promise<void> {
		if (!selected.value || props.view.signal.aborted) return;
		stop('connecting');
		failure.value = '';
		const controller = new AbortController();
		attempt = controller;
		connectionTimer = setTimeout(() => {
			if (attempt === controller && state.value === 'connecting') showFailure('DESKTOP_CONNECT_TIMEOUT');
		}, 25_000);
		const signal = AbortSignal.any([props.view.signal, controller.signal]);
		const requested = display();
		const chosen = selected.value;
		emit('targetChanged', chosen.id);
		try {
			const { result } = await props.context.app.http.json('/sessions', DesktopSessionResponseSchema, {
				method: 'POST',
				cache: 'no-store',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ connectionId: chosen.id, mode: mode.value, display: requested, trust }),
				signal,
			});
			if (signal.aborted) return;
			if (result.kind === 'certificate') {
				clearTimeout(connectionTimer);
				state.value = 'idle';
				certificate.value = result;
				return;
			}
			const url = props.context.app.ws.url('/desktop');
			const query = new URLSearchParams({ ticket: result.ticket }).toString();
			const options: RemoteDesktopPeerOptions = {
				hasTouch,
				fillViewport: chosen.type === 'rdp' && resolution.value === 'adaptive',
				touchMode: 'direct',
				mobileInput: mobileInput.value ?? null,

				onState(next) {
					if (signal.aborted) return;
					if (next !== 'connecting') clearTimeout(connectionTimer);
					if (next === 'disconnected') {
						if (state.value === 'connecting') showFailure('DESKTOP_FAILED');
						else stop();
						return;
					}
					state.value = next;
					if (next === 'connected') peer?.focus();
				},

				onFailure(error) {
					if (!signal.aborted && error.code !== 'input_failed') showFailure('DESKTOP_FAILED');
				},

				onDiagnostic(code) {
					props.context.app.log.report({ code, level: 'warn' });
				},
			};
			if (result.kind === 'guacamole') {
				const { openGuacamoleDesktop } = await import('./adapters/guacamole');
				if (signal.aborted) return;
				if (chosen.type === 'ssh') return showFailure('DESKTOP_PROTOCOL_UNSUPPORTED');
				peer = openGuacamoleDesktop(options, url, query, chosen.type, requested);
				viewport.value?.append(peer.element);
			} else {
				const factory =
					result.protocol === 'rdp'
						? (await import('./adapters/rdp-desktop')).createRdpDesktop
						: (await import('./adapters/vnc-desktop')).createVncDesktop;
				if (signal.aborted) return;
				const native = factory(options);
				peer = native;
				fileClipboard.value = native.fileClipboard;
				viewport.value?.append(native.element);
				native.connect({ ...result, socketUrl: url + '?' + query }, requested);
			}
		} catch (cause) {
			if (signal.aborted) return;
			showFailure(cause instanceof PluginHttpError ? cause.code : 'DESKTOP_FAILED');
		}
	}

	function trustCertificate(permanent: boolean): void {
		if (!certificate.value) return;
		const { host, port, fingerprint, previousFingerprint } = certificate.value;
		void start({ host, port, fingerprint, previousFingerprint, permanent });
	}

	function openManager(): void {
		props.connections.openManager();
	}

	function toggleKeyboard(): void {
		if (keyboardOpen.value) mobileInput.value?.blur();
		else mobileInput.value?.focus({ preventScroll: true });
	}

	async function fullscreen(): Promise<void> {
		const element = app.value;
		if (!element) return;
		try {
			if (document.fullscreenElement === element) await document.exitFullscreen();
			else await element.requestFullscreen();
		} catch {
			if (!props.view.signal.aborted) report('DESKTOP_FULLSCREEN_UNAVAILABLE');
		}
	}

	function fullscreenChanged(): void {
		const fullscreen = !!app.value && document.fullscreenElement === app.value;
		if (nativeFullscreen.value === fullscreen) return;
		nativeFullscreen.value = fullscreen;
		if (fullscreen) toolbarShown.value = false;
	}

	function report(code: string): void {
		props.context.app.log.report({
			code,
			level: code === 'DESKTOP_FILE_UPLOADED' ? 'info' : 'warn',
			userVisible: true,
		});
	}

	function focusRemote(event: Event): void {
		event.preventDefault();
		peer?.focus();
	}

	function pinToolbar(): void {
		toolbarPinned.value = !toolbarPinned.value;
		toolbarShown.value = toolbarPinned.value;
		peer?.focus();
	}

	function sendPastedText(): void {
		if (!peer || !pastedText.value) return;
		try {
			peer.sendText(pastedText.value);
		} catch {
			report('DESKTOP_PASTE_FAILED');
		} finally {
			pastedText.value = '';
			textDialog.value = false;
		}
	}

	watch(textDialog, (open) => {
		if (!open) pastedText.value = '';
	});

	watch(
		[() => props.request, catalog, modesReady, viewport],
		([request, catalog, ready, surface]) => {
			if (!request || !ready || !surface || props.view.signal.aborted) return;
			if (!catalog.items.some(({ id }) => id === request.id)) {
				if (!catalog.loaded) return;
				emit('requestHandled', request);
				showFailure('DESKTOP_CONNECTION_NOT_FOUND');
				return;
			}
			emit('requestHandled', request);
			if (request.id === connectionId.value && (active.value || certificate.value)) return;
			connectionId.value = request.id;
			void start();
		},
		{ immediate: true, flush: 'post' },
	);

	watch(
		connections,
		(items) => {
			if (!connectionId.value) connectionId.value = items[0]?.id ?? '';
			else if (!items.some(({ id }) => id === connectionId.value) && catalog.value.loaded) {
				if (active.value) stop();
				connectionId.value = items[0]?.id ?? '';
			}
		},
		{ immediate: true },
	);

	onMounted(async () => {
		document.addEventListener('fullscreenchange', fullscreenChanged);
		void props.connections.refresh(props.view.signal).catch(() => undefined);
		void props.context.app.http
			.json('/modes', z.strictObject({ guacamole: z.boolean() }), { signal: props.view.signal })
			.then((result) => {
				if (!props.view.signal.aborted) {
					guacamole.value = result.guacamole;
					if (result.guacamole && !attempt) mode.value = 'guacamole';
				}
			})
			.catch(() => undefined)
			.finally(() => {
				if (!props.view.signal.aborted) modesReady.value = true;
			});
		await nextTick();
		if (!props.view.signal.aborted && viewport.value) {
			observer = new ResizeObserver(([entry]) => {
				if (entry.contentRect.width && entry.contentRect.height) peer?.resize(display());
			});
			observer.observe(viewport.value);
		}
	});

	onScopeDispose(() => {
		document.removeEventListener('fullscreenchange', fullscreenChanged);
		observer?.disconnect();
		stop();
	});
</script>
<template>
	<section ref="app" class="remote-desktop-app" :data-toolbar-overlay="toolbarOverlays || undefined">
		<div
			v-if="state === 'connected'"
			class="remote-desktop-controls"
			:data-expanded="(toolbarOverlays && !hideToolbar) || undefined"
			@pointerleave="
				(event) => {
					if (event.pointerType === 'mouse') toolbarShown = false;
				}
			"
		>
			<button
				v-if="toolbarOverlays"
				type="button"
				class="remote-desktop-toolbar-handle"
				:aria-label="t('showToolbar')"
				:aria-expanded="!hideToolbar"
				@pointerenter="
					(event) => {
						if (event.pointerType === 'mouse') toolbarShown = true;
					}
				"
				@click="toolbarShown = !toolbarShown"
			>
				<ChevronDown :size="12" aria-hidden="true" />
			</button>
			<div class="remote-desktop-toolbar" :data-hidden="hideToolbar || undefined" :inert="hideToolbar">
				<div class="remote-desktop-session" :title="selected?.name">
					<Monitor :size="17" aria-hidden="true" />
					<div class="remote-desktop-session__label">
						<strong>{{ selected?.name }}</strong>
						<span :title="sessionDetails">{{ sessionDetails }}</span>
					</div>
				</div>
				<div class="remote-desktop-actions">
					<UiButton
						v-if="hasTouch"
						icon-only
						appearance="ghost"
						:aria-label="t('keyboard')"
						:aria-pressed="keyboardOpen"
						@pointerdown.prevent
						@click="toggleKeyboard"
						><Keyboard :size="17"
					/></UiButton>
					<UiButton
						v-if="fileClipboard"
						icon-only
						appearance="ghost"
						:aria-label="t('files.title')"
						:title="t('files.title')"
						@click="filesDialog = true"
					>
						<Clipboard :size="17" />
					</UiButton>
					<UiButton
						icon-only
						appearance="ghost"
						:aria-label="t('pasteText')"
						:title="t('pasteText')"
						@click="textDialog = true"
					>
						<ClipboardType :size="17" />
					</UiButton>
					<UiButton
						v-if="!nativeFullscreen"
						icon-only
						:appearance="toolbarPinned ? 'soft' : 'ghost'"
						:tone="toolbarPinned ? 'primary' : 'neutral'"
						:aria-label="t('pinToolbar')"
						:title="t(toolbarPinned ? 'unpinToolbar' : 'pinToolbar')"
						:aria-pressed="toolbarPinned"
						@click="pinToolbar"
					>
						<Pin :size="17" />
					</UiButton>
					<UiButton
						icon-only
						appearance="ghost"
						:aria-label="t(nativeFullscreen ? 'exitFullscreen' : 'fullscreen')"
						:title="t(nativeFullscreen ? 'exitFullscreen' : 'fullscreen')"
						@click="fullscreen"
					>
						<component :is="nativeFullscreen ? Minimize : Maximize" :size="17" />
					</UiButton>
					<UiButton
						class="remote-desktop-disconnect"
						icon-only
						appearance="ghost"
						tone="danger"
						:aria-label="t('disconnect')"
						:title="t('disconnect')"
						@click="stop()"
					>
						<Unplug :size="17" />
					</UiButton>
				</div>
			</div>
		</div>
		<div
			ref="viewport"
			class="remote-desktop-viewport"
			:data-setup="state !== 'connected' || undefined"
			@pointerdown="toolbarShown = false"
		>
			<textarea
				v-if="hasTouch"
				ref="mobileInput"
				class="remote-desktop-mobile-input"
				:aria-label="t('keyboardInput')"
				autocomplete="off"
				autocapitalize="off"
				enterkeyhint="enter"
				:spellcheck="false"
				tabindex="-1"
				@focus="keyboardOpen = true"
				@blur="keyboardOpen = false"
			/>
			<div v-if="state !== 'connected'" class="remote-desktop-setup-frame">
				<form class="remote-desktop-setup" @submit.prevent="start()">
					<header class="remote-desktop-setup__heading">
						<Monitor :size="19" aria-hidden="true" />
						<h2>{{ t(connections.length ? 'setup' : 'empty') }}</h2>
					</header>
					<template v-if="connections.length">
						<UiField :label="t('connection')" v-slot="{ id }">
							<UiSelect
								:id="id"
								v-model="connectionId"
								:options="connectionOptions"
								:placeholder="t('choose')"
								:disabled="active"
							/>
						</UiField>
						<div class="remote-desktop-setup__options">
							<UiField :label="t('mode')" v-slot="{ id }">
								<UiSelect :id="id" v-model="mode" :options="modes" :disabled="active" />
							</UiField>
							<UiField :label="t('resolution')" v-slot="{ id }">
								<UiSelect :id="id" v-model="resolution" :options="resolutions" :disabled="active" />
							</UiField>
						</div>
					</template>
					<p v-if="failure" class="remote-desktop-setup__error" role="alert">
						{{ t(te('errors.' + failure) ? 'errors.' + failure : 'errors.DESKTOP_FAILED') }}
					</p>
					<div class="remote-desktop-setup__footer">
						<span v-if="state === 'connecting'" role="status">{{ t('connecting') }}</span>
						<span v-else-if="state === 'disconnected'" role="status">{{ t('disconnected') }}</span>
						<UiButton v-if="state === 'connecting'" @click="stop()">{{ t('cancel') }}</UiButton>
						<UiButton
							v-else-if="connections.length"
							type="submit"
							tone="primary"
							appearance="solid"
							:disabled="!selected"
						>
							<template #leading><Plug2 :size="16" /></template>{{ t('connect') }}
						</UiButton>
						<UiButton v-else tone="primary" @click="openManager">{{ t('manage') }}</UiButton>
					</div>
				</form>
			</div>
		</div>
		<UiDialog
			v-model:open="textDialog"
			:title="t('pasteText')"
			:description="t('pasteHint')"
			:close-label="t('cancel')"
			@close-auto-focus="focusRemote"
		>
			<form @submit.prevent="sendPastedText">
				<UiInput
					v-model="pastedText"
					type="password"
					:aria-label="t('pasteText')"
					autocomplete="off"
					spellcheck="false"
				/>
			</form>
			<template #footer>
				<UiButton @click="textDialog = false">{{ t('cancel') }}</UiButton>
				<UiButton tone="primary" :disabled="!pastedText" @click="sendPastedText">{{ t('sendText') }}</UiButton>
			</template>
		</UiDialog>
		<FileClipboardDialog
			v-model:open="filesDialog"
			:clipboard="fileClipboard"
			:t="t"
			@report="report"
			@close-auto-focus="focusRemote"
		/>
		<UiDialog
			:open="!!certificate"
			:title="t('certificate')"
			:description="t(certificateChanged ? 'certificateChanged' : 'certificateVerify')"
			:resizable="false"
			:close-label="t('cancel')"
			@update:open="!$event && stop('idle')"
		>
			<div v-if="certificate" class="remote-desktop-certificate">
				<div class="remote-desktop-certificate__server">
					<Monitor :size="18" aria-hidden="true" />
					<strong>{{ certificate.host }}:{{ certificate.port }}</strong>
				</div>
				<dl v-if="certificate.subject || certificate.issuer" class="remote-desktop-certificate__identity">
					<template v-if="certificate.subject">
						<dt>
							{{
								t(
									certificate.subject === certificate.issuer
										? 'certificateSubjectAndIssuer'
										: 'certificateSubject',
								)
							}}
						</dt>
						<dd>{{ certificate.subject }}</dd>
					</template>
					<template v-if="certificate.issuer && certificate.subject !== certificate.issuer">
						<dt>{{ t('certificateIssuer') }}</dt>
						<dd>{{ certificate.issuer }}</dd>
					</template>
				</dl>
				<div
					v-for="{ label, octets } in certificateFingerprints"
					:key="label"
					class="remote-desktop-certificate__fingerprint"
				>
					<span>{{ t(label) }}</span>
					<code
						><span v-for="(octet, index) in octets" :key="index">{{
							octet + (index < octets.length - 1 ? ':' : '')
						}}</span></code
					>
				</div>
			</div>
			<template #footer>
				<div class="remote-desktop-certificate__actions">
					<UiButton appearance="ghost" @click="stop('idle')">{{ t('cancel') }}</UiButton>
					<UiButton @click="trustCertificate(false)">{{ t('accept') }}</UiButton>
					<UiButton tone="primary" appearance="solid" @click="trustCertificate(true)">{{
						t('acceptPermanently')
					}}</UiButton>
				</div>
			</template>
		</UiDialog>
	</section>
</template>
