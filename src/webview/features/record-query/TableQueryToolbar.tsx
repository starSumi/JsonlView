import { CompactQueryHud } from './CompactQueryHud';
import type { CompactQueryHudProps } from './CompactQueryHud';

export type TableQueryToolbarProps = CompactQueryHudProps;

/**
 * Compatibility name for callers that still describe the surface as a table
 * toolbar. The implementation lives at the query-feature HUD boundary.
 */
export const TableQueryToolbar = CompactQueryHud;
