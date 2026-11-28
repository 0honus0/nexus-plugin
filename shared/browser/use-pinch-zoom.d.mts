import type { Ref } from 'vue';

export function usePinchZoom(
	target: Ref<HTMLElement | undefined>,
	begin: () => void,
	zoom: (ratio: number) => void,
): void;
