/**
 * ZoneThemeProvider — wraps a canvas view with zone-specific CSS variable overrides.
 * Uses display:contents to avoid layout impact while allowing CSS custom property inheritance.
 */

import React, { useMemo } from 'react';
import { getTheme } from '../../../themes';
import { themeToStyleVars } from '../../../themes/apply-theme';

interface ZoneThemeProviderProps {
  themeId: string | undefined;
  children: React.ReactNode;
}

export function ZoneThemeProvider({ themeId, children }: ZoneThemeProviderProps) {
  const styleVars = useMemo(() => {
    if (!themeId) return undefined;
    const theme = getTheme(themeId);
    if (!theme) return undefined;
    return themeToStyleVars(theme);
  }, [themeId]);

  if (!styleVars) return <>{children}</>;

  return (
    <div style={styleVars as React.CSSProperties} className="contents">
      {children}
    </div>
  );
}
