/**
 * Clubhouse permission requests for a paired phone (#3205): the Ask-first
 * calls (#2970, Manage devices included, #3068) and `request_grant` asks
 * (#3021) waiting in Needs you, listed in the Annex snapshot as
 * `grantRequests`, announced with `grant_request:opened` and
 * `grant_request:resolved`, and answered with `grant.answer`.
 *
 * The phone has the desktop's say and nothing more. Its answer goes through
 * answerGrantRequest, the one Needs you uses, so it is applied, told to the
 * agent and audited the same way, with the surface `mobile`. The request is
 * used up before anything is saved, so the phone and the desktop answering
 * at once resolve it exactly once, and an expired or answered request can't
 * be answered.
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

/** Where requests can come from: the registered projects, and the Dispatcher's folders under its project id. */
export interface GrantRequestPlaces {
  projects: readonly GrantRequestProject[];
  dispatcher: { projectId: string; paths: readonly string[] } | null;
}

function samePath(a: string, b: string): boolean {
  const ra = path.resolve(a);
  const rb = path.resolve(b);
  return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
}

function projectIdFor(places: GrantRequestPlaces, projectPath: string): string | null {
  const project = places.projects.find((p) => samePath(p.path, projectPath));
  if (project) return project.id;
  if (places.dispatcher?.paths.some((p) => samePath(p, projectPath))) return places.dispatcher.projectId;
  return null;
}

/** The one Allow a request takes: once for a call, lasting for a grant. */
function allowFor(request: Pick<GrantRequest, 'kind'>): MobileGrantAnswer {
  return request.kind === 'call' ? 'allow_once' : 'allow_lasting';
}

/** A request as a phone sees it; null when its agent is in no place the phone knows. */
export function toMobileGrantRequest(request: GrantRequest, places: GrantRequestPlaces): MobileGrantRequest | null {
  const projectId = projectIdFor(places, request.projectPath);
  if (!projectId) return null;
  return {
    requestId: request.requestId,
    kind: request.kind,
    projectId,
    agent: { agentId: request.agentId, name: request.agentName },
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

/** Every waiting request in a place the phone knows, oldest first. */
export function buildMobileGrantRequests(places: GrantRequestPlaces): MobileGrantRequest[] {
  const rows: MobileGrantRequest[] = [];
  for (const request of listGrantRequests()) {
    const row = toMobileGrantRequest(request, places);
    if (row) rows.push(row);
  }
  return rows;
}

type GrantCommand = Extract<MobileCommand, { type: 'grant.answer' }>;

export interface GrantCommandDeps {
  /** Throws once the phone's authorization changed; called just before the answer. */
  assertAuthorized: () => void;
}

export interface GrantCommandResult {
  requestId: string;
  kind: 'call' | 'grant';
  answer: MobileGrantAnswer;
}

/** Run `grant.answer`. Errors are MobileControlErrors for the receipt. */
export async function runGrantCommand(command: GrantCommand, places: GrantRequestPlaces, deps: GrantCommandDeps): Promise<GrantCommandResult> {
  const { requestId, answer } = command;
  // From here to the answer taking the request nothing waits, so no other answer or expiry lands in between.
  const request = peekGrantRequest(requestId);
  // A phone answers only what it could have been shown.
  if (!request || !toMobileGrantRequest(request, places)) throw new MobileControlError('grant_request_not_found', 404, 'rejected', GONE);
  if (answer !== 'decline' && answer !== allowFor(request)) {
    throw new MobileControlError('grant_answer_not_offered', 409, 'rejected', request.kind === 'call'
      ? 'This request is for one call. Allow it once, or decline it.'
      : 'This request adds a lasting permission. Allow or decline it.');
  }
  deps.assertAuthorized();
  const result = await answerGrantRequest(requestId, answer !== 'decline');
  if (result.ok === false) {
    // Put back when saving the permission failed: the user can try again or decline it.
    if (peekGrantRequest(requestId)) throw new MobileControlError('grant_answer_failed', 409, 'rejected', result.error);
    throw new MobileControlError('grant_request_not_found', 404, 'rejected', GONE);
  }
  return { requestId, kind: request.kind, answer };
}
