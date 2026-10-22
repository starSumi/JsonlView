import { RecordPager, type RecordPagerProps } from '../record-query/RecordPager';

/**
 * Workspace composition seam for the page controls.
 *
 * Paging state and callbacks remain owned by App/RowQueryController; this
 * component only composes the existing render contract.
 */
export type WorkspacePageControlsProps = RecordPagerProps;

// Keep the existing React element identity for tests and consumers that inspect
// the pager at the workspace presentation boundary.
export const WorkspacePageControls = RecordPager;
