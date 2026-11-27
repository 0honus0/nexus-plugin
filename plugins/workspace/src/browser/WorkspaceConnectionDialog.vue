<script setup lang="ts">
	import type { Connection, ConnectionsClientApi } from '@nexus-terminal/connections/connections-client-api';
	import type { CredentialInput, CredentialsClientApi } from '@nexus-terminal/credentials/credentials-client-api';
	import { Upload } from '@lucide/vue';
	import { computed, nextTick, ref, useId, watch } from 'vue';
	import type { PluginWindowApi } from 'nexus-terminal/browser';
	import { UiButton, UiDialog, UiField, UiInput, UiSelect } from 'nexus-terminal/browser/ui';
	import { WorkspaceModuleError } from './workspace-error.js';
	import type { WorkspaceI18n } from './workspace-i18n';

	const PRIVATE_KEY_LIMIT = 64 * 1024;

	const props = defineProps<{
		open: boolean;
		connections?: ConnectionsClientApi;
		credentials?: CredentialsClientApi;
		view: PluginWindowApi;
		i18n: WorkspaceI18n;
		report: (cause: unknown) => void;
	}>();

	const emit = defineEmits<{
		'update:open': [value: boolean];
		created: [connection: Connection, connectNow: boolean];
	}>();

	const { t } = props.i18n;
	const formId = useId();
	const hostId = useId();
	const commandErrorId = useId();
	const authModeName = useId();
	const formEl = ref<HTMLFormElement>();
	const keyFileInput = ref<HTMLInputElement>();

	const host = ref('');
	const port = ref('22');
	const name = ref('');
	const addressUsername = ref('');
	const credentialChoice = ref('none');
	const savedCredentialChoice = ref('none');
	const credentialChosen = ref(false);
	const saving = ref(false);
	const saveAction = ref<'save' | 'connect'>('connect');
	const importOpen = ref(false);
	const command = ref('');
	const commandInvalid = ref(false);
	const inlineCredential = ref({
		name: '',
		username: '',
		password: '',
		privateKey: '',
		passphrase: '',
	});

	const canInlineCreate = computed(() => typeof props.credentials?.create === 'function');
	const credentialItems = computed(() => props.credentials?.items.value ?? []);
	const inlineType = computed(() => {
		const choice = credentialChoice.value;
		return canInlineCreate.value && (choice === 'password' || choice === 'privateKey') ? choice : undefined;
	});
	const existingCredential = computed(() => credentialItems.value.find(({ id }) => id === credentialChoice.value));
	const hasCredential = computed(() => !!(inlineType.value || existingCredential.value));
	const authMode = computed(() => inlineType.value ?? 'saved');
	const authModes = computed(
		() =>
			[
				{ value: 'saved', label: t('quickConnect.savedCredential') },
				{ value: 'password', label: t('quickConnect.password') },
				{ value: 'privateKey', label: t('quickConnect.privateKey') },
			] as const,
	);
	const credentialOptions = computed(() => [
		...credentialItems.value.map((item) => ({ value: item.id, label: `${item.name} · ${item.username}` })),
		{ value: 'none', label: t('quickConnect.noCredential') },
	]);

	const autoCredentialName = computed(() => {
		const user = inlineCredential.value.username.trim();
		const destination = host.value.trim();
		return user && destination ? `${user}@${destination}` : name.value.trim() || user || destination;
	});

	function chooseDefaultCredential(): void {
		if (credentialChosen.value) return;
		const username = addressUsername.value;
		const items = credentialItems.value;
		const matches = username ? items.filter((item) => item.username === username) : items;
		if (matches.length === 1) credentialChoice.value = matches[0]!.id;
		else if (!matches.length && canInlineCreate.value && props.credentials?.loaded.value)
			credentialChoice.value = inlineType.value ?? 'password';
		else credentialChoice.value = 'none';
	}

	function resetForm(): void {
		host.value = '';
		port.value = '22';
		name.value = '';
		addressUsername.value = '';
		importOpen.value = false;
		command.value = '';
		commandInvalid.value = false;
		credentialChoice.value = 'none';
		savedCredentialChoice.value = 'none';
		credentialChosen.value = false;
		inlineCredential.value = { name: '', username: '', password: '', privateKey: '', passphrase: '' };
		chooseDefaultCredential();
	}

	watch(
		() => props.open,
		(visible) => {
			if (!visible) return;
			resetForm();
			if (props.credentials && !props.credentials.loaded.value) {
				void props.credentials.refresh(props.view.signal).catch((cause) => {
					if (!props.view.signal.aborted) props.report(cause);
				});
			}
		},
		{ immediate: true },
	);

	watch([credentialItems, () => props.credentials?.loaded.value], () => {
		if (props.open && !saving.value) chooseDefaultCredential();
	});

	function chooseCredential(value: string | undefined): void {
		credentialChosen.value = true;
		credentialChoice.value = value ?? 'none';
		if (!inlineType.value) savedCredentialChoice.value = credentialChoice.value;
	}

	function chooseAuthMode(value: 'saved' | 'password' | 'privateKey'): void {
		if (value !== 'saved' && !inlineType.value) savedCredentialChoice.value = credentialChoice.value;
		chooseCredential(value === 'saved' ? savedCredentialChoice.value : value);
	}

	function parseQuickAddress(raw: string): { host: string; port?: number; username?: string } | undefined {
		const text = raw.trim();
		if (!text) return;

		let target = text;
		let username: string | undefined;
		let parsedPort: number | undefined;
		let parsed = false;

		if (/^ssh\s+/iu.test(target)) {
			parsed = true;
			const tokens = target.split(/\s+/u).slice(1);
			let destination: string | undefined;
			for (let i = 0; i < tokens.length; i++) {
				const token = tokens[i]!;
				if (token === '-p' && tokens[i + 1]) {
					const candidate = Number(tokens[++i]);
					if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) return;
					parsedPort = candidate;
				} else if (/^-p\d+$/u.test(token)) {
					const candidate = Number(token.slice(2));
					if (candidate < 1 || candidate > 65535) return;
					parsedPort = candidate;
				} else if (token === '-l' && tokens[i + 1]) {
					username = tokens[++i];
				} else if (token.startsWith('-')) {
					if (/^-[iFJoOWbcDEeILmQRSUw]$/u.test(token) && tokens[i + 1]) i++;
				} else if (!destination) {
					destination = token;
				}
			}
			if (!destination) return;
			target = destination;
		} else if (/^ssh:\/\//iu.test(target)) {
			parsed = true;
			target = target.slice(6).replace(/\/.*$/u, '');
		}

		const atIndex = target.lastIndexOf('@');
		if (atIndex > 0) {
			const userPart = target.slice(0, atIndex).trim();
			const hostPart = target.slice(atIndex + 1).trim();
			if (userPart && hostPart) {
				username = userPart;
				target = hostPart;
				parsed = true;
			}
		}

		let parsedHost = target;
		const bracketMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(target);
		if (bracketMatch) {
			parsedHost = bracketMatch[1]!.trim();
			if (bracketMatch[2]) {
				const candidate = Number(bracketMatch[2]);
				if (candidate < 1 || candidate > 65535) return;
				parsedPort = candidate;
			}
			parsed = true;
		} else {
			const colonIndex = target.lastIndexOf(':');
			if (colonIndex > 0 && target.indexOf(':') === colonIndex) {
				const candidate = Number(target.slice(colonIndex + 1));
				if (!Number.isInteger(candidate) || candidate < 1 || candidate > 65535) return;
				parsedHost = target.slice(0, colonIndex).trim();
				parsedPort = candidate;
				parsed = true;
			}
		}

		if (!parsed || !parsedHost || /[\s/\\?#@]/u.test(parsedHost)) return;
		return {
			host: parsedHost,
			...(parsedPort !== undefined ? { port: parsedPort } : {}),
			...(username ? { username } : {}),
		};
	}

	function importCommand(): void {
		if (saving.value || !command.value.trim()) return;
		const parsed = parseQuickAddress(command.value);
		commandInvalid.value = !parsed;
		if (!parsed) return;

		host.value = parsed.host;
		port.value = String(parsed.port ?? 22);
		if (!inlineCredential.value.username.trim() || inlineCredential.value.username === addressUsername.value)
			inlineCredential.value.username = parsed.username ?? '';
		addressUsername.value = parsed.username ?? '';
		chooseDefaultCredential();
		importOpen.value = false;
		void nextTick(() => {
			const form = formEl.value;
			form?.ownerDocument.getElementById(hostId)?.focus({ preventScroll: true });
			form?.closest('.ui-scroll-area')?.scrollTo({ top: 0 });
		});
	}

	async function uploadPrivateKey(event: Event): Promise<void> {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			if (file.size > PRIVATE_KEY_LIMIT) throw new WorkspaceModuleError('CREDENTIALS_FILE_TOO_LARGE');
			const content = await file.text();
			if (props.open && input === keyFileInput.value && !props.view.signal.aborted)
				inlineCredential.value.privateKey = content;
		} catch (cause) {
			if (!props.view.signal.aborted) props.report(cause);
		} finally {
			input.value = '';
		}
	}

	async function submit(connectNow: boolean): Promise<void> {
		if (saving.value || !props.open || props.view.signal.aborted || !props.connections?.create) return;

		const address = host.value.trim();
		const trimmedHost = /^\[([^\]]+:[^\]]+)\]$/u.exec(address)?.[1] ?? address;
		const firstColon = trimmedHost.indexOf(':');
		const numericPort = Number(port.value);
		if (
			!trimmedHost ||
			trimmedHost.length > 253 ||
			(firstColon !== -1 && firstColon === trimmedHost.lastIndexOf(':')) ||
			trimmedHost.startsWith('[') ||
			/[\s/\\?#@]/u.test(trimmedHost) ||
			!Number.isInteger(numericPort) ||
			numericPort < 1 ||
			numericPort > 65535
		) {
			props.report(new WorkspaceModuleError('CONNECTIONS_INVALID_REQUEST'));
			return;
		}

		if (formEl.value && !formEl.value.reportValidity()) return;
		const method = inlineType.value;
		let credInput: CredentialInput | undefined;
		if (method) {
			const cred = inlineCredential.value;
			const username = cred.username.trim();
			const credName = cred.name.trim() || autoCredentialName.value.slice(0, 120);
			if (!username) {
				props.report(new WorkspaceModuleError('CREDENTIALS_INVALID_REQUEST'));
				return;
			}
			if (method === 'password') {
				if (!cred.password) {
					props.report(new WorkspaceModuleError('CREDENTIALS_INVALID_REQUEST'));
					return;
				}
				credInput = { name: credName, username, type: 'password', password: cred.password };
			} else {
				if (!cred.privateKey) {
					props.report(new WorkspaceModuleError('CREDENTIALS_INVALID_REQUEST'));
					return;
				}
				credInput = {
					name: credName,
					username,
					type: 'privateKey',
					privateKey: cred.privateKey,
					...(cred.passphrase ? { passphrase: cred.passphrase } : {}),
				};
			}
		} else if (connectNow && !existingCredential.value) {
			props.report(new WorkspaceModuleError('WORKSPACE_CREDENTIAL_REQUIRED'));
			return;
		}

		saving.value = true;
		saveAction.value = connectNow ? 'connect' : 'save';
		try {
			let linkedCredentialId = existingCredential.value?.id ?? null;
			if (credInput && props.credentials?.create) {
				const createdCredential = await props.credentials.create(credInput, {
					view: props.view,
					signal: props.view.signal,
					silent: true,
				});
				if (props.view.signal.aborted) return;
				linkedCredentialId = createdCredential.id;
				chooseCredential(createdCredential.id);
				inlineCredential.value.password = '';
				inlineCredential.value.privateKey = '';
				inlineCredential.value.passphrase = '';
			}

			const created = await props.connections.create(
				{
					name: name.value.trim() || trimmedHost.slice(0, 120),
					type: 'ssh',
					host: trimmedHost,
					port: numericPort,
					credentialId: linkedCredentialId,
					username: linkedCredentialId ? '' : addressUsername.value,
					domain: '',
					notes: '',
					tags: [],
				},
				{ view: props.view, signal: props.view.signal },
			);
			if (props.view.signal.aborted) return;
			emit('created', created, connectNow && !!created.credentialId);
		} catch (cause) {
			if (!props.view.signal.aborted) props.report(cause);
		} finally {
			saving.value = false;
		}
	}
