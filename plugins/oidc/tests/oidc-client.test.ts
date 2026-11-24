import { afterEach, expect, it, vi } from 'vitest';
import type { PluginContextApi } from 'nexus-terminal/browser';
import { bindOidcAccount, finishOidcBinding, withOidcDeadline } from '../src/browser/oidc-client-api';
import { oidcBindingCallbackPath, type OidcBindingInput } from '../src/shared/oidc-http-types';

const key = 'nexus.oidc.binding';
const transaction = '00000000-0000-4000-8000-000000000001';
const input: OidcBindingInput = {
	issuer: 'https://provider.example',
	origin: 'https://nexus.example',
	clientId: 'fixture',
	authMethod: 'none',
};

function fixture(callback = false) {
	const values = new Map<string, string>();
	const assign = vi.fn();
	const replaceState = vi.fn();
	const report = vi.fn();
	const json = vi.fn();
	const controller = new AbortController();
	vi.stubGlobal('location', {
		origin: input.origin,
		pathname: callback ? oidcBindingCallbackPath : '/',
		search: '?error=access_denied&state=fixture',
		assign,
	});
	vi.stubGlobal('history', { state: null, replaceState });
	vi.stubGlobal('sessionStorage', {
		getItem: (key: string) => values.get(key) ?? null,

		setItem: (key: string, value: string) => values.set(key, value),

		removeItem: (key: string) => values.delete(key),
	});
	const context = {
		signal: controller.signal,
		app: { http: { json }, log: { report } },
	} as unknown as PluginContextApi;
	return { context, values, assign, replaceState, report, json, controller };
}

function waiting(signal: AbortSignal): Promise<never> {
	return new Promise((_, reject) => {
		if (signal.aborted) reject(signal.reason);
		else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
	});
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

it('times out an unanswered request and frees the timer', async () => {
	vi.useFakeTimers();
	const request = withOidcDeadline(new AbortController().signal, waiting);
	const result = expect(request).rejects.toThrow('OIDC_REQUEST_TIMEOUT');
	await vi.advanceTimersByTimeAsync(30000);
	await result;
	expect(vi.getTimerCount()).toBe(0);
});

it('cancels a pending binding without a later redirect or stale transaction', async () => {
	const f = fixture();
	const pending = Promise.withResolvers<{ authorizationUrl: string; transaction: string }>();
	f.json.mockReturnValueOnce(pending.promise);
	const request = bindOidcAccount(f.context, input, f.controller.signal);
	const result = expect(request).rejects.toMatchObject({ name: 'AbortError' });
	f.controller.abort();
	pending.resolve({ authorizationUrl: 'https://provider.example/authorize', transaction });
	await result;
	expect(f.assign).not.toHaveBeenCalled();
	expect(f.values.has(key)).toBe(false);
});

it('allows retry after discovery failure and does not navigate on failure', async () => {
	const f = fixture();
	f.json
		.mockRejectedValueOnce(new Error('OIDC_DISCOVERY_FAILED'))
		.mockResolvedValueOnce({ authorizationUrl: 'https://provider.example/authorize', transaction });
	await expect(bindOidcAccount(f.context, input, f.controller.signal)).rejects.toThrow('OIDC_DISCOVERY_FAILED');
	expect(f.assign).not.toHaveBeenCalled();
	expect(f.values.has(key)).toBe(false);
	await bindOidcAccount(f.context, input, f.controller.signal);
	expect(f.assign).toHaveBeenCalledExactlyOnceWith('https://provider.example/authorize');
	expect(f.values.get(key)).toBe(transaction);
});

it('cleans the transaction if redirect fails', async () => {
	const f = fixture();
	f.json.mockResolvedValueOnce({ authorizationUrl: 'https://provider.example/authorize', transaction });
	f.assign.mockImplementationOnce(() => {
		throw new Error('navigation failed');
	});
	await expect(bindOidcAccount(f.context, input, f.controller.signal)).rejects.toThrow('navigation failed');
	expect(f.values.has(key)).toBe(false);
});

it('reports a rejected callback once and consumes its transaction before exchange', async () => {
	const f = fixture(true);
	f.values.set(key, transaction);
	f.json.mockRejectedValueOnce(new Error('OIDC_BINDING_FAILED'));
	await finishOidcBinding(f.context);
	expect(f.replaceState).toHaveBeenCalledWith(null, '', '/');
	expect(f.values.has(key)).toBe(false);
	expect(f.report).toHaveBeenCalledExactlyOnceWith({ level: 'warn', code: 'OIDC_BINDING_FAILED', userVisible: true });
	expect(f.json).toHaveBeenCalledOnce();
});

it('reports a stalled callback exchange as timeout without claiming success', async () => {
	vi.useFakeTimers();
	const f = fixture(true);
	f.values.set(key, transaction);
	f.json.mockImplementationOnce((_path, _schema, options: { signal: AbortSignal }) => waiting(options.signal));
	const result = finishOidcBinding(f.context);
	await vi.advanceTimersByTimeAsync(30000);
	await result;
	expect(f.values.has(key)).toBe(false);
	expect(f.report).toHaveBeenCalledExactlyOnceWith({
		level: 'warn',
		code: 'OIDC_REQUEST_TIMEOUT',
		userVisible: true,
	});
	expect(vi.getTimerCount()).toBe(0);
});
