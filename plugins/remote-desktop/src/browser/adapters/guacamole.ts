import Guacamole from 'guacamole-common-js';
import type { DesktopDisplay, DesktopProtocol } from '../../shared/desktop-session';
import { RemoteDesktopFailure, type RemoteDesktopPeerOptions } from '../desktop-peer';
import { attachMobileInput } from './desktop-mobile-input';
import { attachDesktopTouch } from './desktop-touch';

export function openGuacamoleDesktop(
	options: RemoteDesktopPeerOptions,
	url: string,
	query: string,
	protocol: DesktopProtocol,
	initial: DesktopDisplay,
) {
	const element = document.createElement('div');
	element.className = 'remote-desktop-guacamole';
	element.tabIndex = 0;
	const client = new Guacamole.Client(new Guacamole.WebSocketTunnel(url));
	const display = client.getDisplay();
	const surface = display.getElement();
	const fill = options.fillViewport;
	if (fill) {
		element.dataset.fill = '';
		Object.assign(surface.style, { position: 'absolute', top: '0', left: '0', transformOrigin: 'top left' });
	}
	element.append(surface);

	let closed = false;
	let connected = false;
	let ready = false;
	let size = initial;
	let sizeTimer: ReturnType<typeof setTimeout> | undefined;
	let scaleX = 1;
	let scaleY = 1;
	const keyboard = new Guacamole.Keyboard(element);
	keyboard.onkeydown = (key) => {
		if (!closed) client.sendKeyEvent(1, key);
		return false;
	};
	keyboard.onkeyup = (key) => {
		if (!closed) client.sendKeyEvent(0, key);
	};
	const detachMobileInput = attachMobileInput(
		options.mobileInput,
		(text) => keyboard.type(text),
		(key) => {
			const keysym = key === 'Backspace' ? 0xff08 : 0xff0d;
			client.sendKeyEvent(1, keysym);
			client.sendKeyEvent(0, keysym);
		},
		() => !closed && ready && connected,
	);

	const release = () => keyboard.reset();

	element.addEventListener('blur', release);
	window.addEventListener('blur', release);
	const inputSurface = fill ? element : surface;
	const mouse = new Guacamole.Mouse(inputSurface);
	const touch = options.hasTouch ? attachDesktopTouch(inputSurface, inputSurface, options.touchMode) : undefined;
	mouse.onEach(['mousedown', 'mousemove', 'mouseup'], ({ state }) => {
		if (closed) return;
		if (
			(state.left || state.middle || state.right) &&
			(!options.mobileInput || document.activeElement !== options.mobileInput)
		)
			element.focus({ preventScroll: true });
		if (fill) {
			const x = Math.max(0, Math.min(display.getWidth() - 1, state.x / scaleX));
			const y = Math.max(0, Math.min(display.getHeight() - 1, state.y / scaleY));
			client.sendMouseState({ ...state, x, y }, false);
		} else client.sendMouseState(state, true);
	});

	function fit(): void {
		const width = display.getWidth();
		const height = display.getHeight();
		if (closed || !width || !height || !element.clientWidth || !element.clientHeight) return;
		scaleX = element.clientWidth / width;
		scaleY = element.clientHeight / height;
		display.scale(fill ? scaleX : Math.min(scaleX, scaleY));
		if (fill) surface.style.transform = `scaleY(${scaleY / scaleX})`;
		if (connected && !ready) {
			ready = true;
			options.onState('connected');
		}
	}

	const observer = new ResizeObserver(fit);
	observer.observe(element);
	display.onresize = fit;
	client.onerror = () => {
		if (!closed) options.onFailure(new RemoteDesktopFailure('remote_unavailable', 'unknown'));
	};
	client.onstatechange = (state) => {
		if (closed) return;
		if (state === Guacamole.Client.State.CONNECTED) {
			connected = true;
			fit();
		}
		if (state === Guacamole.Client.State.DISCONNECTED) {
			connected = false;
			options.onState('disconnected');
		}
	};

	function close(): void {
		if (closed) return;
		release();
		touch?.close();
		closed = true;
		detachMobileInput();
		clearTimeout(sizeTimer);
		window.removeEventListener('blur', release);
		element.removeEventListener('blur', release);
		observer.disconnect();
		display.onresize = null;
		keyboard.onkeydown = null;
		keyboard.onkeyup = null;
		client.onstatechange = null;
		client.onerror = null;
		client.disconnect();
	}

	try {
		client.connect(query);
	} catch (cause) {
		close();
		throw cause;
	}
	return {
		element,
		close,

		resize(next: DesktopDisplay) {
			fit();
			if (protocol !== 'rdp' || (next.width === size.width && next.height === size.height)) return;
			size = next;
			clearTimeout(sizeTimer);
			sizeTimer = setTimeout(() => {
				if (connected && !closed) client.sendSize(size.width, size.height);
			}, 180);
		},

		focus() {
			element.focus({ preventScroll: true });
		},

		sendText(text: string) {
			if (!closed && ready && connected) keyboard.type(text);
		},
	};
}
