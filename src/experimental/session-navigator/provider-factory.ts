import { sourceIdFor } from './source-config';
import { FileSessionNavigatorProvider } from './generic-provider';
import { createNativeSessionNavigatorProvider } from './native-provider';
import type { AuthorizedSourceSetting, SessionNavigatorProvider } from './types';

/** Dispatches an authorized source to its generic or provider-native adapter. */
export function createSessionNavigatorProvider(setting: AuthorizedSourceSetting): SessionNavigatorProvider {
  const sourceId = sourceIdFor(setting);
  return setting.provider === 'generic'
    ? new FileSessionNavigatorProvider(setting, sourceId)
    : createNativeSessionNavigatorProvider(setting);
}
