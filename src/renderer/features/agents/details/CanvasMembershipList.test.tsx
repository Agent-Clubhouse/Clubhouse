import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { CanvasMembershipList } from './CanvasMembershipList';
import type { CanvasHit } from './agent-canvases';

const home: CanvasHit = { scope: 'app', canvasId: 'private-board-id', viewId: 'private-view-id', name: 'Same board name' };
const project: CanvasHit = { ...home, scope: 'project' };

it('distinguishes Home and Project memberships with identical names and preserves the exact selected hit', () => {
  const jump = vi.fn();
  render(<CanvasMembershipList hits={[home, project]} onJump={jump} />);
  const memberships = screen.getByRole('list', { name: 'Canvas memberships' });
  const homeRow = within(memberships).getByRole('button', { name: 'Same board name Home Jump' });
  const projectRow = within(memberships).getByRole('button', { name: 'Same board name Project Jump' });
  fireEvent.click(projectRow); expect(jump).toHaveBeenCalledWith(project);
  fireEvent.click(homeRow); expect(jump).toHaveBeenLastCalledWith(home);
  expect(memberships.innerHTML).not.toMatch(/private-board-id|private-view-id/);
});

it('links disabled navigation to its visible reason without running a fallback action', () => {
  const jump = vi.fn(), reason = 'The host omitted canvas data from its current snapshot. Open it on the host.';
  const { rerender } = render(<CanvasMembershipList hits={[project]} onJump={jump} unavailable={() => reason} />);
  const button = screen.getByRole('button', { name: 'Same board name Project Unavailable' });
  expect(button).toBeDisabled(); expect(button).toHaveAccessibleDescription(reason); expect(button).toHaveAttribute('title', reason);
  fireEvent.click(button); expect(jump).not.toHaveBeenCalled();
  rerender(<CanvasMembershipList hits={[project]} onJump={jump} unavailable={() => null} />);
  const enabled = screen.getByRole('button', { name: 'Same board name Project Jump' });
  expect(enabled).toBeEnabled(); expect(enabled).not.toHaveAttribute('aria-describedby');
  fireEvent.click(enabled); expect(jump).toHaveBeenCalledExactlyOnceWith(project);
});

it('keeps unavailable descriptions distinct across scopes and multiple lists', () => {
  const jump = vi.fn();
  render(<><CanvasMembershipList hits={[home, project]} onJump={jump} unavailable={(hit) => `${hit.scope} board unavailable`} /><CanvasMembershipList hits={[home]} onJump={jump} unavailable={() => 'Other host unavailable'} /></>);
  const rows = screen.getAllByRole('button');
  expect(rows[0]).toHaveAccessibleDescription('app board unavailable');
  expect(rows[1]).toHaveAccessibleDescription('project board unavailable');
  expect(rows[2]).toHaveAccessibleDescription('Other host unavailable');
  expect(new Set(rows.map((row) => row.getAttribute('aria-describedby'))).size).toBe(3);
  for (const row of rows) fireEvent.click(row);
  expect(jump).not.toHaveBeenCalled();
});

it('renders an optional secondary action per row and is unchanged without it', () => {
  const jump = vi.fn();
  const plain = render(<CanvasMembershipList hits={[home, project]} onJump={jump} unavailable={() => 'Omitted'} />);
  // Without the prop each row is exactly its button and reason, as before.
  expect([...plain.container.querySelectorAll('li')].map((li) => [...li.children].map((c) => c.tagName))).toEqual([['BUTTON', 'P'], ['BUTTON', 'P']]);
  plain.unmount();
  render(<CanvasMembershipList hits={[home, project]} onJump={jump} unavailable={() => 'Omitted'} secondary={(hit, index) => <span data-testid="secondary">{`${hit.scope}:${index}`}</span>} />);
  expect(screen.getAllByTestId('secondary').map((n) => n.textContent)).toEqual(['app:0', 'project:1']);
});
