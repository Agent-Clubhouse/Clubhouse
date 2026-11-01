import * as path from 'path';
import { app } from 'electron';

/** The Clubhouse base dir (`~/.clubhouse`, or `~/.clubhouse-dev` in dev), without creating it. */
export function getBaseDirPath(): string {
  const dirName = app.isPackaged ? '.clubhouse' : '.clubhouse-dev';
  return path.join(app.getPath('home'), dirName);
}
