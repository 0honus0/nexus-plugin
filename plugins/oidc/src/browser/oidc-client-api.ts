import { PluginHttpError, type AuthLoginActionApi, type PluginContextApi } from 'nexus-terminal/browser';
import { z } from 'zod';
import {
	OidcAuthorizationSchema,
	OidcBindingAuthorizationSchema,
	OidcOriginSchema,
	OidcStatusSchema,
	OidcBindingFinishSchema,
	oidcBindingCallbackPath,
	type OidcBindingInput,
} from '../shared/oidc-http-types.js';

const ErrorSchema = z.object({ code: z.string() });

const bindingTransaction = 'nexus.oidc.binding';

// A provider or reverse proxy may stop responding. Keep the UI's wait bounded
// independently of the server's OIDC discovery/token-exchange timeout.
export async function withOidcDeadline<T>(
	signal: AbortSignal,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const deadline = new AbortController();
	const active = AbortSignal.any([signal, deadline.signal]);
	const timer = setTimeout(() => deadline.abort(new Error('OIDC_REQUEST_TIMEOUT')), 30_000);
	try {
		active.throwIfAborted();
		const result = await operation(active);
		active.throwIfAborted();
		return result;
	} catch (cause) {
		if (signal.aborted) signal.throwIfAborted();
		if (deadline.signal.aborted) deadline.signal.throwIfAborted();
		throw cause;
	} finally {
		clearTimeout(timer);
	}
}

export async function signInWithOidc({ baseURL, signal }: AuthLoginActionApi) {
	const origin = location.origin;
	if (!OidcOriginSchema.safeParse(origin).success) throw new Error('OIDC_ORIGIN_MISMATCH');
	const endpoint = new URL('start', new URL(baseURL, origin));
	const { authorizationUrl } = await withOidcDeadline(signal, async (active) => {
		const response = await fetch(endpoint, {
			method: 'POST',
			signal: active,
			credentials: 'same-origin',
			redirect: 'error',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ origin }),
		});
		if (!response.ok) {
			const error = ErrorSchema.safeParse(await response.json().catch(() => undefined));
			throw new PluginHttpError(response.status, error.data?.code ?? 'OIDC_LOGIN_FAILED');
		}
		return OidcAuthorizationSchema.parse(await response.json());
	});
	signal.throwIfAborted();
	location.assign(authorizationUrl);
}

export async function bindOidcAccount(context: PluginContextApi, input: OidcBindingInput, signal: AbortSignal) {
	if (input.origin !== location.origin) throw new Error('OIDC_ORIGIN_MISMATCH');
	const { authorizationUrl, transaction } = await withOidcDeadline(signal, (active) =>
		context.app.http.json('/binding/start', OidcBindingAuthorizationSchema, {
			method: 'POST',
			signal: active,
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(input),
		}),
	);
	signal.throwIfAborted();
	sessionStorage.setItem(bindingTransaction, transaction);
	try {
		location.assign(authorizationUrl);
	} catch (cause) {
		sessionStorage.removeItem(bindingTransaction);
		throw cause;
	}
}

export async function finishOidcBinding(context: PluginContextApi) {
	if (location.pathname !== oidcBindingCallbackPath) return;
	const query = location.search;
	try {
		history.replaceState(history.state, '', '/');
		const transaction = sessionStorage.getItem(bindingTransaction);
		sessionStorage.removeItem(bindingTransaction);
		const input = OidcBindingFinishSchema.safeParse({ transaction, query });
		if (!input.success) throw new Error('OIDC_BINDING_FAILED');
		await withOidcDeadline(context.signal, (signal) =>
			context.app.http.json('/binding/finish', OidcStatusSchema, {
				method: 'POST',
				signal,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(input.data),
			}),
		);
		context.signal.throwIfAborted();
		context.app.log.report({ level: 'info', code: 'OIDC_ACCOUNT_BOUND', userVisible: true });
	} catch (cause) {
		reportOidcFailure(context, cause);
	}
}

export function reportOidcFailure(context: PluginContextApi, cause: unknown, signal = context.signal) {
	if (signal.aborted || context.signal.aborted) return;
	const code =
		cause instanceof Error && /^OIDC_[A-Z_]+$/u.test(cause.message) ? cause.message : 'OIDC_OPERATION_FAILED';
	context.app.log.report({ level: 'warn', code, userVisible: true });
}
