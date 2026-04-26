import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { MermaidDiagram } from './MermaidDiagram';

const mermaidInitialize = vi.fn();
const mermaidParse = vi.fn();
const mermaidRender = vi.fn();

vi.mock('mermaid', () => ({
  default: {
    initialize: (cfg: unknown) => mermaidInitialize(cfg),
    parse: (text: string) => mermaidParse(text),
    render: (id: string, text: string) => mermaidRender(id, text),
  },
}));

beforeEach(() => {
  mermaidInitialize.mockReset();
  mermaidParse.mockReset();
  mermaidRender.mockReset();
});

describe('MermaidDiagram', () => {
  it('renders the SVG returned by mermaid', async () => {
    mermaidParse.mockResolvedValue({});
    mermaidRender.mockResolvedValue({ svg: '<svg data-testid="rendered-svg"><g/></svg>' });

    render(<MermaidDiagram code="graph TD; A-->B" />);

    const container = await screen.findByTestId('mermaid-diagram');
    await waitFor(() => {
      expect(container.querySelector('svg')).not.toBeNull();
    });
    expect(container.innerHTML).toContain('rendered-svg');
  });

  it('shows a loading indicator before the diagram resolves', () => {
    let resolveRender: (v: { svg: string }) => void = () => {};
    mermaidParse.mockResolvedValue({});
    mermaidRender.mockReturnValue(new Promise((resolve) => { resolveRender = resolve; }));

    render(<MermaidDiagram code="graph TD; A-->B" />);

    expect(screen.getByText(/Rendering diagram/i)).toBeInTheDocument();
    resolveRender({ svg: '<svg/>' });
  });

  it('falls back to the raw code with an error message when parse fails', async () => {
    mermaidParse.mockRejectedValue(new Error('Parse error on line 1'));

    render(<MermaidDiagram code="not valid mermaid" />);

    await screen.findByText(/Mermaid diagram error/i);
    expect(screen.getByText(/Parse error on line 1/)).toBeInTheDocument();
    // Raw code is preserved so the user can see what failed
    expect(screen.getByText(/not valid mermaid/)).toBeInTheDocument();
  });

  it('falls back when render itself throws', async () => {
    mermaidParse.mockResolvedValue({});
    mermaidRender.mockRejectedValue(new Error('Internal render failure'));

    render(<MermaidDiagram code="graph TD; A-->B" />);

    await screen.findByText(/Mermaid diagram error/i);
    expect(screen.getByText(/Internal render failure/)).toBeInTheDocument();
    expect(screen.getByText(/graph TD; A-->B/)).toBeInTheDocument();
  });

  it('passes theme variables derived from CSS custom properties', async () => {
    document.documentElement.style.setProperty('--ctp-base', '30 30 46');
    document.documentElement.style.setProperty('--ctp-text', '205 214 244');

    mermaidParse.mockResolvedValue({});
    mermaidRender.mockResolvedValue({ svg: '<svg/>' });

    render(<MermaidDiagram code="graph TD; A-->B" />);

    await waitFor(() => expect(mermaidInitialize).toHaveBeenCalled());
    const config = mermaidInitialize.mock.calls[0][0] as {
      themeVariables: Record<string, string>;
      theme: string;
      securityLevel: string;
    };
    expect(config.theme).toBe('base');
    expect(config.securityLevel).toBe('strict');
    expect(config.themeVariables.background).toBe('rgb(30, 30, 46)');
    expect(config.themeVariables.textColor).toBe('rgb(205, 214, 244)');
  });

  it('re-renders when the code changes', async () => {
    mermaidParse.mockResolvedValue({});
    mermaidRender.mockResolvedValue({ svg: '<svg/>' });

    const { rerender } = render(<MermaidDiagram code="graph TD; A-->B" />);
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(1));

    rerender(<MermaidDiagram code="graph TD; B-->C" />);
    await waitFor(() => expect(mermaidRender).toHaveBeenCalledTimes(2));
    expect(mermaidRender.mock.calls[1][1]).toBe('graph TD; B-->C');
  });
});
