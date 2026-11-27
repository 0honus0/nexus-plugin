import { LayoutProfiles, type LayoutProfile } from '../shared/layout-types';

export function resolveLayoutProfile(width: number): LayoutProfile {
	return width >= LayoutProfiles.wide.minWidth ? 'wide' : 'compact';
}
