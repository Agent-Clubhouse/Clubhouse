import { useState } from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { SkillAssetPayload } from '../../../shared/asset-catalog-types';
import { SkillBundleEditor } from './SkillBundleEditor';

vi.mock('../../components/SettingsMonacoEditor', () => ({ SettingsMonacoEditor: ({ value, onChange, readOnly }: { value: string; onChange: (value: string) => void; readOnly: boolean }) =>
  <textarea aria-label="Text content" value={value} readOnly={readOnly} onChange={(event) => onChange(event.target.value)} /> }));
const bundle: SkillAssetPayload = { skillName: 'bundle', files: [
  { path: 'SKILL.md', content: '# Bundle\n[Guide](references/guide.md)' },
  { path: 'scripts/check.sh', content: 'exit 9', executable: true },
  { path: 'references/guide.md', content: '../assets/logo.bin' },
  { path: 'assets/logo.bin', content: 'AAH+/w==', encoding: 'base64', executable: true },
] };
function mount(readOnly = false) {
  let current = bundle;
  function Fixture() {
    const [value, setValue] = useState(bundle);
    return <SkillBundleEditor value={value} readOnly={readOnly} onChange={(next) => { current = next; setValue(next); }} />;
  }
  render(<Fixture />);
  return () => current;
}
it('edits only the selected text and retains binary bytes/relative references/executable flags', () => {
  const current = mount();
  fireEvent.change(screen.getByLabelText('Text content'), { target: { value: '# Changed' } });
  expect(current().files.slice(1)).toEqual(bundle.files.slice(1));
  expect(current().files[0].content).toBe('# Changed');
  fireEvent.click(screen.getByRole('button', { name: 'check.sh (executable)' }));
  expect(screen.getByLabelText('Text content')).toHaveValue('exit 9');
  fireEvent.click(screen.getByLabelText('Executable metadata'));
  expect(current().files[1].executable).toBe(false);
  expect(current().files[3]).toEqual(bundle.files[3]);
  expect(screen.queryByRole('button', { name: /run|execute/i })).not.toBeInTheDocument();
});
it('shows a native keyboard-operable folder/file hierarchy and edits binary bytes without rendering', () => {
  const current = mount();
  const tree = screen.getByRole('navigation', { name: 'Bundle files' });
  expect(within(tree).getByText('assets/').tagName).toBe('SUMMARY');
  fireEvent.click(within(tree).getByRole('button', { name: 'logo.bin (executable)' }));
  expect(screen.getByLabelText('Binary bytes (base64)')).toHaveValue('AAH+/w==');
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Binary bytes (base64)'), { target: { value: 'AQID' } });
  expect(current().files[3]).toEqual({ ...bundle.files[3], content: 'AQID' });
  expect(current().files.slice(0, 3)).toEqual(bundle.files.slice(0, 3));
});
it('adds, renames and removes supporting members while preserving all other members', () => {
  const current = mount();
  fireEvent.change(screen.getByLabelText('Relative path'), { target: { value: 'references/more.md' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add file' }));
  fireEvent.change(screen.getByLabelText('Text content'), { target: { value: '../scripts/check.sh' } });
  fireEvent.change(screen.getByLabelText('New relative path'), { target: { value: 'references/renamed.md' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rename file' }));
  expect(current().files.slice(0, 4)).toEqual(bundle.files);
  expect(current().files[4]).toEqual({ path: 'references/renamed.md', content: '../scripts/check.sh', encoding: 'utf8' });
  fireEvent.click(screen.getByRole('button', { name: 'Remove file' }));
  expect(current()).toEqual(bundle);
  expect(screen.queryByRole('button', { name: 'Remove file' })).not.toBeInTheDocument();
});
it.each(['../outside', '/absolute', 'scripts', 'SCRIPTS/check.sh', 'scripts/check.sh/member', 'NUL.txt', 'references\\windows.md'])('refuses invalid or colliding relative path %s', (path) => {
  const current = mount();
  fireEvent.change(screen.getByLabelText('Relative path'), { target: { value: path } });
  fireEvent.click(screen.getByRole('button', { name: 'Add file' }));
  expect(screen.getByRole('alert')).toBeVisible(); expect(current()).toEqual(bundle);
});
it('keeps built-in controls readonly and allows member inspection', () => {
  const current = mount(true);
  expect(screen.getByLabelText('Text content')).toHaveAttribute('readonly');
  expect(screen.getByLabelText('Executable metadata')).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Add file' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'logo.bin (executable)' }));
  expect(screen.getByLabelText('Binary bytes (base64)')).toHaveAttribute('readonly');
  expect(current()).toEqual(bundle);
});
it('moves a member into a folder, and refuses a cleared or clashing path instead of keeping the old one silently (#3247)', () => {
  const current = mount();
  fireEvent.click(screen.getByRole('button', { name: 'check.sh (executable)' }));
  fireEvent.change(screen.getByLabelText('New relative path'), { target: { value: '' } });
  expect(screen.getByLabelText('New relative path')).toHaveValue('');
  fireEvent.click(screen.getByRole('button', { name: 'Rename file' }));
  expect(screen.getByRole('alert')).toBeVisible();
  fireEvent.change(screen.getByLabelText('New relative path'), { target: { value: 'references/guide.md' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rename file' }));
  expect(screen.getByRole('alert').textContent).toMatch(/conflicts with references\/guide\.md/);
  expect(current()).toEqual(bundle);
  fireEvent.change(screen.getByLabelText('New relative path'), { target: { value: 'tools/bin/check.sh' } });
  fireEvent.click(screen.getByRole('button', { name: 'Rename file' }));
  expect(current().files[1]).toEqual({ ...bundle.files[1], path: 'tools/bin/check.sh' });
});
it('reseeds the rename field when the shown member changes or disappears (#3247)', () => {
  let setOutside!: (next: SkillAssetPayload) => void;
  function Fixture() {
    const [value, setValue] = useState(bundle);
    setOutside = setValue;
    return <SkillBundleEditor value={value} onChange={setValue} />;
  }
  render(<Fixture />);
  fireEvent.click(screen.getByRole('button', { name: 'guide.md' }));
  fireEvent.change(screen.getByLabelText('New relative path'), { target: { value: 'half typed' } });
  fireEvent.click(screen.getByRole('button', { name: 'check.sh (executable)' }));
  expect(screen.getByLabelText('New relative path')).toHaveValue('scripts/check.sh');
  // Removed from outside: the editor falls back to the first member, which has no rename field,
  // and the next member shown starts from its own path.
  act(() => setOutside({ ...bundle, files: bundle.files.filter((f) => f.path !== 'scripts/check.sh') }));
  expect(screen.queryByLabelText('New relative path')).toBeNull();
  act(() => setOutside({ ...bundle, files: [bundle.files[2], bundle.files[0]] }));
  expect(screen.getByLabelText('New relative path')).toHaveValue('references/guide.md');
});
