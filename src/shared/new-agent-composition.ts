export interface NewAgentCompositionPreview {
  token: string;
  expiresAt: number;
  text: string;
  skills: Array<{ id: string; name: string; revision: number }>;
  availableBlocks?: Array<{ id: string; name: string }>;
  availableSkills: Array<{ id: string; name: string }>;
}
