import text from './handoff-skill/SKILL.md';

export const PREPARE_HANDOFF_SKILL = {
  id: 'builtin-skill-prepare-handoff',
  name: 'Prepare handoff',
  skillName: 'prepare-handoff',
  description: 'Prepares a secret-safe brief and verified transfer preview, then offers work to an authorized agent or computer Dispatcher.',
  file: 'skills/prepare-handoff/SKILL.md',
} as const;

export const PREPARE_HANDOFF_SKILL_TEXT = text.replace(/\r\n/g, '\n');

interface PrepareHandoffSkillAccess {
  /** True only after the actual handoff tools and safety preview are available. */
  available: boolean;
  canOffer(agentId: string): boolean;
}

let access: PrepareHandoffSkillAccess = { available: false, canOffer: () => false };

/** The trusted runtime must check both feature availability and the current handoff.offer grant. Off until installed. */
export function setPrepareHandoffSkillAccess(source: PrepareHandoffSkillAccess | null): void {
  access = source ?? { available: false, canOffer: () => false };
}

export function canPrepareHandoff(agentId?: string): boolean {
  return agentId !== undefined && access.available === true && access.canOffer(agentId) === true;
}
