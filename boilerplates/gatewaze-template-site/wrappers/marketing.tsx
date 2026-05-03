/* @gatewaze:wrapper name="marketing" role="page" */

import type { ReactNode } from 'react';

interface MarketingWrapperProps {
  children: ReactNode;
}

/**
 * Marketing page wrapper: full-bleed layout for landing pages, no sidebar.
 * Useful when blocks-mode pages want to break out of the standard content
 * width.
 */
export function MarketingWrapper({ children }: MarketingWrapperProps) {
  return <div className="-mx-4 sm:-mx-6 lg:-mx-8">{children}</div>;
}
