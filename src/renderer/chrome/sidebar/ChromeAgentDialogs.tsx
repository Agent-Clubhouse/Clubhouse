import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { AgentGalleryDialog } from '../../features/agents/AgentGalleryDialog';
import { TemplateConfigDialog } from '../../features/agents/TemplateConfigDialog';
import { DeleteAgentDialog } from '../../features/agents/DeleteAgentDialog';
import { ApplyPersonaDialog } from '../../features/agents/ApplyPersonaDialog';
import { ExtractPersonaDialog } from '../../features/agents/ExtractPersonaDialog';
import { HelperDisposeRequestDialog } from '../../features/agents/helpers/HelperDisposeRequestDialog';
import { createDurableAgentFromTemplate } from '../../features/agents/create-agent';
import { openCreatedAgent } from '../startPage';
import type { PersonaTemplate } from '../../features/personas';

/**
 * Agent dialogs for the new chrome. The legacy shell renders these inside
 * AgentList; the new sidebar has no AgentList, so it hosts them here with the
 * same creation code (features/agents/create-agent.ts). New durable and quick
 * agents are made on the New agent page instead (pages/NewAgentPage.tsx).
 */

/** Callbacks of a New agent page that handed off to the template dialogs (NewAgentOptions' contract). */
export interface TemplateOpener {
  onCreated?: (agentId: string) => void;
  onClosed?: (createdAgentId: string | null) => void;
  /** As on the page: after creating, stay on the view underneath instead of opening the agent. */
  stayInView?: boolean;
}

type Request = { kind: 'gallery'; projectId: string; opener?: TemplateOpener } | null;

interface ChromeDialogState {
  request: Request;
  openGallery: (projectId: string, opener?: TemplateOpener) => void;
  close: () => void;
}

export const useChromeDialogStore = create<ChromeDialogState>((set, get) => ({
  request: null,
  openGallery: (projectId, opener) => {
    const dropped = get().request?.opener;
    set({ request: { kind: 'gallery', projectId, opener } });
    // A second open replaces the first, whose opener ends with nothing made.
    dropped?.onClosed?.(null);
  },
  close: () => set({ request: null }),
}));

export function ChromeAgentDialogs() {
  const request = useChromeDialogStore((s) => s.request);
  const close = useChromeDialogStore((s) => s.close);
  const project = useProjectStore((s) => (request ? s.projects.find((p) => p.id === request.projectId) : undefined));
  const deleteDialogAgent = useAgentStore((s) => s.deleteDialogAgent);
  const applyPersonaDialogAgent = useAgentStore((s) => s.applyPersonaDialogAgent);
  const extractPersonaDialogAgent = useAgentStore((s) => s.extractPersonaDialogAgent);
  const [pendingTemplate, setPendingTemplate] = useState<{ persona: PersonaTemplate; color: string; projectId: string; opener?: TemplateOpener } | null>(null);
  const templateProject = useProjectStore((s) => (pendingTemplate ? s.projects.find((p) => p.id === pendingTemplate.projectId) : undefined));

  // The project went away under an open gallery or template dialog: it can't
  // be used any more, so drop it and tell the opener nothing was made.
  useEffect(() => {
    if (request && !project) { close(); request.opener?.onClosed?.(null); }
  }, [request, project, close]);
  useEffect(() => {
    if (pendingTemplate && !templateProject) { setPendingTemplate(null); pendingTemplate.opener?.onClosed?.(null); }
  }, [pendingTemplate, templateProject]);

  return (
    <>
      {request?.kind === 'gallery' && project && (
        <AgentGalleryDialog
          onClose={() => { close(); request.opener?.onClosed?.(null); }}
          onCreate={(persona, color) => {
            close();
            setPendingTemplate({ persona, color, projectId: project.id, opener: request.opener });
          }}
        />
      )}
      {pendingTemplate && templateProject && (
        <TemplateConfigDialog
          persona={pendingTemplate.persona}
          personaColor={pendingTemplate.color}
          projectPath={templateProject.path}
          onClose={() => { setPendingTemplate(null); pendingTemplate.opener?.onClosed?.(null); }}
          onCreate={(templateConfig) => {
            const opener = pendingTemplate.opener;
            setPendingTemplate(null);
            const projectId = templateProject.id;
            void createDurableAgentFromTemplate({ id: projectId, path: templateProject.path }, templateConfig).then((id) => {
              if (id) opener?.onCreated?.(id);
              opener?.onClosed?.(id);
              // Like the page: an opener without stayInView sees the new agent. The New menu (no opener) keeps today's behaviour.
              if (id && opener && !opener.stayInView) openCreatedAgent(projectId, id);
            });
          }}
        />
      )}
      {deleteDialogAgent && <DeleteAgentDialog />}
      {applyPersonaDialogAgent && <ApplyPersonaDialog />}
      {extractPersonaDialogAgent && <ExtractPersonaDialog />}
      <HelperDisposeRequestDialog />
    </>
  );
}
