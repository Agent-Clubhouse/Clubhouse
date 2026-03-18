import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PoppedOutPlaceholder } from './PoppedOutPlaceholder';

describe('PoppedOutPlaceholder', () => {
  beforeEach(() => {
    window.clubhouse.window.focusPopout = vi.fn().mockResolvedValue(undefined);
    window.clubhouse.window.closePopout = vi.fn().mockResolvedValue(undefined);
  });

  it('renders with agent type and name', () => {
    render(<PoppedOutPlaceholder type="agent" name="My Agent" windowId={42} />);
    expect(screen.getByText('My Agent is open in a separate window')).toBeInTheDocument();
    expect(screen.getByTestId('popped-out-placeholder')).toBeInTheDocument();
  });

  it('renders with hub type and no name (fallback)', () => {
    render(<PoppedOutPlaceholder type="hub" windowId={7} />);
    expect(screen.getByText('Hub is open in a separate window')).toBeInTheDocument();
  });

  it('renders with canvas type and name', () => {
    render(<PoppedOutPlaceholder type="canvas" name="Design Canvas" windowId={10} />);
    expect(screen.getByText('Design Canvas is open in a separate window')).toBeInTheDocument();
  });

  it('shows the duplicate rendering explanation', () => {
    render(<PoppedOutPlaceholder type="agent" windowId={1} />);
    expect(
      screen.getByText('This view has been popped out to avoid duplicate rendering.'),
    ).toBeInTheDocument();
  });

  it('"Go to Window" button calls focusPopout with correct windowId', () => {
    render(<PoppedOutPlaceholder type="agent" name="Test" windowId={42} />);
    fireEvent.click(screen.getByTestId('popped-out-go-to-window'));
    expect(window.clubhouse.window.focusPopout).toHaveBeenCalledWith(42);
  });

  it('"Close Window" button calls closePopout with correct windowId', () => {
    render(<PoppedOutPlaceholder type="hub" windowId={99} />);
    fireEvent.click(screen.getByTestId('popped-out-close-window'));
    expect(window.clubhouse.window.closePopout).toHaveBeenCalledWith(99);
  });

  it('renders Go to Window and Close Window buttons', () => {
    render(<PoppedOutPlaceholder type="canvas" windowId={5} />);
    expect(screen.getByText('Go to Window')).toBeInTheDocument();
    expect(screen.getByText('Close Window')).toBeInTheDocument();
  });
});
