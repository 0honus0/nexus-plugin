import { afterEach, expect, it, vi } from 'vitest';
import type { PluginContextApi } from 'nexus-terminal/node';
import { PasskeyService } from '../src/node/passkey-service';
import { PasskeyStorage } from '../src/node/passkey-storage';

function fixture(username = 'test-user') {
	const controller = new AbortController();
	const getAccount = vi.fn(async (_signal: AbortSignal) => ({ id: 'owner' as const, username }));
	const service = new PasskeyService({
		signal: controller.signal,
		app: { database: {} },
		authMethods: { getAccount },
	} as unknown as PluginContextApi);
	return { service, controller, getAccount };
}

afterEach(() => vi.restoreAllMocks());

it('uses the real account name for both display fields and preserves the existing opaque user handle', async () => {
	const handle = Buffer.alloc(32, 7).toString('base64url');
	vi.spyOn(PasskeyStorage.prototype, 'registrationCredentials').mockResolvedValue([
		{ id: 'fixture', user_handle: handle },
	]);
	const { service, controller, getAccount } = fixture('测试账号');
	const { options } = await service.startRegistration('https://nexus.example', controller.signal);
	expect(getAccount).toHaveBeenCalledExactlyOnceWith(controller.signal);
	expect(options.user).toEqual({ id: handle, name: '测试账号', displayName: '测试账号' });
	expect(options.excludeCredentials).toEqual([expect.objectContaining({ id: 'fixture' })]);
	expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
});

it('uses a stable opaque handle for new credentials instead of deriving identity from the username', async () => {
	vi.spyOn(PasskeyStorage.prototype, 'registrationCredentials').mockResolvedValue([]);
	const { service, controller, getAccount } = fixture();
	const first = await service.startRegistration('https://nexus.example', controller.signal);
	getAccount.mockResolvedValueOnce({ id: 'owner', username: 'renamed-user' });
	const second = await service.startRegistration('https://nexus.example', controller.signal);
	expect(first.options.user.name).toBe('test-user');
	expect(second.options.user.name).toBe('renamed-user');
	expect(second.options.user.displayName).toBe('renamed-user');
	expect(first.options.user.id).toBe(second.options.user.id);
	expect(Buffer.from(first.options.user.id, 'base64url')).toHaveLength(32);
	expect(first.options.challenge).not.toBe(second.options.challenge);
});

it('does not issue options after cancellation', async () => {
	const storage = vi.spyOn(PasskeyStorage.prototype, 'registrationCredentials').mockResolvedValue([]);
	const { service, controller } = fixture();
	controller.abort();
	await expect(service.startRegistration('https://nexus.example', controller.signal)).rejects.toMatchObject({
		name: 'AbortError',
	});
	expect(storage).not.toHaveBeenCalled();
});
