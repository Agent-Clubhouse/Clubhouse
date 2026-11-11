import { getDispatcherMemoryPath } from './dispatcher-paths';
import { memoryWrite, parseTopicPage } from './dispatcher-memory';
import { MAX_MEMORY_PAGE_CHARS, MemoryReadError } from './dispatcher-memory-reader';

/** Replace a page through the same confined path as read_memory. */
export async function writeDispatcherMemory(
  page: string, text: string, root: string = getDispatcherMemoryPath(),
): Promise<{ page: string; text: string }> {
  const wanted = page.trim().replace(/\\/g, '/');
  if (wanted.split('/').some((part) => part === 'history' || part === 'archive')) {
    throw new MemoryReadError('History and archived memory are read only. Write an active page instead.');
  }
  if (text.length > MAX_MEMORY_PAGE_CHARS) throw new MemoryReadError(`Memory pages may contain at most ${MAX_MEMORY_PAGE_CHARS} characters.`);
  if (wanted.startsWith('topics/') && !parseTopicPage(text)) throw new MemoryReadError('Topic pages need Status and Source headers, then a blank line and the body.');
  return { page: wanted, text: await memoryWrite(wanted, text, 'agent tool', root) };
}
