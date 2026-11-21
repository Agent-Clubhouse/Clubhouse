/** Private path/metadata witness for the selected provider's bounded instruction count. */
import * as fs from 'fs';
import * as path from 'path';
import type { DisplayReceipt } from './display-settings';

export function captureInstructionDisplayWitness(root: string, relative: string): DisplayReceipt {
  const segments = relative.split(/[\\/]/);
  if (path.isAbsolute(relative) || relative.length > 4096 || segments.length > 32 || segments.some((part) => !part || part === '.' || part === '..')) throw new Error('instruction_path_unavailable');
  const read = () => {
    const anchor = fs.realpathSync(root), rows: string[] = [anchor];
    let file = anchor;
    const identity = (stat: fs.BigIntStats) => `${stat.dev}:${stat.ino}`;
    const rootStat = fs.lstatSync(anchor, { bigint: true });
    if (!rootStat.isDirectory()) throw new Error('instruction_root_unavailable');
    rows.push(identity(rootStat));
    for (let index = 0; index < segments.length; index++) {
      file = path.join(file, segments[index]);
      let stat: fs.BigIntStats;
      try { stat = fs.lstatSync(file, { bigint: true }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { rows.push('missing'); break; } throw error; }
      if (stat.isSymbolicLink()) throw new Error('instruction_link_unavailable');
      if (index < segments.length - 1) {
        if (!stat.isDirectory()) throw new Error('instruction_parent_unavailable');
        rows.push(identity(stat));
      } else {
        if (!stat.isFile()) throw new Error('instruction_file_unavailable');
        rows.push(`${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`);
      }
    }
    return JSON.stringify(rows);
  };
  const admitted = read();
  return { current: () => { try { return read() === admitted; } catch { return false; } } };
}
