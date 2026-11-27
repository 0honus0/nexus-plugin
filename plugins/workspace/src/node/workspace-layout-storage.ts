import type { PluginDatabaseApi } from 'nexus-terminal/node';
import { WorkspaceLayoutSchema, type WorkspaceLayout } from '../shared/workspace-layout-types';
import type { LayoutProfile } from '../shared/layout-types.js';

type Tables = { layouts: { profile: string; document: string } };

export class WorkspaceLayoutStorage {
	constructor(private readonly database: PluginDatabaseApi) {}

	get(profile: LayoutProfile) {
		return this.database.withClient(async (client) => {
			const db = client.$extendTables<Tables>();
			const row =
				(await db.selectFrom('layouts').select('document').where('profile', '=', profile).executeTakeFirst()) ??
				(profile === 'wide'
					? await db
							.selectFrom('layouts')
							.select('document')
							.where('profile', '=', 'medium')
							.executeTakeFirst()
					: undefined);
			return row ? WorkspaceLayoutSchema.parse(JSON.parse(row.document)) : null;
		});
	}

	async save(profile: LayoutProfile, value: WorkspaceLayout) {
		const document = JSON.stringify(WorkspaceLayoutSchema.parse(value));
		await this.database.withClient((client) =>
			client
				.$extendTables<Tables>()
				.transaction()
				.execute(async (trx) => {
					await trx
						.insertInto('layouts')
						.values({ profile, document })
						.onConflict((conflict) => conflict.column('profile').doUpdateSet({ document }))
						.execute();
					if (profile === 'wide') {
						await trx.deleteFrom('layouts').where('profile', '=', 'medium').execute();
					}
				}),
		);
	}
}
