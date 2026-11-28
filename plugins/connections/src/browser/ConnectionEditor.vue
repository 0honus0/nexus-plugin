<script setup lang="ts">
	import type { CredentialInput } from '@nexus-terminal/credentials/credentials-client-api';
	import { useI18n } from 'vue-i18n';
	import { computed, nextTick, ref, useId, watch } from 'vue';
	import type { PluginWindowApi } from 'nexus-terminal/browser';
	import { UiDialog, UiButton, UiInput, UiSelect, UiField } from 'nexus-terminal/browser/ui';
	import { Save, Upload } from '@lucide/vue';
	import {
		ConnectionInputSchema,
		ConnectionTypeSchema,
		connectionDefaults,
		type Connection,
		type ConnectionType,
		type ConnectionEditorRequest,
	} from '../shared/connection-types';
	import { parseQuickAddress } from './connection-presentation.js';
	import { useConnections } from './connections-view.js';
	import TagPicker from './TagPicker.vue';

	const PRIVATE_KEY_LIMIT = 64 * 1024;

	const props = defineProps<{
		connection?: Connection;
		duplicate?: boolean;
		reason?: ConnectionEditorRequest['reason'];
		signal: AbortSignal;
		view: PluginWindowApi;
	}>();
	const emit = defineEmits<{ close: []; saved: [] }>();
	const { t } = useI18n({ useScope: 'parent' });
	const client = useConnections();
	const { catalog, credentials } = client;
	const defaults = props.connection;
	const draft = ref({
		name: defaults ? (props.duplicate ? t('copyName', { name: defaults.name }) : defaults.name) : '',
		type: defaults?.type ?? ('ssh' as ConnectionType),
		host: defaults?.host ?? '',
		username: defaults?.username ?? '',
		credentialId: defaults?.credentialId ?? null,
		domain: defaults?.domain ?? '',
		notes: defaults?.notes ?? '',
		tags: [...(defaults?.tags ?? [])],
	});
	const port = ref(String(defaults?.port ?? 22));
	const saving = ref(false);
	const managing = ref(false);
	let credentialsBeforeManage = new Set<string>();
	const keyFileInput = ref<HTMLInputElement>();
	const active = document.activeElement;
	const opener = active instanceof HTMLElement && active.closest('.connections-app') ? active : undefined;

	const canInlineCreate = computed(
		() => typeof credentials.value?.create === 'function' && draft.value.type !== 'vnc',
	);
	const hasCredentials = computed(() => (credentials.value?.items.value.length ?? 0) > 0);
	const modeTouched = ref(false);
	const credentialMode = ref<'select' | 'create'>(
		!defaults?.credentialId && canInlineCreate.value && credentials.value?.loaded.value && !hasCredentials.value
			? 'create'
			: 'select',
	);

	const inlineCredential = ref({
		name: '',
		username: defaults?.username ?? '',
		type: 'password' as 'password' | 'privateKey',
		password: '',
		privateKey: '',
		passphrase: '',
	});

	watch(
		[() => credentials.value?.loaded.value, hasCredentials, canInlineCreate],
		([loaded, hasAny, inlineAvailable]) => {
			if (!inlineAvailable && credentialMode.value === 'create') {
				credentialMode.value = 'select';
				return;
			}
			if (modeTouched.value || !loaded || !inlineAvailable) return;
			if (!defaults?.credentialId && !draft.value.credentialId && !hasAny) credentialMode.value = 'create';
		},
		{ immediate: true },
	);

	function selectCredentialMode(mode: 'select' | 'create'): void {
		modeTouched.value = true;
		credentialMode.value = mode;
	}

	const autoCredentialName = computed(() => {
		const user = inlineCredential.value.username.trim();
		const host = draft.value.host.trim();
		const name = draft.value.name.trim();
		if (user && host) return `${user}@${host}`;
		if (name) return name;
		return user || host || '';
	});

	const credentialNamePlaceholder = computed(() =>
		autoCredentialName.value
			? t('credentialNameAuto', { fallback: autoCredentialName.value })
			: t('credentialNamePlaceholder'),
	);

	const credentialOptions = computed(() => [
		{ value: 'none', label: t('noCredential') },
		...(credentials.value?.items.value ?? []).map((c) => ({
			value: c.id,
			label: c.name + ' · ' + c.username,
		})),
	]);
	const credentialId = computed({
		get: () => draft.value.credentialId ?? 'none',

		set: (v: string) => {
			draft.value.credentialId = v === 'none' ? null : v;
			if (draft.value.credentialId) draft.value.username = '';
		},
	});
	watch(
		credentials,
		(api) => {
			void api?.refresh(props.signal).catch((cause) => client.report(cause, props.signal));
		},
		{ immediate: true },
	);

	watch(
		() => props.view.state.value.focused,
		async (focused) => {
			if (!focused || !managing.value) return;
			// Restore the original trigger before remounting the dialog, not the
			// control from the credential window that is being closed.
			await nextTick();
			if (!props.view.state.value.focused || !managing.value || props.signal.aborted) return;
			const added = credentials.value?.items.value.find((item) => !credentialsBeforeManage.has(item.id));
			if (added) {
				draft.value.credentialId = added.id;
				draft.value.username = '';
				credentialMode.value = 'select';
				modeTouched.value = true;
			}
			if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true });
			managing.value = false;
		},
	);

	function manageCredentials(): void {
		const api = credentials.value;
		if (!api || props.signal.aborted) return;
		credentialsBeforeManage = new Set(api.items.value.map((item) => item.id));
		managing.value = true;
		try {
			api.openManager();
		} catch (cause) {
			managing.value = false;
			client.report(cause, props.signal);
		}
	}

	function applyQuickAddress(raw: string): boolean {
		const parsed = parseQuickAddress(raw);
		if (!parsed) return false;
		draft.value.host = parsed.host;
		if (parsed.port !== undefined) port.value = String(parsed.port);
		if (parsed.username) {
			const matched = credentials.value?.items.value.find((item) => item.username === parsed.username);
			if (matched && credentialMode.value === 'select' && !draft.value.credentialId) {
				draft.value.credentialId = matched.id;
				draft.value.username = '';
			} else {
				if (!inlineCredential.value.username.trim()) inlineCredential.value.username = parsed.username;
				if (!matched && !draft.value.credentialId && !modeTouched.value && canInlineCreate.value) {
					credentialMode.value = 'create';
				}
			}
		}
		if (!draft.value.name.trim()) draft.value.name = parsed.host;
		return true;
	}

	function onHostPaste(event: ClipboardEvent): void {
		const text = event.clipboardData?.getData('text');
		if (!text) return;
		if (applyQuickAddress(text)) event.preventDefault();
	}

	function onHostBlur(): void {
		applyQuickAddress(draft.value.host);
	}

	async function uploadPrivateKey(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			if (file.size > PRIVATE_KEY_LIMIT) throw new Error('CREDENTIALS_FILE_TOO_LARGE');
			const content = await file.text();
			if (!props.signal.aborted) inlineCredential.value.privateKey = content;
		} catch (cause) {
			client.report(cause, props.signal);
		} finally {
			input.value = '';
		}
	}

	const tagOverlay = ref(false);
	const formId = useId();
	const types = computed(() => ConnectionTypeSchema.options.map((value) => ({ value, label: t('types.' + value) })));
	watch(
		() => draft.value.type,
		(type, previous) => {
			if (Number(port.value) === connectionDefaults[previous].port)
				port.value = String(connectionDefaults[type].port);
			if (!connectionDefaults[type].username) draft.value.username = '';
			if (!connectionDefaults[type].domain) draft.value.domain = '';
		},
	);

	async function save() {
		if (saving.value || props.signal.aborted) return;
		applyQuickAddress(draft.value.host);
		const resolvedName = draft.value.name.trim() || draft.value.host.trim();
		const useInlineCredential = credentialMode.value === 'create' && canInlineCreate.value;
		const baseCheck = ConnectionInputSchema.safeParse({
			...draft.value,
			name: resolvedName,
			port: Number(port.value),
			...(useInlineCredential ? { credentialId: null, username: '' } : {}),
		});
		if (!baseCheck.success) {
			client.report(new Error('CONNECTIONS_INVALID_REQUEST'), props.signal);
			return;
		}

		let credInput: CredentialInput | undefined;
		if (useInlineCredential) {
			const cred = inlineCredential.value;
			const username = cred.username.trim();
			const name = cred.name.trim() || autoCredentialName.value || resolvedName;
			if (!username) {
				client.report(new Error('CREDENTIALS_INVALID_REQUEST'), props.signal);
				return;
			}
			if (cred.type === 'password') {
				if (!cred.password) {
					client.report(new Error('CREDENTIALS_INVALID_REQUEST'), props.signal);
					return;
				}
				credInput = { name, username, type: 'password', password: cred.password };
			} else {
				if (!cred.privateKey) {
					client.report(new Error('CREDENTIALS_INVALID_REQUEST'), props.signal);
					return;
				}
				credInput = {
					name,
					username,
					type: 'privateKey',
					privateKey: cred.privateKey,
					...(cred.passphrase ? { passphrase: cred.passphrase } : {}),
				};
			}
		}

		saving.value = true;
		try {
			let linkedCredentialId = baseCheck.data.credentialId;
			if (credInput && credentials.value?.create) {
				const created = await credentials.value.create(credInput, {
					view: props.view,
					signal: props.signal,
					silent: true,
				});
				if (props.signal.aborted) return;
				linkedCredentialId = created.id;
				draft.value.credentialId = created.id;
				draft.value.username = '';
				credentialMode.value = 'select';
				modeTouched.value = true;
				inlineCredential.value.password = '';
				inlineCredential.value.privateKey = '';
				inlineCredential.value.passphrase = '';
			}
			const finalParsed = ConnectionInputSchema.safeParse({
				...baseCheck.data,
				credentialId: linkedCredentialId,
				username: linkedCredentialId ? '' : baseCheck.data.username,
			});
			if (!finalParsed.success) {
				client.report(new Error('CONNECTIONS_INVALID_REQUEST'), props.signal);
				return;
			}
			await client.save(finalParsed.data, props.duplicate ? undefined : defaults?.id, props.view);
			if (props.signal.aborted) return;
			emit('saved');
		} catch (cause) {
			client.report(cause, props.signal);
		} finally {
			saving.value = false;
		}
	}

	async function tagDeleted(_id: string, name: string) {
		await client.refresh(props.signal).catch((cause) => client.report(cause, props.signal));
		if (!props.signal.aborted) draft.value.tags = draft.value.tags.filter((tag) => tag !== name);
	}
