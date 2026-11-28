declare module 'guacamole-common-js' {
	interface MouseState {
		x: number;
		y: number;
		left: boolean;
		middle: boolean;
		right: boolean;
	}

	class Tunnel {
		constructor(url: string);
	}

	class Display {
		onresize: (() => void) | null;

		getElement(): HTMLElement;

		getWidth(): number;

		getHeight(): number;

		scale(ratio: number): void;
	}

	class Client {
		static readonly State: { CONNECTED: number; DISCONNECTED: number };

		constructor(tunnel: Tunnel);

		onerror: (() => void) | null;
		onstatechange: ((state: number) => void) | null;

		getDisplay(): Display;

		connect(data: string): void;

		disconnect(): void;

		sendMouseState(state: MouseState, applyDisplayScale: boolean): void;

		sendKeyEvent(pressed: 0 | 1, keysym: number): void;

		sendSize(width: number, height: number): void;
	}

	class Keyboard {
		constructor(element: HTMLElement);

		onkeydown: ((key: number) => boolean) | null;
		onkeyup: ((key: number) => void) | null;

		reset(): void;

		type(text: string): void;
	}

	class Mouse {
		constructor(element: HTMLElement);

		onEach(events: string[], handler: (event: { state: MouseState }) => void): void;
	}

	const Guacamole: {
		Client: typeof Client;
		WebSocketTunnel: typeof Tunnel;
		Mouse: typeof Mouse;
		Keyboard: typeof Keyboard;
	};
	export default Guacamole;
}
