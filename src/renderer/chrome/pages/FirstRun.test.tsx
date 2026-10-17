import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { FirstRun } from './FirstRun';
import { useProjectStore } from '../../stores/projectStore';

let pickAndAddProject: ReturnType<typeof vi.fn>;
let addProject: ReturnType<typeof vi.fn>;

beforeEach(() => {
  pickAndAddProject = vi.fn().mockResolvedValue(null);
  addProject = vi.fn().mockResolvedValue({ id: 'p1' });
  useProjectStore.setState({ projects: [], pickAndAddProject, addProject } as never);
});

describe('FirstRun', () => {
  it('asks for a folder', () => {
    render(<FirstRun />);
    expect(screen.getByTestId('first-run').textContent).toContain('Add your first project');
    fireEvent.click(screen.getByTestId('first-run-choose'));
    expect(pickAndAddProject).toHaveBeenCalled();
  });

  it('adds a dropped folder', () => {
    vi.spyOn(window.clubhouse, 'getPathForFile').mockReturnValue('/Users/me/src/site');
    render(<FirstRun />);
    const file = new File([], 'site');
    fireEvent.drop(screen.getByTestId('first-run'), { dataTransfer: { files: [file], types: ['Files'] } });
    expect(addProject).toHaveBeenCalledWith('/Users/me/src/site');
  });
});
