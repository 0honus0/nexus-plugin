import type { SessionInfo } from '../shared/workspace-types';

export function summarizeWorkspaceSessions(items: readonly SessionInfo[]) {
	const counts = { attached: 0, suspended: 0, disconnected: 0, transfers: 0 };
	for (const item of items) {
		counts[item.state]++;
		counts.transfers += item.transfers;
	}
	return counts;
}
