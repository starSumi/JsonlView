import { sourceIdFor } from './source-config';
import { FileSessionNavigatorProvider } from './generic-provider';
import { createNativeSessionNavigatorProvider } from './native-provider';
import { KimiSessionNavigatorProvider } from './kimi-provider';
import { isGenericFileProvider, type AuthorizedSourceSetting, type SessionNavigatorProvider } from './types';

/** Dispatches an authorized source to its generic or provider-native adapter. */
export function createSessionNavigatorProvider(setting: AuthorizedSourceSetting): SessionNavigatorProvider {
  const sourceId = sourceIdFor(setting);
  if (setting.provider === 'kimi') return new KimiSessionNavigatorProvider(setting);
  return isGenericFileProvider(setting.provider)
    ? new FileSessionNavigatorProvider(setting, sourceId)
    : createNativeSessionNavigatorProvider(setting);
}
