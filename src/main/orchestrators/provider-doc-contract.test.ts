import { readFileSync } from 'fs';
import { describe, expect, it } from 'vitest';
import { ClaudeCodeProvider } from './claude-code-provider';
import { CodexCliProvider } from './codex-cli-provider';
import { CopilotCliProvider } from './copilot-cli-provider';

function parseCapabilityMatrix(markdown: string): Record<string, Record<string, string>> {
  const lines = markdown.split(/\r?\n/);
  const header = lines.find((line) => line.startsWith('| Capability |'));
  if (!header) throw new Error('Capability matrix header not found');

  const [, ...providerNames] = header
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim())
    .filter(Boolean);
  const providers = providerNames;

  const matrix: Record<string, Record<string, string>> = {};

  for (const line of lines) {
    if (!line.startsWith('|')) continue;

    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());

    if (cells.length !== providers.length + 1) continue;
    const [capability, ...values] = cells;
    if (capability === 'Capability' || capability === '---') continue;

    matrix[capability] = Object.fromEntries(
      providers.map((provider, index) => [provider, values[index] ?? '']),
    );
  }

  return matrix;
}

describe('settings-orchestrators.md capability matrix', () => {
  it('matches each provider getCapabilities() output', () => {
    const markdown = readFileSync(
      new URL('../../renderer/features/help/content/settings-orchestrators.md', import.meta.url),
      'utf8',
    );

    const matrix = parseCapabilityMatrix(markdown);
    const providers = {
      'Claude Code': new ClaudeCodeProvider(),
      'Copilot CLI': new CopilotCliProvider(),
      'Codex CLI': new CodexCliProvider(),
    };

    const expectedRows = [
      {
        label: 'Headless mode',
        getValue: (provider: { getCapabilities: () => { headless: boolean } }) => provider.getCapabilities().headless,
      },
      {
        label: 'Structured output',
        getValue: (provider: { getCapabilities: () => { structuredOutput: boolean } }) => provider.getCapabilities().structuredOutput,
      },
      {
        label: 'Hooks',
        getValue: (provider: { getCapabilities: () => { hooks: boolean } }) => provider.getCapabilities().hooks,
      },
      {
        label: 'Session resume',
        getValue: (provider: { getCapabilities: () => { sessionResume: boolean } }) => provider.getCapabilities().sessionResume,
      },
      {
        label: 'Permissions',
        getValue: (provider: { getCapabilities: () => { permissions: boolean } }) => provider.getCapabilities().permissions,
      },
    ];

    for (const row of expectedRows) {
      for (const [providerName, provider] of Object.entries(providers)) {
        const cell = matrix[row.label]?.[providerName];
        expect(cell, `${row.label} is missing for ${providerName}`).toBeDefined();

        const actual = row.getValue(provider);
        const normalizedCell = cell.toLowerCase();

        if (actual) {
          expect(normalizedCell).toContain('yes');
        } else {
          expect(normalizedCell).toContain('no');
        }
      }
    }

    const codexSessionCell = matrix['Session resume']?.['Codex CLI'] ?? '';
    expect(codexSessionCell.toLowerCase()).toContain('yes');
    expect(codexSessionCell.toLowerCase()).toMatch(/most recent|--last|--continue/);
    expect(codexSessionCell.toLowerCase()).toMatch(/resume-by-id|resume by id|no resume/i);
  });
});
