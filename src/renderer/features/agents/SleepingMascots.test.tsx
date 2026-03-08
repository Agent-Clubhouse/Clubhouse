import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import {
  SleepingMascot,
  ClaudeCodeSleeping,
  CopilotSleeping,
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
      const goggle = container.querySelector('rect[fill="#5AB0E0"]');
      expect(goggle).not.toBeNull();
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
  });

  describe('CopilotSleeping', () => {
    it('renders an SVG with 200x200 dimensions', () => {
      const { container } = render(<CopilotSleeping />);
      const svg = container.querySelector('svg');
      expect(svg).not.toBeNull();
      expect(svg!.getAttribute('width')).toBe('200');
      expect(svg!.getAttribute('height')).toBe('200');
    });

    it('contains goggle frames in Copilot blue', () => {
      const { container } = render(<CopilotSleeping />);
      const goggles = container.querySelectorAll('rect[fill="#5AB0E0"]');
      // 2 goggle frames + bridge + 2 sleeping eyelids = 5
      expect(goggles.length).toBeGreaterThanOrEqual(2);
    });

    it('contains ear bumps', () => {
      const { container } = render(<CopilotSleeping />);
      const leftEar = container.querySelector('ellipse[cx="12"]');
      const rightEar = container.querySelector('ellipse[cx="88"]');
      expect(leftEar).not.toBeNull();
      expect(rightEar).not.toBeNull();
    });

    it('contains face plate with ventilation slits', () => {
      const { container } = render(<CopilotSleeping />);
      const faceplate = container.querySelector('rect[fill="#0e1838"]');
      expect(faceplate).not.toBeNull();
      // 3 ventilation slits
      const vents = container.querySelectorAll('rect[fill="#1a2a5a"]');
      expect(vents.length).toBe(3);
    });

    it('contains animated Zzz text elements', () => {
      const { container } = render(<CopilotSleeping />);
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
