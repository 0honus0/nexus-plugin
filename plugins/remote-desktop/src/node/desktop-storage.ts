import type { PluginDatabaseApi, PluginModuleApi } from 'nexus-terminal/node';

const certificates = 'rdp_certificates';

type Tables = { [certificates]: { host: string; port: number; fingerprint: string } };

// Certificate trust belongs to this installation.
export const migrations: NonNullable<PluginModuleApi['migrations']> = {
	async getMigrations() {
		return {
			'001_rdp_certificates': {
				async up(db) {
					await db.schema
						.createTable(certificates)
						.addColumn('host', 'text', (column) => column.notNull())
						.addColumn('port', 'integer', (column) => column.notNull())
						.addColumn('fingerprint', 'text', (column) => column.notNull())
						.addPrimaryKeyConstraint('rdp_certificates_pk', ['host', 'port'])
						.execute();
				},
			},
		};
	},
};

export class DesktopStorage {
	constructor(private readonly database: PluginDatabaseApi) {}

	async getFingerprint(host: string, port: number): Promise<string | null> {
		const row = await this.database.withClient((client) =>
			client
				.$extendTables<Tables>()
				.selectFrom(certificates)
				.select('fingerprint')
				.where('host', '=', host)
				.where('port', '=', port)
				.executeTakeFirst(),
		);
		return row?.fingerprint ?? null;
	}

	async rememberFingerprint(
		host: string,
		port: number,
		fingerprint: string,
		previous: string | null,
		signal: AbortSignal,
	) {
		return this.database.withClient(async (client) => {
			signal.throwIfAborted();
			const db = client.$extendTables<Tables>();
			const row =
				previous === null
					? await db
							.insertInto(certificates)
							.values({ host, port, fingerprint })
							.onConflict((conflict) => conflict.columns(['host', 'port']).doNothing())
							.returning('fingerprint')
							.executeTakeFirst()
					: await db
							.updateTable(certificates)
							.set({ fingerprint })
							.where('host', '=', host)
							.where('port', '=', port)
							.where('fingerprint', '=', previous)
							.returning('fingerprint')
							.executeTakeFirst();
			return row !== undefined;
		});
	}
}
