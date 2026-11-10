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

/** Supporting folders keep their names; only a whole skill folder loses its own (#3247). */

const relFile = (relPath: string, bytes = 'x') => {
  const f = file(relPath.split('/').pop()!, bytes);
  Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
  return f;
};
const pickFolder = (container: HTMLElement, files: File[]) => {
  const picker = container.ownerDocument.querySelector('input[webkitdirectory]') as HTMLInputElement;
  Object.defineProperty(picker, 'files', { value: files, configurable: true });
  fireEvent.change(picker);
};
const pickFiles = (container: HTMLElement, files: File[]) => {
  const picker = container.ownerDocument.querySelector('input[type="file"]:not([webkitdirectory])') as HTMLInputElement;
  Object.defineProperty(picker, 'files', { value: files, configurable: true });
  fireEvent.change(picker);
};
type Tree = { [name: string]: string | Tree };
const entryOf = (name: string, node: string | Tree): FileSystemEntry => (typeof node === 'string'
  ? { name, isFile: true, isDirectory: false, file: (ok: (f: File) => void) => ok(file(name, node)) }
  : {
    name, isFile: false, isDirectory: true,
    createReader: () => { let done = false; return { readEntries: (ok: (e: FileSystemEntry[]) => void) => { ok(done ? [] : Object.entries(node).map(([n, c]) => entryOf(n, c))); done = true; } }; },
  }) as unknown as FileSystemEntry;
const drop = (tree: Tree) => fireEvent.drop(screen.getByTestId('managed-part-name').closest('div.flex-col')!, {
  dataTransfer: { items: Object.entries(tree).map(([n, c]) => ({ webkitGetAsEntry: () => entryOf(n, c) })) },
});
const listed = () => [...screen.getByTestId('managed-skill-files').querySelectorAll('span.font-mono')].map((s) => s.textContent);
const savedFiles = (spy: ReturnType<typeof vi.spyOn>) => (spy.mock.calls[0][0] as { content: { files: Array<{ path: string; content: string }> } }).content.files;

