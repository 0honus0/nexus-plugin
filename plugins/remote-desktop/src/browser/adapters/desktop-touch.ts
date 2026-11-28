import type { RemoteTouchMode } from '../desktop-peer';

export function attachDesktopTouch(
	element: HTMLElement,
	surface: HTMLElement,
	initialMode: RemoteTouchMode,
	onPointer?: (clientX: number, clientY: number) => void,
	dispatchMouse?: (event: MouseEvent) => void,
) {
	let mode = initialMode;
	let startX = 0;
	let startY = 0;
	let lastX = 0;
	let lastY = 0;
	let cursorX = 0;
	let cursorY = 0;
	let cursorInitialized = false;
	let moved = false;
	let dragging = false;
	let buttons = 0;
	let fingers = 0;
	let lastTap: { x: number; y: number; time: number } | undefined;
	let held = false;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const previousTouchAction = element.style.touchAction;
	element.style.touchAction = 'none';

	const mouse = (type: string, button = 0) => {
		const mask = button === 2 ? 2 : 1;
		if (type === 'mousedown') {
			buttons |= mask;
		} else if (type === 'mouseup') {
			buttons &= ~mask;
		}
		const rect = surface.getBoundingClientRect();
		cursorX = Math.max(0, Math.min(Math.max(0, rect.width - 1), cursorX));
		cursorY = Math.max(0, Math.min(Math.max(0, rect.height - 1), cursorY));
		onPointer?.(rect.left + cursorX, rect.top + cursorY);
		const event = new MouseEvent(type, {
			bubbles: true,
			cancelable: true,
			clientX: rect.left + cursorX,
			clientY: rect.top + cursorY,
			button,
			buttons,
		});
		if (dispatchMouse) {
			dispatchMouse(event);
		} else {
			surface.dispatchEvent(event);
		}
	};

	const cancel = () => {
		if (timer) {
			clearTimeout(timer);
		}
		timer = null;
		if (dragging) {
			dragging = false;
			mouse('mouseup');
		}
		fingers = 0;
	};

	const handle = (event: TouchEvent) => {
		event.preventDefault();
		event.stopImmediatePropagation();
		const touch = event.touches[0];
		if (event.type === 'touchstart' && touch) {
			cancel();
			fingers = event.touches.length;
			startX = lastX = touch.clientX;
			startY = lastY = touch.clientY;
			moved = false;
			held = false;
			const rect = surface.getBoundingClientRect();
			if (mode === 'direct') {
				cursorX = touch.clientX - rect.left;
				cursorY = touch.clientY - rect.top;
			} else if (!cursorInitialized) {
				cursorX = rect.width / 2;
				cursorY = rect.height / 2;
			}
			cursorInitialized = true;
			mouse('mousemove');
			if (
				fingers === 1 &&
				lastTap &&
				performance.now() - lastTap.time < 300 &&
				Math.hypot(touch.clientX - lastTap.x, touch.clientY - lastTap.y) <= 16
			) {
				dragging = true;
				mouse('mousedown');
			}
			lastTap = undefined;
			timer = setTimeout(() => {
				timer = null;
				if (fingers === 1 && !moved && !dragging && mode === 'direct') {
					held = true;
					mouse('mousedown', 2);
					mouse('mouseup', 2);
				}
			}, 350);
		} else if (event.type === 'touchmove' && touch) {
			const deltaX = touch.clientX - lastX;
			const deltaY = touch.clientY - lastY;
			lastX = touch.clientX;
			lastY = touch.clientY;
			if (Math.hypot(touch.clientX - startX, touch.clientY - startY) > 8) {
				moved = true;
			}
			if (moved && timer) {
				clearTimeout(timer);
				timer = null;
			}
			if (fingers > 1) {
				const rect = surface.getBoundingClientRect();
				surface.dispatchEvent(
					new WheelEvent('wheel', {
						bubbles: true,
						cancelable: true,
						clientX: rect.left + cursorX,
						clientY: rect.top + cursorY,
						deltaX: -deltaX,
						deltaY: -deltaY,
					}),
				);
				return;
			}
			const rect = surface.getBoundingClientRect();
			cursorX = Math.max(
				0,
				Math.min(rect.width - 1, mode === 'direct' ? touch.clientX - rect.left : cursorX + deltaX),
			);
			cursorY = Math.max(
				0,
				Math.min(rect.height - 1, mode === 'direct' ? touch.clientY - rect.top : cursorY + deltaY),
			);
			mouse('mousemove');
		} else if (event.type === 'touchend') {
			if (event.touches.length > 0) {
				return;
			}
			if (!dragging && !moved && !held) {
				mouse('mousedown', fingers > 1 ? 2 : 0);
				mouse('mouseup', fingers > 1 ? 2 : 0);
				if (fingers === 1) lastTap = { x: lastX, y: lastY, time: performance.now() };
			}
			cancel();
		} else if (event.type === 'touchcancel') {
			cancel();
		}
	};

	const events = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;
	for (const event of events) {
		element.addEventListener(event, handle, { capture: true, passive: false });
	}
	return {
		setMode(value: RemoteTouchMode): void {
			cancel();
			lastTap = undefined;
			mode = value;
		},

		close(): void {
			cancel();
			for (const event of events) {
				element.removeEventListener(event, handle, true);
			}
			element.style.touchAction = previousTouchAction;
		},
	};
}
