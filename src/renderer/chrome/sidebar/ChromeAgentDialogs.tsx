import { useState } from 'react';
import { create } from 'zustand';
import { useAgentStore } from '../../stores/agentStore';
import { useProjectStore } from '../../stores/projectStore';
import { AddAgentDialog } from '../../features/agents/AddAgentDialog';
import { AgentGalleryDialog } from '../../features/agents/AgentGalleryDialog';
import { TemplateConfigDialog } from '../../features/agents/TemplateConfigDialog';
import { DeleteAgentDialog } from '../../features/agents/DeleteAgentDialog';
import { ApplyPersonaDialog } from '../../features/agents/ApplyPersonaDialog';
import { ExtractPersonaDialog } from '../../features/agents/ExtractPersonaDialog';
import { createDurableAgent, createDurableAgentFromTemplate } from '../../features/agents/create-agent';
import type { PersonaTemplate } from '../../features/personas';

/**
 * Agent dialogs for the new chrome. The legacy shell renders these inside
 * AgentList; the new sidebar has no AgentList, so it hosts them here with the
 * same creation code (features/agents/create-agent.ts).
 */

type Request = { kind: 'durable' | 'gallery'; projectId: string } | null;

interface ChromeDialogState {
  request: Request;
  openNewAgent: (projectId: string) => void;
  openGallery: (projectId: string) => void;
  close: () => void;
}

export const useChromeDialogStore = create<ChromeDialogState>((set) => ({
  request: null,
  openNewAgent: (projectId) => set({ request: { kind: 'durable', projectId } }),
  openGallery: (projectId) => set({ request: { kind: 'gallery', projectId } }),
  close: () => set({ request: null }),
}));

export function ChromeAgentDialogs() {
  const request = useChromeDialogStore((s) => s.request);
  const close = useChromeDialogStore((s) => s.close);
  const project = useProjectStore((s) => (request ? s.projects.find((p) => p.id === request.projectId) : undefined));
  const deleteDialogAgent = useAgentStore((s) => s.deleteDialogAgent);
  const applyPersonaDialogAgent = useAgentStore((s) => s.applyPersonaDialogAgent);
  const extractPersonaDialogAgent = useAgentStore((s) => s.extractPersonaDialogAgent);
  const [pendingTemplate, setPendingTemplate] = useState<{ persona: PersonaTemplate; color: string; projectId: string } | null>(null);
  const templateProject = useProjectStore((s) => (pendingTemplate ? s.projects.find((p) => p.id === pendingTemplate.projectId) : undefined));

  return (
    <>
      {request?.kind === 'durable' && project && (
        <AddAgentDialog
          onClose={close}
          projectPath={project.path}
          onCreate={(name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds, persona) => {
            close();
            void createDurableAgent(
              { id: project.id, path: project.path },
              { name, color, model, useWorktree, orchestrator, freeAgentMode, mcpIds, persona },
            );
          }}
        />
      )}
      {request?.kind === 'gallery' && project && (
        <AgentGalleryDialog
          onClose={close}
          onCreate={(persona, color) => {
            close();
            setPendingTemplate({ persona, color, projectId: project.id });
          }}
        />
      )}
      {pendingTemplate && templateProject && (
        <TemplateConfigDialog
          persona={pendingTemplate.persona}
          personaColor={pendingTemplate.color}
          projectPath={templateProject.path}
          onClose={() => setPendingTemplate(null)}
          onCreate={(templateConfig) => {
            setPendingTemplate(null);
            void createDurableAgentFromTemplate({ id: templateProject.id, path: templateProject.path }, templateConfig);
          }}
        />
      )}
      {deleteDialogAgent && <DeleteAgentDialog />}
      {applyPersonaDialogAgent && <ApplyPersonaDialog />}
      {extractPersonaDialogAgent && <ExtractPersonaDialog />}
    </>
  );
}
