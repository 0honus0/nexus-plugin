import type { SessionInfo } from '../shared/workspace-types';

export type AttachmentStatus = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export function sessionTabStatus(tab: SessionInfo, attachment: AttachmentStatus | undefined, releasing: boolean) {
	if (releasing && (tab.markedForSuspend || tab.state === 'suspended'))
		return { key: 'suspending', tone: 'warning', busy: true } as const;
	if (tab.terminal === 'closed' || attachment === 'disconnected')
		return { key: 'disconnected', tone: 'danger', busy: false } as const;
	if (attachment === 'connected')
		return tab.markedForSuspend || tab.state === 'suspended'
			? ({ key: 'marked', tone: 'info', busy: false } as const)
			: ({ key: 'connected', tone: 'success', busy: false } as const);
	if (tab.state === 'suspended') return { key: 'resuming', tone: 'info', busy: true } as const;
	if (attachment === 'reconnecting') return { key: 'reconnecting', tone: 'warning', busy: true } as const;
	return { key: 'connecting', tone: 'warning', busy: true } as const;
}
