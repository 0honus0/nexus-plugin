import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
	resolve: {
		alias: Object.fromEntries(
			['remote-file-types', 'remote-tools-types', 'remote-transfer-types'].map((name) => [
				'@nexus-terminal/remote-tools/' + name,
				fileURLToPath(new URL('../remote-tools/dist/node/' + name + '.js', import.meta.url)),
			]),
		),
	},
});
