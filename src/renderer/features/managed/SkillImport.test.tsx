import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PartDialog, readFileAsSkillFile } from './PartDialog';

/** Skill import keeps each file's real executable bit, read by main from its mode (#2894, D96). */

const m = () => window.clubhouse.managed;
const file = (name: string, bytes: string | Uint8Array) => new File([bytes], name);

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('readFileAsSkillFile', () => {
  it('uses the real bit over the name: a script without it stays plain, a binary with it is executable', async () => {
    expect(await readFileAsSkillFile(file('run.sh', 'echo'), 'run.sh', false)).toEqual({ path: 'run.sh', content: 'echo' });
    expect(await readFileAsSkillFile(file('tool', new Uint8Array([0x7f, 0x45, 0, 1])), 'bin/tool', true))
      .toEqual({ path: 'bin/tool', content: btoa(String.fromCharCode(0x7f, 0x45, 0, 1)), encoding: 'base64', executable: true });
    expect(await readFileAsSkillFile(file('notes.md', '# hi'), 'notes.md', true)).toMatchObject({ executable: true });
  });

  it('guesses from the name only when the bit can\'t be read', async () => {
    expect(await readFileAsSkillFile(file('run.sh', 'echo'), 'run.sh', null)).toMatchObject({ executable: true });
    expect(await readFileAsSkillFile(file('notes.md', '# hi'), 'notes.md', null)).not.toHaveProperty('executable');
  });
});

describe('adding files to a new skill', () => {
  it('asks main for the bits of the picked files and saves them with the skill', async () => {
    const bits = vi.spyOn(m(), 'executableBits').mockResolvedValue({ ok: true, value: [false, true] } as never);
    const create = vi.spyOn(m(), 'createPart').mockResolvedValue({ ok: true, value: { id: 's1' } } as never);
    const { container } = render(<PartDialog open kind="skill" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('managed-part-name'), { target: { value: 'Release' } });
    fireEvent.change(screen.getByTestId('managed-part-skill-name'), { target: { value: 'release' } });
    const picker = container.ownerDocument.querySelector('input[type="file"]:not([webkitdirectory])') as HTMLInputElement;
    const picked = [file('run.sh', 'echo'), file('tool', new Uint8Array([1, 0, 2]))];
    Object.defineProperty(picker, 'files', { value: picked, configurable: true });
    fireEvent.change(picker);
    await waitFor(() => expect(screen.getByTestId('managed-skill-files').textContent).toContain('tool'));
    expect(bits).toHaveBeenCalledWith(picked);
    expect((screen.getByRole('checkbox', { name: 'Executable: run.sh' }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole('checkbox', { name: 'Executable: tool' }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId('managed-part-save'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    const content = create.mock.calls[0][0].content as { files: Array<{ path: string; executable?: boolean }> };
    expect(content.files.find((f) => f.path === 'run.sh')).not.toHaveProperty('executable');
    expect(content.files.find((f) => f.path === 'tool')).toMatchObject({ executable: true, encoding: 'base64' });
  });

  it('falls back to the name guess when main can\'t answer', async () => {
    vi.spyOn(m(), 'executableBits').mockResolvedValue({ ok: false, code: 'failed' } as never);
    const { container } = render(<PartDialog open kind="skill" onClose={vi.fn()} />);
    const picker = container.ownerDocument.querySelector('input[type="file"]:not([webkitdirectory])') as HTMLInputElement;
    Object.defineProperty(picker, 'files', { value: [file('run.sh', 'echo')], configurable: true });
    fireEvent.change(picker);
    await waitFor(() => expect((screen.getByRole('checkbox', { name: 'Executable: run.sh' }) as HTMLInputElement).checked).toBe(true));
  });
});
