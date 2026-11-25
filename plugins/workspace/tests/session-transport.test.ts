import { effectScope } from 'vue';
import { expect, it, vi } from 'vitest';
import type { PluginContextApi } from 'nexus-terminal/browser';
import { useSessionTransport } from '../src/browser/use-session-transport';

it('owns the terminal attachment for the pane lifetime and ignores callbacks after disposal', () => {
	const scope = effectScope();
	const owner = new AbortController();
	const close = vi.fn();
	const send = vi.fn(() => true);
	let callbacks!: {
		signal: AbortSignal;
		onDisconnected(): void;
		onMessage(socket: unknown, event: { data: string }): void;
	};
	const connect = vi.fn((_path, options: typeof callbacks) => {
		callbacks = options;
		return { close, send };
	});
	const transport = scope.run(() =>
		useSessionTransport(
			{ signal: owner.signal, app: { ws: { connect } } } as unknown as PluginContextApi,
			'fixture',
			owner.signal,
		),
	)!;
	const listener = vi.fn();
	transport.subscribe(listener);
	const snapshot = { data: JSON.stringify({ type: 'snapshot', data: '', cols: 80, rows: 24, closed: false }) };
	callbacks.onMessage(null, snapshot);
	expect(transport.connected.value).toBe(true);
	scope.stop();
	expect(callbacks.signal.aborted).toBe(true);
	expect(owner.signal.aborted).toBe(false);
	callbacks.onDisconnected();
	callbacks.onMessage(null, snapshot);
	expect(transport.connected.value).toBe(false);
	expect(transport.connecting.value).toBe(false);
	expect(transport.send({ type: 'input', data: 'fixture' })).toBe(false);
	expect(send).not.toHaveBeenCalled();
	expect(listener).toHaveBeenCalledOnce();
});
