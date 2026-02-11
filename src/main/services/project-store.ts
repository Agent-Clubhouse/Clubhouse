import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { Project } from '../../shared/types';

function getStorePath(): string {
  const dir = path.join(app.getPath('home'), '.clubhouse');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return path.join(dir, 'projects.json');
}

function readProjects(): Project[] {
  const storePath = getStorePath();
  if (!fs.existsSync(storePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(storePath, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function writeProjects(projects: Project[]): void {
  const storePath = getStorePath();
  fs.writeFileSync(storePath, JSON.stringify(projects, null, 2), 'utf-8');
}

export function list(): Project[] {
  return readProjects();
}

export function add(dirPath: string): Project {
  const projects = readProjects();
  const name = path.basename(dirPath);
  const id = `proj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const project: Project = { id, name, path: dirPath };
  projects.push(project);
  writeProjects(projects);
  return project;
}

export function remove(id: string): void {
  const projects = readProjects();
  const filtered = projects.filter((p) => p.id !== id);
  writeProjects(filtered);
}
