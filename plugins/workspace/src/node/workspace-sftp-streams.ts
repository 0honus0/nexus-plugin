import { addAbortSignal, Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { SFTPWrapper } from 'ssh2';
import { WorkspaceError } from './workspace-error';

// 32 × 64 KiB bounds memory to 2 MiB per direction. Public SFTP requests only.
const CHUNK = 64 * 1024;
const CONCURRENCY = 32;

export function readSftpFile(
	sftp: SFTPWrapper,
	path: string,
	options: { signal: AbortSignal; start?: number; end?: number },
) {
	async function* chunks() {
		const { signal } = options;
		signal.throwIfAborted();
		const handle = await promisify(sftp.open.bind(sftp))(path, 'r');
		const reads: Promise<PromiseSettledResult<Buffer>>[] = [];
		try {
			const attrs = await promisify(sftp.fstat.bind(sftp))(handle);
			const end = Math.min(options.end ?? attrs.size - 1, attrs.size - 1);
			let position = options.start ?? 0;

			// Refill as ordered chunks are consumed, rather than waiting for the slowest
			// request in a whole batch. Resolved out-of-order chunks occupy the same
			// bounded window, so downstream backpressure still limits prefetch.
			function refill() {
				while (reads.length < CONCURRENCY && position <= end) {
					signal.throwIfAborted();
					const from = position,
						length = Math.min(CHUNK, end - from + 1);
					position += length;
					reads.push(
						(async () => {
							const buffer = Buffer.allocUnsafe(length);
							let used = 0;
							while (used < length) {
								signal.throwIfAborted();
								const bytes = await new Promise<number>((resolve, reject) =>
									sftp.read(handle, buffer, used, length - used, from + used, (cause, size) =>
										cause ? reject(cause) : resolve(size),
									),
								);
								if (!bytes) throw new WorkspaceError('WORKSPACE_TRANSFER_SOURCE_CHANGED', 409);
								used += bytes;
							}
							return buffer;
						})().then<PromiseSettledResult<Buffer>, PromiseSettledResult<Buffer>>(
							(value) => ({ status: 'fulfilled', value }),
							(reason) => ({ status: 'rejected', reason }),
						),
					);
				}
			}

			refill();
			while (reads.length) {
				const item = await reads[0]!;
				reads.shift();
				signal.throwIfAborted();
				if (item.status === 'rejected') throw item.reason;
				yield item.value;
				refill();
			}
		} finally {
			// Neither cancellation nor a failed read may close a handle with requests in flight.
			await Promise.allSettled(reads);
			await promisify(sftp.close.bind(sftp))(handle);
		}
	}

	return Readable.from(chunks(), { objectMode: false, highWaterMark: CHUNK });
}

export async function writeSftpFile(
	sftp: SFTPWrapper,
	path: string,
	source: Readable,
	options: { signal: AbortSignal; mode?: number; size?: number; progress?: (bytes: number) => void },
) {
	const { signal } = options;
	signal.throwIfAborted();
	const handle = await new Promise<Buffer>((resolve, reject) =>
		sftp.open(path, 'wx', options.mode ?? 0o600, (cause, handle) => (cause ? reject(cause) : resolve(handle))),
	);
	const pending = new Set<Promise<void>>();
	let position = 0,
		confirmed = 0,
		failure: unknown;

	// 文件打开期间也可能取消；Node 同时处理已经取消的信号和后续取消。
	addAbortSignal(signal, source);
	try {
		for await (const raw of source) {
			signal.throwIfAborted();
			const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
			for (let offset = 0; offset < chunk.length; offset += CHUNK) {
				if (failure) throw failure;
				signal.throwIfAborted();
				const bytes = chunk.subarray(offset, Math.min(offset + CHUNK, chunk.length)),
					at = position;
				position += bytes.length;
				if (options.size !== undefined && position > options.size)
					throw new WorkspaceError('WORKSPACE_TRANSFER_SIZE_MISMATCH', 409);
				const writing = new Promise<void>((resolve, reject) =>
					sftp.write(handle, bytes, 0, bytes.length, at, (cause) => (cause ? reject(cause) : resolve())),
				)
					.then(() => {
						confirmed += bytes.length;
						options.progress?.(confirmed);
					})
					.catch((cause) => {
						failure ??= cause;
						// 远端拒绝写入后终止上游等待，保留原始 SFTP 错误及其错误码。
						source.destroy(
							cause instanceof Error ? cause : new WorkspaceError('WORKSPACE_TRANSFER_UNKNOWN'),
						);
					})
					.finally(() => {
						pending.delete(writing);
					});
				pending.add(writing);
				if (pending.size >= CONCURRENCY) await Promise.race(pending);
			}
		}
		await Promise.all(pending);
		if (failure) throw failure;
		signal.throwIfAborted();
		if (options.size !== undefined && confirmed !== options.size)
			throw new WorkspaceError('WORKSPACE_TRANSFER_SIZE_MISMATCH', 409);
	} finally {
		await Promise.allSettled(pending);
		await promisify(sftp.close.bind(sftp))(handle);
	}
	return confirmed;
}

export async function downloadSftpFile(
	sftp: SFTPWrapper,
	path: string,
	destination: Writable,
	options: { signal: AbortSignal; start?: number; end?: number; progress?: (bytes: number) => void },
) {
	const source = readSftpFile(sftp, path, options);
	let bytes = 0;

	// A fixed-length HTTP download can finish at the client as soon as its last
	// byte arrives. Keep one chunk until EOF (including SFTP CLOSE) is confirmed.
	async function* confirmed(chunks: AsyncIterable<Buffer>) {
		let tail: Buffer | undefined;
		for await (const chunk of chunks) {
			if (tail) {
				bytes += tail.length;
				options.progress?.(bytes);
				yield tail;
			}
			tail = chunk;
		}
		options.signal.throwIfAborted();
		if (tail) {
			bytes += tail.length;
			options.progress?.(bytes);
			yield tail;
		}
	}

	await pipeline(source, confirmed, destination, { signal: options.signal });
	return bytes;
}
