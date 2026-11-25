import { z } from 'zod';
import { WorkspacePreferencesSchema } from './workspace-catalog-types';

export const CatalogWriteSchema = z.strictObject({
	version: z.number().int().nonnegative(),
	value: z.unknown(),
});

export const CatalogDeleteSchema = z.strictObject({
	version: z
		.string()
		.regex(/^[1-9]\d*$/u)
		.transform(Number)
		.pipe(z.number().int().positive().safe()),
});

export const PreferencesWriteSchema = WorkspacePreferencesSchema.extend({
	version: z.number().int().nonnegative(),
});
