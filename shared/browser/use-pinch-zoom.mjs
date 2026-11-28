import { useEventListener } from '@vueuse/core';

export function usePinchZoom(target, begin, zoom) {
	let distance = 0;

	function separation(touches) {
		const first = touches[0];
		const second = touches[1];
		return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
	}

	useEventListener(
		target,
		'touchstart',
		(event) => {
			distance = 0;
			if (event.touches.length !== 2) return;
			distance = separation(event.touches);
			begin();
			event.preventDefault();
		},
		{ passive: false, capture: true },
	);
	useEventListener(
		target,
		'touchmove',
		(event) => {
			if (!distance || event.touches.length !== 2) return;
			event.preventDefault();
			zoom(separation(event.touches) / distance);
		},
		{ passive: false, capture: true },
	);
	useEventListener(target, ['touchend', 'touchcancel'], () => {
		distance = 0;
	});
}
