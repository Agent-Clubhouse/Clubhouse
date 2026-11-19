import { MobileControlError } from './mobile-control';

const SUPPORTED_PLATFORMS = ['darwin', 'linux'] as const;

/** Advisory capability for this lane only. Every action rechecks the host. */
export function managedProviderPlatformCapability(platform: string = process.platform) {
  return { current: platform, supported: (SUPPORTED_PLATFORMS as readonly string[]).includes(platform),
    supportedPlatforms: [...SUPPORTED_PLATFORMS], refusalCode: 'managed_platform_unsupported' as const };
}

/** No Windows ACL/metadata equivalence is claimed by the POSIX transaction. */
export function assertManagedProviderPlatform(): void {
  const support = managedProviderPlatformCapability();
  if (!support.supported) throw new MobileControlError(support.refusalCode, 409, 'rejected',
    'Managed provider changes and marked starts are unsupported on this host platform.', { managedPlatform: support });
}