describe('supporting folders and whole skills (#3247)', () => {
  beforeEach(() => {
    vi.spyOn(m(), 'executableBits').mockResolvedValue({ ok: false, code: 'failed' } as never);
  });

  it('a picked supporting folder is stored under its own name and names nothing', async () => {
    const create = vi.spyOn(m(), 'createPart').mockResolvedValue({ ok: true, value: { id: 's1' } } as never);
    const { container } = render(<PartDialog open kind="skill" onClose={vi.fn()} />);
    pickFolder(container, [relFile('assets/note.md', '# Note')]);
    await waitFor(() => expect(listed()).toEqual(['assets/note.md']));
    expect(screen.getByTestId('managed-part-name')).toHaveValue('');
    expect(screen.getByTestId('managed-part-skill-name')).toHaveValue('');
    expect(screen.getByTestId('managed-part-save')).toBeDisabled();
    fireEvent.change(screen.getByTestId('managed-part-name'), { target: { value: 'Sample' } });
    fireEvent.change(screen.getByTestId('managed-part-skill-name'), { target: { value: 'sample-skill' } });
    fireEvent.click(screen.getByTestId('managed-part-save'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(savedFiles(create).map((f) => f.path)).toEqual(['SKILL.md', 'assets/note.md']);
  });

  it('a dropped supporting folder keeps its name too', async () => {
    render(<PartDialog open kind="skill" onClose={vi.fn()} />);
    drop({ assets: { 'note.md': '# Note', deep: { 'more.md': '# More' } } });
    await waitFor(() => expect(listed()).toEqual(['assets/note.md', 'assets/deep/more.md']));
    expect(screen.getByTestId('managed-part-skill-name')).toHaveValue('');
  });

  it('a picked whole skill folder loses only its outer name, which names the skill', async () => {
    const { container } = render(<PartDialog open kind="skill" onClose={vi.fn()} />);
    pickFolder(container, [relFile('sample-skill/SKILL.md', '# Sample'), relFile('sample-skill/assets/note.md')]);
    await waitFor(() => expect(listed()).toEqual(['assets/note.md']));
    expect(screen.getByTestId('managed-part-skill-md')).toHaveValue('# Sample');
    expect(screen.getByTestId('managed-part-skill-name')).toHaveValue('sample-skill');
    expect(screen.getByTestId('managed-part-name')).toHaveValue('sample-skill');
  });

  it('a mixed drop strips the skill folder and keeps the supporting folder and loose file as they are', async () => {
    render(<PartDialog open kind="skill" onClose={vi.fn()} />);
    drop({ 'sample-skill': { 'SKILL.md': '# Sample', 'run.sh': 'echo' }, assets: { 'note.md': '# Note' }, 'loose.md': 'x' });
    await waitFor(() => expect(listed()).toEqual(['run.sh', 'assets/note.md', 'loose.md']));
    expect(screen.getByTestId('managed-part-skill-md')).toHaveValue('# Sample');
    expect(screen.getByTestId('managed-part-skill-name')).toHaveValue('sample-skill');
  });

  it('shows a clash instead of overwriting the file already there', async () => {
    const create = vi.spyOn(m(), 'createPart').mockResolvedValue({ ok: true, value: { id: 's1' } } as never);
    const { container } = render(<PartDialog open kind="skill" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('managed-part-name'), { target: { value: 'Sample' } });
    fireEvent.change(screen.getByTestId('managed-part-skill-name'), { target: { value: 'sample-skill' } });
    pickFolder(container, [relFile('assets/note.md', 'first')]);
    await waitFor(() => expect(listed()).toEqual(['assets/note.md']));
    pickFolder(container, [relFile('assets/note.md', 'second'), relFile('assets/new.md')]);
    await waitFor(() => expect(listed()).toEqual(['assets/note.md', 'assets/new.md']));
    expect(screen.getByTestId('managed-skill-file-error').textContent).toMatch(/Not added\. assets\/note\.md: That path conflicts with assets\/note\.md/);
    fireEvent.click(screen.getByTestId('managed-part-save'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(savedFiles(create).find((f) => f.path === 'assets/note.md')!.content).toBe('first');
  });

  it('renames and moves a supporting file to a checked relative path when creating', async () => {
    const create = vi.spyOn(m(), 'createPart').mockResolvedValue({ ok: true, value: { id: 's1' } } as never);
    const { container } = render(<PartDialog open kind="skill" onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId('managed-part-name'), { target: { value: 'Sample' } });
    fireEvent.change(screen.getByTestId('managed-part-skill-name'), { target: { value: 'sample-skill' } });
    pickFiles(container, [file('note.md', '# Note'), file('run.sh', 'echo')]);
    await waitFor(() => expect(listed()).toEqual(['note.md', 'run.sh']));
    for (const bad of ['../note.md', '/abs/note.md', 'run.sh', 'SKILL.md']) {
      fireEvent.click(screen.getByRole('button', { name: 'Rename note.md' }));
      fireEvent.change(screen.getByLabelText('New path for note.md'), { target: { value: bad } });
      fireEvent.click(screen.getByRole('button', { name: 'Apply new path for note.md' }));
      expect(screen.getByTestId('managed-skill-file-error')).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel renaming note.md' }));
    }
    expect(listed()).toEqual(['note.md', 'run.sh']);
    fireEvent.click(screen.getByRole('button', { name: 'Rename note.md' }));
    fireEvent.change(screen.getByLabelText('New path for note.md'), { target: { value: 'assets/note.md' } });
    fireEvent.keyDown(screen.getByLabelText('New path for note.md'), { key: 'Enter' });
    expect(listed()).toEqual(['assets/note.md', 'run.sh']);
    expect(screen.queryByTestId('managed-skill-file-error')).toBeNull();
    fireEvent.click(screen.getByTestId('managed-part-save'));
    await waitFor(() => expect(create).toHaveBeenCalled());
    expect(savedFiles(create).map((f) => f.path)).toEqual(['SKILL.md', 'assets/note.md', 'run.sh']);
  });

  it('adds a supporting folder and renames a file when editing, and keeps the skill\'s names', async () => {
    vi.spyOn(m(), 'getPart').mockResolvedValue({ ok: true, value: {
      id: 'p1', name: 'Sample', description: '', revision: 3, usedBy: [], templates: [],
      content: { kind: 'skill', skillName: 'sample-skill', files: [{ path: 'SKILL.md', content: '# Sample' }, { path: 'old.md', content: 'o' }] },
    } } as never);
    const update = vi.spyOn(m(), 'updatePart').mockResolvedValue({ ok: true, value: { usedBy: [] } } as never);
    const { container } = render(<PartDialog open kind="skill" editId="p1" onClose={vi.fn()} />);
    await waitFor(() => expect(listed()).toEqual(['old.md']));
    pickFolder(container, [relFile('assets/note.md', '# Note')]);
    await waitFor(() => expect(listed()).toEqual(['old.md', 'assets/note.md']));
    drop({ refs: { 'guide.md': 'g' } });
    await waitFor(() => expect(listed()).toEqual(['old.md', 'assets/note.md', 'refs/guide.md']));
    fireEvent.click(screen.getByRole('button', { name: 'Rename old.md' }));
    fireEvent.change(screen.getByLabelText('New path for old.md'), { target: { value: 'refs/old.md' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply new path for old.md' }));
    expect(screen.getByTestId('managed-part-name')).toHaveValue('Sample');
    expect(screen.getByTestId('managed-part-skill-name')).toHaveValue('sample-skill');
    fireEvent.click(screen.getByTestId('managed-part-save'));
    await waitFor(() => expect(update).toHaveBeenCalled());
    const content = (update.mock.calls[0][0] as { content: { skillName: string; files: Array<{ path: string }> } }).content;
    expect(content.skillName).toBe('sample-skill');
    expect(content.files.map((f) => f.path)).toEqual(['SKILL.md', 'refs/old.md', 'assets/note.md', 'refs/guide.md']);
  });
});
