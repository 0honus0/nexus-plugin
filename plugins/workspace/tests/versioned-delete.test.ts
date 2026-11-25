import { expect, it } from 'vitest';
import { CatalogDeleteSchema } from '../src/shared/workspace-catalog-http-types';
import { BackgroundDeleteSchema } from '../src/shared/workspace-background-http-types';

it('accepts decimal query versions while requiring positive resource versions', () => {
	expect(CatalogDeleteSchema.parse({ version: '2' })).toEqual({ version: 2 });
	expect(CatalogDeleteSchema.safeParse({ version: '0' }).success).toBe(false);
	expect(BackgroundDeleteSchema.parse({ version: '0' })).toEqual({ version: 0 });
	expect(BackgroundDeleteSchema.parse({ version: '2' })).toEqual({ version: 2 });
});

it.each([undefined, '', ' ', '01', '-1', '1.5', '1e2', '9007199254740992', ['1', '2'], 1])(
	'rejects malformed or ambiguous query version %j',
	(version) => {
		expect(CatalogDeleteSchema.safeParse({ version }).success).toBe(false);
		expect(BackgroundDeleteSchema.safeParse({ version }).success).toBe(false);
	},
);
