import { ThemeFileSchema } from '../../shared/workspace-catalog-types';

export function readTerminalThemeFile(text: string) {
	return ThemeFileSchema.parse(JSON.parse(text));
}
