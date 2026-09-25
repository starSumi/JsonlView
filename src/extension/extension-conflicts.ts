import releaseTargets from '../../config/release-targets.json';

export interface ExtensionContributionManifest {
  id: string;
  packageJSON?: {
    contributes?: {
      commands?: Array<{ command?: unknown }>;
      customEditors?: Array<{ viewType?: unknown }>;
      configuration?: { properties?: Record<string, unknown> } | Array<{ properties?: Record<string, unknown> }>;
    };
  };
}

export interface ExtensionContributionConflict {
  extensionId: string;
  contributionIds: string[];
}

type Contributions = NonNullable<NonNullable<ExtensionContributionManifest['packageJSON']>['contributes']>;

const protectedContributionIds = new Set(releaseTargets.sharedContributionIds);

/** Detect another installed extension that declares JsonlView's stable IDs. */
export function findExtensionContributionConflict(
  currentExtensionId: string,
  installed: readonly ExtensionContributionManifest[],
): ExtensionContributionConflict | undefined {
  const current = currentExtensionId.toLowerCase();
  for (const extension of installed) {
    if (extension.id.toLowerCase() === current) continue;
    const overlap = contributionIds(extension.packageJSON?.contributes)
      .filter((id) => protectedContributionIds.has(id))
      .sort();
    if (overlap.length > 0) return { extensionId: extension.id, contributionIds: overlap };
  }
  return undefined;
}

function contributionIds(contributes: Contributions | undefined): string[] {
  if (contributes === undefined) return [];
  const configurations = Array.isArray(contributes.configuration)
    ? contributes.configuration
    : contributes.configuration === undefined ? [] : [contributes.configuration];
  return [
    ...(contributes.commands ?? []).map((entry) => entry.command),
    ...(contributes.customEditors ?? []).map((entry) => entry.viewType),
    ...configurations.flatMap((entry) => Object.keys(entry.properties ?? {})),
  ].filter((value): value is string => typeof value === 'string');
}
