export interface NewAgentCompositionPreview {
  token: string;
  expiresAt: number;
  text: string;
  skills: Array<{ id: string; name: string; revision: number }>;
  availableSkills: Array<{ id: string; name: string }>;
}
