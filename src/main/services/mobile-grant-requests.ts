/**
 * Clubhouse permission requests for a device that controls this computer
 * (#3205): a paired phone, or a desktop or phone in its Annex Network. The
 * Ask-first calls (#2970, Manage devices included, #3068) and `request_grant`
 * asks (#3021) waiting in Needs you, listed in the Annex snapshot as
 * `grantRequests`, announced with `grant_request:opened` and
 * `grant_request:resolved`, and answered with `grant.answer`.
 *
 * The device has the desktop's say and nothing more. Its answer goes through
 * answerGrantRequest, the one Needs you uses, so it is applied, told to the
 * agent and audited the same way, with the device's own surface (`mobile` or
 * `annex_desktop`). The request is used up before anything is saved, so two
 * answers at once resolve it exactly once, and an expired or answered request
 * can't be answered.
 *
 * A device sees, and can answer, what desktop Needs you shows, less one
 * thing: a Manage devices call that names the device itself. That one is the
 * desktop's to answer.
 *
 * These are apart from CLI `permission_request`s (`chat.permission`) and
 * from helper starts and disposes (`helperRequests`).
 */

import * as path from 'path';
import {
  describeGrantRequest, grantRequestActionLabels, grantRequestAllowEffect, type GrantRequest,
} from '../../shared/grant-requests';
import type { MobileCommand, MobileGrantAnswer, MobileGrantRequest } from '../../shared/mobile-control';
import { answerGrantRequest } from './grant-request-answers';
import { listGrantRequests, peekGrantRequest } from './grant-requests';
import { MobileControlError } from './mobile-control';

export const GRANT_REQUEST_OPENED_EVENT = 'grant_request:opened';
export const GRANT_REQUEST_RESOLVED_EVENT = 'grant_request:resolved';

/** What the desktop says when a request can't be answered any more. */
const GONE = 'This request has expired or was already answered.';

export interface GrantRequestProject { id: string; path: string }

/**
 * Where requests can come from: the registered projects, and the Dispatcher's
 * folders while Needs you shows it (on, or still running). Its requests show
 * on the agent a device talks to (#3036), as they do on the desktop.
 */
