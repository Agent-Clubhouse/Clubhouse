import { render } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useUIStore } from '../stores/uiStore';
import { AccessoryPanel } from './AccessoryPanel';

function resetStores() {
  useUIStore.setState({
    explorerTab: 'settings',
    settingsContext: 'app',
    settingsSubPage: 'about',
  });
}

describe('SettingsCategoryNav (via AccessoryPanel)', () => {
  beforeEach(resetStores);

  it('settings category nav is scrollable when content overflows', () => {
    const { container } = render(<AccessoryPanel />);
    const nav = container.querySelector('nav');
    expect(nav).toBeInTheDocument();
    expect(nav!.className).toContain('overflow-y-auto');
    expect(nav!.className).toContain('min-h-0');
  });
});
