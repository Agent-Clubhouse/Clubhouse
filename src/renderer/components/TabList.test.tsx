import { useId, useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TabList, tabPanelProps } from './TabList';

const OPTIONS = [
  { id: 'one', label: 'One' },
  { id: 'two', label: 'Two' },
  { id: 'three', label: 'Three' },
] as const;
type Id = typeof OPTIONS[number]['id'];

function Tabs() {
  const [value, setValue] = useState<Id>('one');
  const id = useId();
  return (
    <>
      <TabList<Id> label="Sections" idPrefix={id} value={value} options={OPTIONS} onChange={setValue} tabClassName={() => ''} />
      <div {...tabPanelProps(id, value)}>Panel {value}</div>
    </>
  );
}

describe('TabList', () => {
  it('uses the tabs roles, with the panel labelled by the selected tab and controlled by every tab', () => {
    render(<Tabs />);
    expect(screen.getByRole('tablist', { name: 'Sections' })).toBeTruthy();
    const panel = screen.getByRole('tabpanel');
    expect(panel).toHaveAccessibleName('One');
    for (const tab of screen.getAllByRole('tab')) expect(tab.getAttribute('aria-controls')).toBe(panel.id);
  });

  it('keeps only the selected tab in the Tab order', () => {
    render(<Tabs />);
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    fireEvent.click(screen.getByRole('tab', { name: 'Two' }));
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(screen.getByRole('tab', { name: 'Two' }).getAttribute('aria-selected')).toBe('true');
  });

  it('moves and selects with Left, Right, Home and End, wrapping at the ends', () => {
    render(<Tabs />);
    const tab = (name: string) => screen.getByRole('tab', { name });
    tab('One').focus();
    fireEvent.keyDown(tab('One'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('Two'));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('Panel two');
    fireEvent.keyDown(tab('Two'), { key: 'End' });
    expect(document.activeElement).toBe(tab('Three'));
    fireEvent.keyDown(tab('Three'), { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tab('One'));
    fireEvent.keyDown(tab('One'), { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(tab('Three'));
    fireEvent.keyDown(tab('Three'), { key: 'Home' });
    expect(document.activeElement).toBe(tab('One'));
    expect(screen.getByRole('tabpanel')).toHaveAccessibleName('One');
  });
});