</script>
<template>
	<UiDialog
		:open="open"
		class="workspace-create-dialog"
		:title="t('quickConnect.title')"
		:close-label="t('close')"
		size="md"
		:close-disabled="saving"
		:close-on-interact-outside="false"
		@update:open="(value) => !saving && emit('update:open', value)"
	>
		<form
			ref="formEl"
			:id="formId"
			class="workspace-create-form"
			novalidate
			@submit.prevent="submit(hasCredential)"
		>
			<UiField :label="t('quickConnect.name')" v-slot="field">
				<UiInput
					v-model="name"
					:id="field.id"
					:placeholder="t('quickConnect.namePlaceholder')"
					maxlength="120"
					:disabled="saving"
				/>
			</UiField>
			<div class="workspace-create-address">
				<UiField :id="hostId" :label="t('quickConnect.host')">
					<UiInput
						v-model="host"
						:id="hostId"
						:placeholder="t('quickConnect.hostPlaceholder')"
						required
						maxlength="255"
						autocomplete="off"
						spellcheck="false"
						:disabled="saving"
					/>
				</UiField>
				<UiField :label="t('quickConnect.port')" v-slot="field">
					<UiInput
						:model-value="port"
						:id="field.id"
						type="number"
						required
						min="1"
						max="65535"
						step="1"
						:disabled="saving"
						@update:model-value="port = String($event)"
					/>
				</UiField>
			</div>
			<fieldset v-if="canInlineCreate" class="workspace-create-auth">
				<legend>{{ t('quickConnect.credential') }}</legend>
				<div class="workspace-create-auth__bar">
					<label v-for="option in authModes" :key="option.value">
						<input
							type="radio"
							:name="authModeName"
							:checked="authMode === option.value"
							:disabled="saving"
							@change="chooseAuthMode(option.value)"
						/>
						<span>{{ option.label }}</span>
					</label>
				</div>
			</fieldset>
			<UiField
				v-if="authMode === 'saved'"
				:label="t(canInlineCreate ? 'quickConnect.savedCredential' : 'quickConnect.credential')"
				v-slot="field"
			>
				<UiSelect
					:id="field.id"
					:model-value="credentialChoice"
					:options="credentialOptions"
					block
					:disabled="saving"
					@update:model-value="chooseCredential"
				/>
			</UiField>
			<div v-if="inlineType" class="workspace-inline-cred" :data-auth="inlineType">
				<UiField class="workspace-inline-username" :label="t('quickConnect.username')" v-slot="field">
					<UiInput
						v-model="inlineCredential.username"
						:id="field.id"
						required
						maxlength="120"
						autocomplete="off"
						:disabled="saving"
					/>
				</UiField>
				<UiField v-if="inlineType === 'password'" :label="t('quickConnect.password')" v-slot="field">
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
					<UiField
						class="workspace-key-field"
						:label="t('quickConnect.privateKey')"
						:hint="t('quickConnect.uploadHint')"
						v-slot="field"
					>
						<UiButton
							type="button"
							density="compact"
							class="workspace-key-file"
							:disabled="saving"
							@click="keyFileInput?.click()"
						>
							<template #leading><Upload :size="14" /></template>{{ t('quickConnect.uploadPrivateKey') }}
						</UiButton>
						<textarea
							v-model="inlineCredential.privateKey"
							:id="field.id"
							:aria-describedby="field.describedby"
							:placeholder="t('quickConnect.pastePrivateKey')"
							class="workspace-inline-key"
							required
							rows="3"
							spellcheck="false"
							autocomplete="off"
							:disabled="saving"
						/>
						<input
							ref="keyFileInput"
							type="file"
							hidden
							:aria-label="t('quickConnect.uploadPrivateKey')"
							@change="uploadPrivateKey"
						/>
					</UiField>
					<UiField :label="t('quickConnect.passphrase')" v-slot="field">
						<UiInput
							v-model="inlineCredential.passphrase"
							:id="field.id"
							type="password"
							autocomplete="new-password"
							:disabled="saving"
						/>
					</UiField>
				</template>
				<UiField class="workspace-inline-cred-name" :label="t('quickConnect.credentialName')" v-slot="field">
					<UiInput
						v-model="inlineCredential.name"
						:id="field.id"
						:placeholder="autoCredentialName || t('quickConnect.credentialNamePlaceholder')"
						maxlength="120"
						:disabled="saving"
					/>
				</UiField>
			</div>
			<details
				class="workspace-create-import"
				:open="importOpen"
				@toggle="importOpen = ($event.currentTarget as HTMLDetailsElement).open"
			>
				<summary>{{ t('quickConnect.importTitle') }}</summary>
				<div class="workspace-create-import__body">
					<UiField :label="t('quickConnect.command')" v-slot="field">
						<UiInput
							v-model="command"
							:id="field.id"
							:placeholder="t('quickConnect.commandPlaceholder')"
							:aria-describedby="commandInvalid ? commandErrorId : undefined"
							:invalid="commandInvalid"
							maxlength="1024"
							autocomplete="off"
							spellcheck="false"
							:disabled="saving"
							@update:model-value="commandInvalid = false"
							@keydown.enter.prevent="importCommand"
						/>
					</UiField>
					<UiButton type="button" :disabled="saving || !command.trim()" @click="importCommand">
						{{ t('quickConnect.applyCommand') }}
					</UiButton>
					<p v-if="commandInvalid" :id="commandErrorId" role="status">
						{{ t('quickConnect.invalidCommand') }}
					</p>
				</div>
			</details>
		</form>
		<template #footer>
			<UiButton
				class="workspace-create-cancel"
				appearance="ghost"
				:disabled="saving"
				@click="emit('update:open', false)"
				>{{ t('cancel') }}</UiButton
			>
			<UiButton
				:disabled="saving"
				:loading="saving && saveAction === 'save'"
				loading-animation="spinner"
				:tone="hasCredential ? 'neutral' : 'primary'"
				:appearance="hasCredential ? 'soft' : 'solid'"
				@click="submit(false)"
			>
				{{ t('quickConnect.saveOnly') }}
			</UiButton>
			<UiButton
				v-if="hasCredential"
				:form="formId"
				type="submit"
				tone="primary"
				appearance="solid"
				:disabled="saving"
				:loading="saving && saveAction === 'connect'"
				loading-animation="spinner"
			>
				{{ t('quickConnect.saveAndConnect') }}
			</UiButton>
		</template>
	</UiDialog>
</template>
