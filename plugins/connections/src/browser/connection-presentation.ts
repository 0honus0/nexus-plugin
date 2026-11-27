import type { Connection } from '../shared/connection-types';

export interface ParsedQuickAddress {
	readonly host: string;
	readonly port?: number;
	readonly username?: string;
}

export function connectionEndpoint(item: Pick<Connection, 'host' | 'port'>) {
	const host = item.host.includes(':') && !item.host.startsWith('[') ? `[${item.host}]` : item.host;
	return `${host}:${item.port}`;
}

export function connectionAddress(item: Pick<Connection, 'host' | 'port' | 'username'>) {
	return `${item.username ? item.username + '@' : ''}${connectionEndpoint(item)}`;
}

/**
 * 解析粘贴的快捷连接串，例如：
 * - `ssh -p 2222 root@192.168.1.10`
 * - `root@192.168.1.10:2222` / `root@[::1]:2222`
 * - `192.168.1.10:2222` / `[::1]:2222`
 * 仅在检测到协议前缀、用户名或端口等可拆分信息时返回结果。
 */
export function parseQuickAddress(raw: string): ParsedQuickAddress | undefined {
	const text = raw.trim();
	if (!text) return;

	let target = text;
	let username: string | undefined;
	let port: number | undefined;
	let parsed = false;

	if (/^ssh\s+/iu.test(target)) {
		parsed = true;
		const tokens = target.split(/\s+/u).slice(1);
		let destination: string | undefined;
		for (let i = 0; i < tokens.length; i++) {
			const token = tokens[i]!;
			if (token === '-p' && tokens[i + 1]) {
				const candidate = Number(tokens[++i]);
				if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) port = candidate;
			} else if (/^-p\d+$/u.test(token)) {
				const candidate = Number(token.slice(2));
				if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) port = candidate;
			} else if (token === '-l' && tokens[i + 1]) {
				username = tokens[++i];
			} else if (token.startsWith('-')) {
				// 跳过常见带参数选项的值，如 -i key.pem
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

	let host = target;
	const bracketMatch = /^\[([^\]]+)\](?::(\d+))?$/u.exec(target);
	if (bracketMatch) {
		host = bracketMatch[1]!.trim();
		if (bracketMatch[2]) {
			const candidate = Number(bracketMatch[2]);
			if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) port = candidate;
		}
		parsed = true;
	} else {
		const colonIndex = target.lastIndexOf(':');
		// 仅在单个冒号时拆分 host:port，避免误拆裸 IPv6 地址。
		if (colonIndex > 0 && target.indexOf(':') === colonIndex) {
			const candidate = Number(target.slice(colonIndex + 1));
			if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) {
				host = target.slice(0, colonIndex).trim();
				port = candidate;
				parsed = true;
			}
		}
	}

	if (!parsed || !host || /[\s/\\?#@]/u.test(host)) return;
	return { host, ...(port !== undefined ? { port } : {}), ...(username ? { username } : {}) };
}
