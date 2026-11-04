/** PILOT, never ships. Lets a spec see what would reach main, without an enrollment or a server. */
import type { FeedbackSendInput, FeedbackSendResult } from '../../../shared/feedback-types';
import type { EditorOptions } from './pilot-editor';

export const pilotHooks: {
  send: ((input: FeedbackSendInput) => Promise<FeedbackSendResult>) | null;
  editorOptions: EditorOptions | undefined;
} = { send: null, editorOptions: undefined };
