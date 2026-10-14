import { analysisConditionsEqual } from '../shared/analysis-intent';
import type { AnalysisIntentV1 } from '../shared/types';

/** Automatic effects may issue each failed semantic condition only once. */
export function shouldIssueInsightRequest(intent: AnalysisIntentV1, failed: AnalysisIntentV1 | undefined,
  automatic: boolean): boolean {
  return !automatic || failed === undefined || !analysisConditionsEqual(intent, failed);
}