</script>
<template>
	<UiDialog
		:open="!managing"
		class="connections-editor-dialog"
		:description="reason === 'credential-required' ? t('credentialRequiredHint') : undefined"
		:title="t(defaults && !duplicate ? 'edit' : 'add')"
		:close-label="t('close')"
		size="md"
		:close-disabled="saving"
		:close-on-escape="!tagOverlay"
		:close-on-interact-outside="false"
		@update:open="(value) => !value && !managing && emit('close')"
	>
		<form :id="formId" class="connections-form" @submit.prevent="save">
			<div class="connections-form-address">
				<UiField :label="t('host')" v-slot="field"
					><UiInput
						v-model="draft.host"
						:id="field.id"
						:placeholder="t('hostPlaceholder')"
						required
						autofocus
						maxlength="253"
						autocomplete="off"
						spellcheck="false"
						:disabled="saving"
						@paste="onHostPaste"
						@blur="onHostBlur"
				/></UiField>
				<span class="connections-address-separator" aria-hidden="true">:</span>
				<UiField :label="t('port')" v-slot="field"
					><UiInput
						:model-value="String(port)"
						@update:model-value="port = String($event)"
						:id="field.id"
						type="number"
						required
						min="1"
						max="65535"
						step="1"
						:disabled="saving"
				/></UiField>
			</div>
			<div class="connections-form-row">
				<UiField :label="t('name')" v-slot="field"
					><UiInput
						v-model="draft.name"
						:id="field.id"
						:placeholder="t('namePlaceholder')"
						maxlength="120"
						:disabled="saving"
				/></UiField>
				<UiField :label="t('type')" v-slot="field"
					><UiSelect v-model="draft.type" :id="field.id" :options="types" block :disabled="saving"
				/></UiField>
			</div>
			<div class="connections-credential-section">
				<div class="connections-credential-header">
					<span class="connections-credential-label">{{ t('credential') }}</span>
					<div
						v-if="canInlineCreate"
						class="connections-segmented connections-segmented--full"
						role="group"
						:aria-label="t('credential')"
					>
						<button
							type="button"
							class="connections-segmented__item"
							:aria-pressed="credentialMode === 'select'"
							:disabled="saving"
							@click="selectCredentialMode('select')"
						>
							{{ t('selectExistingCredential') }}
						</button>
						<button
							type="button"
							class="connections-segmented__item"
							:aria-pressed="credentialMode === 'create'"
							:disabled="saving"
							@click="selectCredentialMode('create')"
						>
							{{ t('createNewCredential') }}
						</button>
					</div>
				</div>
				<div v-if="credentialMode === 'select' || !canInlineCreate" class="connections-credential">
					<UiSelect
						v-model="credentialId"
						:options="credentialOptions"
						:aria-label="t('credential')"
						block
						:disabled="saving"
					/>
					<UiButton :disabled="saving || !credentials" @click="manageCredentials">{{
						t('manageCredentials')
					}}</UiButton>
				</div>
				<div v-else class="connections-inline-cred">
					<div class="connections-inline-cred__row">
						<UiField :label="t('credentialUsername')" v-slot="field">
							<UiInput
								v-model="inlineCredential.username"
								:id="field.id"
								required
								maxlength="120"
								autocomplete="off"
								:disabled="saving"
							/>
						</UiField>
						<UiField :label="t('credentialType')" v-slot="field">
							<div :id="field.id" class="connections-segmented connections-segmented--full" role="group">
								<button
									type="button"
									class="connections-segmented__item"
									:aria-pressed="inlineCredential.type === 'password'"
									:disabled="saving"
									@click="inlineCredential.type = 'password'"
								>
									{{ t('passwordType') }}
								</button>
								<button
									type="button"
									class="connections-segmented__item"
									:aria-pressed="inlineCredential.type === 'privateKey'"
									:disabled="saving"
									@click="inlineCredential.type = 'privateKey'"
								>
									{{ t('privateKeyType') }}
								</button>
							</div>
						</UiField>
					</div>
					<UiField
						v-if="inlineCredential.type === 'password'"
						:label="t('credentialPassword')"
						v-slot="field"
					>
						<UiInput
							v-model="inlineCredential.password"
							:id="field.id"
							type="password"
							required
							autocomplete="new-password"
							:disabled="saving"
						/>
					</UiField>
					<template v-else>
						<UiField :label="t('credentialPrivateKey')" v-slot="field">
							<textarea
								v-model="inlineCredential.privateKey"
								:id="field.id"
								class="connections-key"
								required
								rows="4"
								spellcheck="false"
								autocomplete="off"
								:disabled="saving"
							/>
						</UiField>
						<input
							ref="keyFileInput"
							type="file"
							hidden
							:aria-label="t('uploadPrivateKey')"
							@change="uploadPrivateKey"
						/>
						<UiButton block appearance="soft" :disabled="saving" @click="keyFileInput?.click()">
							<template #leading><Upload :size="15" /></template>{{ t('uploadPrivateKey') }}
						</UiButton>
						<UiField :label="t('credentialPassphrase')" v-slot="field">
							<UiInput
								v-model="inlineCredential.passphrase"
								:id="field.id"
								type="password"
								autocomplete="new-password"
								:disabled="saving"
							/>
						</UiField>
					</template>
					<UiField :label="t('credentialNameOptional')" v-slot="field">
						<UiInput
							v-model="inlineCredential.name"
							:id="field.id"
							:placeholder="credentialNamePlaceholder"
							maxlength="120"
							:disabled="saving"
						/>
					</UiField>
				</div>
			</div>
			<UiField v-if="connectionDefaults[draft.type].domain" :label="t('domain')" v-slot="field"
				><UiInput v-model="draft.domain" :id="field.id" maxlength="120" :disabled="saving"
			/></UiField>
			<UiField :label="t('tags')" v-slot="field"
				><TagPicker
					v-model="draft.tags"
					:input-id="field.id"
					:input-described-by="field.describedby"
					:tags="catalog.tags"
					:signal="signal"
					:view="view"
					:disabled="saving"
					@deleted="tagDeleted"
					@overlay-change="tagOverlay = $event"
			/></UiField>
			<UiField :label="t('notes')" v-slot="field">
				<textarea
					:disabled="saving"
					v-model="draft.notes"
					:id="field.id"
					class="connections-notes"
					rows="2"
					maxlength="2000"
				/>
			</UiField>
		</form>
		<template #footer
			><UiButton appearance="soft" :disabled="saving" @click="emit('close')">{{ t('cancel') }}</UiButton
			><UiButton
				:form="formId"
				type="submit"
				tone="primary"
				appearance="solid"
				:loading="saving"
				loading-animation="spinner"
				><template #leading><Save :size="15" /></template>{{ t('save') }}</UiButton
			></template
		>
	</UiDialog>
</template>
