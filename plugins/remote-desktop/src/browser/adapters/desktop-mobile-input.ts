export function attachMobileInput(
	element: HTMLTextAreaElement | null,
	sendText: (text: string) => void,
	sendKey: (key: 'Backspace' | 'Enter') => void,
	enabled: () => boolean,
): () => void {
	if (!element) return () => {};
	const field = element;
	let committed: { text: string; time: number } | undefined;

	function beforeInput(event: InputEvent): void {
		if (event.isComposing || !enabled()) return;
		event.preventDefault();
		const duplicate = committed?.text === event.data && performance.now() - committed.time < 100;
		committed = undefined;
		if (duplicate || event.inputType === 'insertFromComposition') return;
		if (event.data) sendText(event.data);
		else if (event.inputType === 'deleteContentBackward') sendKey('Backspace');
		else if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') sendKey('Enter');
	}

	function composition(event: CompositionEvent): void {
		if (enabled() && event.data) {
			committed = { text: event.data, time: performance.now() };
			sendText(event.data);
		}
		field.value = '';
	}

	function keydown(event: KeyboardEvent): void {
		if (event.isComposing || !enabled() || (event.key !== 'Backspace' && event.key !== 'Enter')) return;
		event.preventDefault();
		sendKey(event.key);
	}

	field.addEventListener('beforeinput', beforeInput);
	field.addEventListener('compositionend', composition);
	field.addEventListener('keydown', keydown);
	return () => {
		field.removeEventListener('beforeinput', beforeInput);
		field.removeEventListener('compositionend', composition);
		field.removeEventListener('keydown', keydown);
	};
}
