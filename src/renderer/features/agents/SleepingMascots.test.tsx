import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { SleepingMascot, ClaudeMascot, CodexMascot, CopilotMascot, GenericMascot } from './SleepingMascots';

const HEX = /#[0-9a-fA-F]{3,8}\b/;

describe('SleepingMascot', () => {
  it.each([
    ['claude-code', 'claude-code'],
    ['codex-cli', 'codex-cli'],
    ['copilot-cli', 'copilot-cli'],
    ['some-unknown', 'generic'],
    [undefined, 'generic'],
  ])('picks the %s mascot', (orchestrator, expected) => {
    const { container } = render(<SleepingMascot orchestrator={orchestrator} />);
    expect(container.querySelector('svg')?.getAttribute('data-mascot')).toBe(expected);
  });

  it('draws at the requested size', () => {
    const { container } = render(<SleepingMascot orchestrator="claude-code" size={48} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('48');
    expect(svg.getAttribute('height')).toBe('48');
  });

  it('dims on a failed launch', () => {
    const { getByTestId } = render(<SleepingMascot orchestrator="codex-cli" error />);
    expect(getByTestId('agent-mascot').className).toContain('opacity-50');
  });
});

describe.each([
  ['Claude', ClaudeMascot],
  ['Codex', CodexMascot],
  ['Copilot', CopilotMascot],
  ['generic', GenericMascot],
])('%s mascot', (_name, Mascot) => {
  it('uses theme and brand tokens only, no hex colors', () => {
    const { container } = render(<Mascot size={88} />);
    expect(container.innerHTML).not.toMatch(HEX);
    for (const el of container.querySelectorAll('[fill]')) {
      expect(el.getAttribute('fill')).toBe('none');
    }
  });

  it('shows z\'s asleep, and none awake or on error', () => {
    const asleep = render(<Mascot size={88} />).container;
    const hasZ = (c: HTMLElement) => c.querySelectorAll('text').length > 0 || c.querySelectorAll('.fill-ctp-overlay0 rect').length >= 5;
    expect(hasZ(asleep)).toBe(true);
    expect(hasZ(render(<Mascot size={88} awake />).container)).toBe(false);
    expect(hasZ(render(<Mascot size={88} error />).container)).toBe(false);
  });
});

describe('brand tints', () => {
  it('Claude draws in the claude token, Copilot goggles in the copilot token, Codex in the codex token', () => {
    expect(render(<ClaudeMascot />).container.querySelector('.fill-brand-claude')).not.toBeNull();
    expect(render(<CopilotMascot />).container.querySelector('.fill-brand-copilot')).not.toBeNull();
    expect(render(<CodexMascot />).container.querySelector('.fill-brand-codex')).not.toBeNull();
  });

  it('Codex drops its seams below 40px', () => {
    expect(render(<CodexMascot size={88} />).container.querySelector('path.stroke-ctp-base[opacity]')).not.toBeNull();
    expect(render(<CodexMascot size={32} />).container.querySelector('path.stroke-ctp-base[opacity]')).toBeNull();
  });
});
