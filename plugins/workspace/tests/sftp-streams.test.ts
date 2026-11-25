import { Readable, Writable } from 'node:stream';
import type { SFTPWrapper } from 'ssh2';
import { expect, it, vi } from 'vitest';
import { downloadSftpFile, writeSftpFile } from '../src/node/workspace-sftp-streams';

it('cancels an idle upload when its file was opened after cancellation', async () => {
	const controller = new AbortController();
	let completeOpen!: (cause: Error | null, handle: Buffer) => void;
	const close = vi.fn((_handle, done) => done());
	const sftp = {
		open: (_path: string, _flags: string, _mode: number, done: typeof completeOpen) => {
			completeOpen = done;
		},

		close,
	} as unknown as SFTPWrapper;
	const source = new Readable({ read() {} });
	let settled = false;
	const task = writeSftpFile(sftp, '/file', source, { signal: controller.signal }).finally(() => {
		settled = true;
	});
	const failed = expect(task).rejects.toBeDefined();
	try {
		controller.abort();
		completeOpen(null, Buffer.from('handle'));
		await vi.waitFor(() => expect(settled).toBe(true));
		await failed;
		expect(close).toHaveBeenCalledOnce();
		expect(source.destroyed).toBe(true);
	} finally {
		source.destroy();
		await failed;
	}
});

it('stops waiting for input after a remote write fails and preserves the underlying error', async () => {
	const failure = Object.assign(new Error('permission denied'), { code: 3 });
	const close = vi.fn((_handle, done) => done());
	const sftp = {
		open: (_path: string, _flags: string, _mode: number, done: (cause: Error | null, handle: Buffer) => void) =>
			done(null, Buffer.from('handle')),

		write: (
			_handle: Buffer,
			_bytes: Buffer,
			_offset: number,
			_length: number,
			_position: number,
			done: (cause: Error) => void,
		) => done(failure),

		close,
	} as unknown as SFTPWrapper;
	const source = new Readable({ read() {} });
	source.push(Buffer.from('upload'));
	let settled = false;
	const task = writeSftpFile(sftp, '/file', source, { signal: new AbortController().signal }).finally(() => {
		settled = true;
	});
	const failed = expect(task).rejects.toBe(failure);
	try {
		await vi.waitFor(() => expect(settled).toBe(true));
		await failed;
		expect(close).toHaveBeenCalledOnce();
		expect(source.destroyed).toBe(true);
	} finally {
		source.destroy(failure);
		await failed;
	}
});

it('waits for dispatched writes before closing the remote handle after failure', async () => {
	const failure = new Error('write failed');
	const writes: ((cause?: Error) => void)[] = [];
	const close = vi.fn((_handle, done) => done());
	const sftp = {
		open: (_path: string, _flags: string, _mode: number, done: (cause: Error | null, handle: Buffer) => void) =>
			done(null, Buffer.from('handle')),

		write: (
			_handle: Buffer,
			_bytes: Buffer,
			_offset: number,
			_length: number,
			_position: number,
			done: (cause?: Error) => void,
		) => {
			writes.push(done);
		},

		close,
	} as unknown as SFTPWrapper;
	const source = Readable.from([Buffer.alloc(128 * 1024)]);
	const failed = expect(writeSftpFile(sftp, '/file', source, { signal: new AbortController().signal })).rejects.toBe(
		failure,
	);
	try {
		await vi.waitFor(() => expect(writes).toHaveLength(2));
		writes[0]!(failure);
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(close).not.toHaveBeenCalled();
	} finally {
		for (const done of writes) done();
		await failed;
	}
	expect(close).toHaveBeenCalledOnce();
});

it.each([
	{ size: 20, fail: false },
	{ size: 2 * 65536 + 20, fail: false },
	{ size: 20, fail: true },
])('confirms SFTP close before final download bytes ($size bytes, close failure: $fail)', async ({ size, fail }) => {
	const data = Buffer.alloc(size, 0x61);
	const failure = new Error('SFTP close failed');
	const closing = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const sftp = {
		open: (_path: string, _flags: string, done: (cause: Error | null, handle: Buffer) => void) =>
			done(null, Buffer.from('handle')),

		fstat: (_handle: Buffer, done: (cause: Error | null, attrs: { size: number }) => void) =>
			done(null, { size: data.length }),

		read: (
			_handle: Buffer,
			buffer: Buffer,
			offset: number,
			length: number,
			position: number,
			done: (cause: Error | null, bytes: number, buffer: Buffer) => void,
		) => {
			const bytes = data.copy(buffer, offset, position, position + length);
			done(null, bytes, buffer);
		},

		close: (_handle: Buffer, done: (cause?: Error) => void) => {
			closing.resolve();
			void release.promise.then(() => done(fail ? failure : undefined));
		},
	} as unknown as SFTPWrapper;
	const chunks: Buffer[] = [];
	const sink = new Writable({
		write(chunk: Buffer, _encoding, done) {
			chunks.push(Buffer.from(chunk));
			done();
		},
	});
	const progress = vi.fn();
	const task = downloadSftpFile(sftp, '/file', sink, { signal: new AbortController().signal, progress });
	const settled = fail ? expect(task).rejects.toBe(failure) : expect(task).resolves.toBe(data.length);
	try {
		await closing.promise;
		await new Promise<void>((resolve) => setImmediate(resolve));
		const delivered = Buffer.concat(chunks).length;
		expect(delivered).toBeLessThan(data.length);
		if (size > 65536) expect(delivered).toBeGreaterThan(0);
	} finally {
		release.resolve();
		await settled;
	}
	if (fail) {
		expect(Buffer.concat(chunks)).toHaveLength(0);
		expect(progress).not.toHaveBeenCalled();
	} else {
		expect(Buffer.concat(chunks)).toEqual(data);
		expect(progress).toHaveBeenLastCalledWith(data.length);
	}
});
