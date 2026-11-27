import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { SFTPWrapper } from 'ssh2';
import { expect, it, vi } from 'vitest';
import type { SshConnectionApi } from '@nexus-terminal/ssh/ssh-api';
import { createWorkspaceFiles } from '../src/node/workspace-files';

const target = '/service.conf';
const original = Buffer.from('enabled=true\n');
const expectedHash = createHash('sha256').update(original).digest('hex');

function fixture(files: Map<string, Buffer>, beforeRead: () => Promise<void> = async () => {}) {
	const sftp = Object.assign(new EventEmitter(), {
		open(
			path: string,
			flags: string,
			mode: number | ((error: null, handle: Buffer) => void),
			callback?: typeof mode,
		) {
			if (flags === 'wx') files.set(path, Buffer.alloc(0));
			const done = typeof mode === 'function' ? mode : callback;
			if (typeof done === 'function') done(null, Buffer.from(path));
		},

		close: vi.fn((_handle, done) => done(null)),
		lstat: vi.fn((_path, done) =>
			done(null, {
				mode: 0o640,
				uid: 1000,
				gid: 1000,

				isFile: () => true,
			}),
		),
		chmod: vi.fn((_path, _mode, done) => done(null)),
		fstat: vi.fn((handle, done) => done(null, { size: files.get(handle.toString())!.length })),
		write: vi.fn((handle, bytes: Buffer, offset: number, length: number, _position: number, done) => {
			files.set(handle.toString(), Buffer.from(bytes.subarray(offset, offset + length)));
			done(null);
		}),
		read: vi.fn((handle, buffer: Buffer, offset: number, length: number, position: number, done) => {
			void beforeRead().then(
				() => done(null, files.get(handle.toString())!.copy(buffer, offset, position, position + length)),
				(error) => done(error),
			);
		}),
		ext_openssh_rename: vi.fn((from, to, done) => {
			files.set(to, files.get(from)!);
			files.delete(from);
			done(null);
		}),
		rename: vi.fn(),
		unlink: vi.fn((path, done) => {
			files.delete(path);
			done(null);
		}),
	});
	const connection = { sftp: async () => sftp as unknown as SFTPWrapper } as SshConnectionApi;
	const workspace = createWorkspaceFiles(connection, undefined, 'demo-server');

	function save(text: string) {
		const bytes = Buffer.from(text);
		return workspace.upload(
			target,
			Readable.from([bytes]),
			new AbortController().signal,
			undefined,
			bytes.length,
			true,
			expectedHash,
		);
	}

	return { save, sftp };
}

it('leaves the original path readable during verification and after a channel failure', async () => {
	const files = new Map([[target, original]]);
	const reading = Promise.withResolvers<void>();
	const result = Promise.withResolvers<void>();
	const { save, sftp } = fixture(files, () => {
		reading.resolve();
		return result.promise;
	});
	const failure = new Error('SFTP channel disconnected');
	const saved = expect(save('draft')).rejects.toBe(failure);
	await reading.promise;
	expect(files.get(target)).toEqual(original);
	result.reject(failure);
	await saved;
	expect([...files]).toEqual([[target, original]]);
	expect(sftp.rename).not.toHaveBeenCalled();
	expect(sftp.ext_openssh_rename).not.toHaveBeenCalled();
});

it('serializes guarded publishes for the same server path across SSH sessions', async () => {
	const files = new Map([[target, original]]);
	const reading = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const first = fixture(files, () => {
		reading.resolve();
		return release.promise;
	});
	const second = fixture(files);
	const saved = first.save('first');
	await reading.promise;
	const rejected = expect(second.save('second')).rejects.toMatchObject({ code: 'WORKSPACE_CONFLICT' });
	release.resolve();
	await saved;
	await rejected;
	expect(files.get(target)).toEqual(Buffer.from('first'));
	expect(first.sftp.ext_openssh_rename).toHaveBeenCalledOnce();
	expect(second.sftp.ext_openssh_rename).not.toHaveBeenCalled();
});

it('leaves the original file in place when the server does not support atomic replacement', async () => {
	const files = new Map([[target, original]]);
	const { save, sftp } = fixture(files);
	sftp.ext_openssh_rename.mockImplementationOnce(() => {
		throw new Error('Server does not support this extended request');
	});
	await expect(save('draft')).rejects.toMatchObject({ code: 'WORKSPACE_ATOMIC_SAVE_UNAVAILABLE' });
	expect([...files]).toEqual([[target, original]]);
	expect(sftp.rename).not.toHaveBeenCalled();
});