export interface GrantRequestPlaces {
  projects: readonly GrantRequestProject[];
  dispatcher: { projectId: string; paths: readonly string[]; agentId: string; askingIds: readonly string[] } | null;
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

/** The project a request is shown under, and the agent it's shown on; null when Needs you wouldn't show it. */
function placeOf(places: GrantRequestPlaces, request: GrantRequest): { projectId: string; agentId: string } | null {
  const { dispatcher } = places;
  if (dispatcher?.paths.some((p) => samePath(p, request.projectPath))) {
    return { projectId: dispatcher.projectId, agentId: dispatcher.askingIds.includes(request.agentId) ? dispatcher.agentId : request.agentId };
  }
  const project = places.projects.find((p) => samePath(p.path, request.projectPath));
  return project ? { projectId: project.id, agentId: request.agentId } : null;
}

/** The one Allow a request takes: once for a call, lasting for a grant. */
function allowFor(request: Pick<GrantRequest, 'kind'>): MobileGrantAnswer {
  return request.kind === 'call' ? 'allow_once' : 'allow_lasting';
}

/**
 * The device a Manage devices call names: its `id` argument, a device
 * fingerprint (#3068), lowercased. Null for any other request.
 */
export function deviceNamedBy(kind: GrantRequest['kind'], actions: readonly string[], argumentsText: string | null | undefined): string | null {
  if (kind !== 'call' || !actions.includes('device.manage') || !argumentsText) return null;
  try {
    const args: unknown = JSON.parse(argumentsText);
    const id = args && typeof args === 'object' ? (args as Record<string, unknown>).id : undefined;
    return typeof id === 'string' && id ? id.toLowerCase() : null;
  } catch {
    // telemetry-exempt: ask-first wrote this JSON; unreadable names no device
    return null;
  }
}

/** Whether a device may see and answer a row: not a Manage devices call about that device itself. */
export function grantRowVisibleTo(row: Pick<MobileGrantRequest, 'kind' | 'actions' | 'arguments'>, viewer: string | null | undefined): boolean {
  const device = deviceNamedBy(row.kind, row.actions, row.arguments);
  return !device || !viewer || device !== viewer.toLowerCase();
}

/** A request as a device sees it; null when Needs you wouldn't show it. */
export function toMobileGrantRequest(request: GrantRequest, places: GrantRequestPlaces): MobileGrantRequest | null {
  const place = placeOf(places, request);
  if (!place) return null;
  return {
    requestId: request.requestId,
    ...(request.update && { update: request.update }),
    kind: request.kind,
    projectId: place.projectId,
    agent: { agentId: place.agentId, name: request.agentName },
    actions: [...request.actions],
    actionLabels: grantRequestActionLabels(request),
    where: request.where,
    toolName: request.toolName ?? null,
    target: request.target ?? null,
    summary: describeGrantRequest(request),
    detail: request.detail ?? null,
    arguments: request.argumentsText ?? null,
    reason: request.reason ?? null,
    allowEffect: grantRequestAllowEffect(request),
    requestedAt: request.createdAt,
    expiresAt: request.expiresAt,
    answers: [allowFor(request), 'decline'],
  };
}

/** Every waiting request Needs you shows, oldest first. Each device's snapshot then leaves out its own (grantRowVisibleTo). */
export function buildMobileGrantRequests(places: GrantRequestPlaces): MobileGrantRequest[] {
  const rows: MobileGrantRequest[] = [];
  for (const request of listGrantRequests()) {
    const row = toMobileGrantRequest(request, places);
    if (row) rows.push(row);
  }
  return rows;
}

/**
 * `grant_request:opened`: who asked and the id, for the row in the snapshot
 * that follows. Never the arguments, so the replay buffer holds none, and
 * `agentId` is at the top so dropping an agent's events drops it.
 */
export function grantOpenedPayload(row: MobileGrantRequest): { agentId: string; requestId: string; kind: MobileGrantRequest['kind']; projectId: string } {
  return { agentId: row.agent.agentId, requestId: row.requestId, kind: row.kind, projectId: row.projectId };
}

type GrantCommand = Extract<MobileCommand, { type: 'grant.answer' }>;

export interface GrantCommandDeps {
  /** Throws once the device's authorization changed; called just before the answer. */
  assertAuthorized: () => void;
  /** The answering device's fingerprint. */
  viewer: string;
}

export interface GrantCommandResult {
  requestId: string;
  kind: 'call' | 'grant';
  answer: MobileGrantAnswer;
}

/** Run `grant.answer`. Errors are MobileControlErrors for the receipt. */
export async function runGrantCommand(command: GrantCommand, places: GrantRequestPlaces, deps: GrantCommandDeps): Promise<GrantCommandResult> {
  const { requestId, answer, updateMode } = command;
  // The answer rechecks the row and authorization if loading the update service yields.
  const request = peekGrantRequest(requestId);
  const row = request ? toMobileGrantRequest(request, places) : null;
  // A device answers only what it could have been shown.
  if (!request || !row || !grantRowVisibleTo(row, deps.viewer)) throw new MobileControlError('grant_request_not_found', 404, 'rejected', GONE);
  if (answer !== 'decline' && answer !== allowFor(request)) {
    throw new MobileControlError('grant_answer_not_offered', 409, 'rejected', request.kind === 'call'
      ? 'This request is for one call. Allow it once, or decline it.'
      : 'This request adds a lasting permission. Allow or decline it.');
  }
  if (updateMode !== undefined && (!request.update || answer !== 'allow_once')) {
    throw new MobileControlError('grant_answer_not_offered', 409, 'rejected', 'A restart choice is only for allowing an update request once.');
  }
  deps.assertAuthorized();
  const result = await answerGrantRequest(requestId, answer !== 'decline', updateMode, deps.assertAuthorized);
  if (result.ok === false) {
    // Put back when saving the permission failed, unless its agent went or asked again meanwhile.
    if (request.update || peekGrantRequest(requestId)) throw new MobileControlError('grant_answer_failed', 409, 'rejected', result.error);
    throw new MobileControlError('grant_request_not_found', 404, 'rejected', GONE);
  }
  return { requestId, kind: request.kind, answer };
}
