import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  SleepingMascot,
  ClaudeCodeSleeping,
  CopilotSleeping,
  CodexCliSleeping,
  GenericRobotSleeping,
} from './SleepingMascots';

describe('SleepingMascots', () => {
  describe('SleepingMascot selector', () => {
    it('renders ClaudeCodeSleeping for claude-code orchestrator', () => {
      const { container } = render(<SleepingMascot orchestrator="claude-code" />);
      // Claude mascot uses its distinctive salmon/pink body color
      const body = container.querySelector('rect[fill="#d4896b"]');
      expect(body).not.toBeNull();
    });

    it('renders CopilotSleeping for copilot-cli orchestrator', () => {
      const { container } = render(<SleepingMascot orchestrator="copilot-cli" />);
      // Copilot mascot uses distinctive blue goggle frame color
      const goggle = container.querySelector('rect[fill="#5AB8E8"]');
      expect(goggle).not.toBeNull();
    });

    it('renders CodexCliSleeping for codex-cli orchestrator', () => {
      const { container } = render(<SleepingMascot orchestrator="codex-cli" />);
      // Codex mascot uses the white/light body color in its head
      const head = container.querySelector('ellipse[fill="#E8E8EC"]');
      expect(head).not.toBeNull();
    });

    it('renders GenericRobotSleeping for opencode orchestrator', () => {
      const { container } = render(<SleepingMascot orchestrator="opencode" />);
      // Generic robot uses grey body color
      const body = container.querySelector('rect[fill="#5a5a6e"]');
      expect(body).not.toBeNull();
    });

    it('renders GenericRobotSleeping for unknown orchestrator', () => {
      const { container } = render(<SleepingMascot orchestrator="some-unknown" />);
      const body = container.querySelector('rect[fill="#5a5a6e"]');
      expect(body).not.toBeNull();
    });

    it('renders GenericRobotSleeping when orchestrator is undefined', () => {
      const { container } = render(<SleepingMascot orchestrator={undefined} />);
      const body = container.querySelector('rect[fill="#5a5a6e"]');
      expect(body).not.toBeNull();
    });
  });

  describe('ClaudeCodeSleeping', () => {
    it('renders an SVG with 200x200 dimensions', () => {
      const { container } = render(<ClaudeCodeSleeping />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('width')).toBe('200');
      expect(svg!.getAttribute('height')).toBe('200');
    });

    it('contains animated Zzz text elements', () => {
      const { container } = render(<ClaudeCodeSleeping />);
      const zTexts = container.querySelectorAll('text tspan');
      expect(zTexts.length).toBe(3);
      zTexts.forEach((z) => {
        expect(z.textContent).toBe('z');
        expect(z.classList.contains('animate-pulse')).toBe(true);
      });
    });

    it('has 4 legs', () => {
      const { container } = render(<ClaudeCodeSleeping />);
      const legs = container.querySelectorAll('rect[fill="#be7a5e"]');
      expect(legs.length).toBe(4);
    });

    it('has 2 arms', () => {
      const { container } = render(<ClaudeCodeSleeping />);
      // Arms are body-colored stubs at x=10 and x=80
      const leftArm = container.querySelector('rect[x="10"]');
      const rightArm = container.querySelector('rect[x="80"]');
      expect(leftArm).not.toBeNull();
      expect(rightArm).not.toBeNull();
    });

    it('does not contain nightcap elements', () => {
      const { container } = render(<ClaudeCodeSleeping />);
      // Old nightcap used indigo/violet fills
      const nightcapPath = container.querySelector('path[fill="#6366f1"]');
      const nightcapBall = container.querySelector('circle[fill="#a5b4fc"]');
      expect(nightcapPath).toBeNull();
      expect(nightcapBall).toBeNull();
    });
  });

  describe('CopilotSleeping', () => {
    it('renders an SVG with 200x200 dimensions', () => {
      const { container } = render(<CopilotSleeping />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('width')).toBe('200');
      expect(svg!.getAttribute('height')).toBe('200');
    });

    it('contains goggle frames on forehead', () => {
      const { container } = render(<CopilotSleeping />);
      const goggles = container.querySelectorAll('rect[fill="#5AB8E8"]');
      // 2 goggle frames + bridge = 3
      expect(goggles.length).toBeGreaterThanOrEqual(2);
    });

    it('contains ear covers', () => {
      const { container } = render(<CopilotSleeping />);
      const leftCover = container.querySelector('rect[x="6"]');
      const rightCover = container.querySelector('rect[x="82"]');
      expect(leftCover).not.toBeNull();
      expect(rightCover).not.toBeNull();
    });

    it('contains open face visor with eyes', () => {
      const { container } = render(<CopilotSleeping />);
      // Visor panel
      const visor = container.querySelector('rect[fill="url(#copilotVisorGrad)"]');
      expect(visor).not.toBeNull();
      // Closed eyes — dark slits
      const eyes = container.querySelectorAll('line[stroke="#0a1830"]');
      expect(eyes.length).toBe(2);
    });

    it('contains animated Zzz text elements', () => {
      const { container } = render(<CopilotSleeping />);
      const zTexts = container.querySelectorAll('text tspan');
      expect(zTexts.length).toBe(3);
    });
  });

  describe('CodexCliSleeping', () => {
    it('renders an SVG with 200x200 dimensions', () => {
      const { container } = render(<CodexCliSleeping />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('width')).toBe('200');
      expect(svg!.getAttribute('height')).toBe('200');
    });

    it('has a smooth oval head and dark visor', () => {
      const { container } = render(<CodexCliSleeping />);
      const head = container.querySelector('ellipse[fill="#E8E8EC"]');
      const visor = container.querySelector('ellipse[fill="#0a0a14"]');
      expect(head).not.toBeNull();
      expect(visor).not.toBeNull();
    });

    it('has leaf-shaped arms', () => {
      const { container } = render(<CodexCliSleeping />);
      const arms = container.querySelectorAll('ellipse[fill="#D0D0D8"]');
      expect(arms.length).toBe(2);
    });

    it('has a tapered body', () => {
      const { container } = render(<CodexCliSleeping />);
      const body = container.querySelector('path[fill="#E0E0E8"]');
      expect(body).not.toBeNull();
    });

    it('has a Codex indigo accent', () => {
      const { container } = render(<CodexCliSleeping />);
      const accent = container.querySelector('rect[fill="#6B6BDE"]');
      expect(accent).not.toBeNull();
    });

    it('contains animated Zzz text elements', () => {
      const { container } = render(<CodexCliSleeping />);
      const zTexts = container.querySelectorAll('text tspan');
      expect(zTexts.length).toBe(3);
    });
  });

  describe('GenericRobotSleeping', () => {
    it('renders an SVG with 200x200 dimensions', () => {
      const { container } = render(<GenericRobotSleeping />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('width')).toBe('200');
      expect(svg!.getAttribute('height')).toBe('200');
    });

    it('contains the antenna', () => {
      const { container } = render(<GenericRobotSleeping />);
      // Antenna line
      const line = container.querySelector('line[x1="50"][y1="14"]');
      expect(line).not.toBeNull();
    });

    it('contains animated Zzz text elements', () => {
      const { container } = render(<GenericRobotSleeping />);
      const zTexts = container.querySelectorAll('text tspan');
      expect(zTexts.length).toBe(3);
    });
  });
});
