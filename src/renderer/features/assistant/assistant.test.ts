import { describe, it, expect } from 'vitest';
import type { FeedItem, AssistantMessage, ActionCardData } from './types';

describe('assistant types', () => {
  it('FeedItem with message has correct shape', () => {
    const msg: AssistantMessage = {
      id: 'msg-1',
      role: 'user',
      content: 'Hello',
      timestamp: Date.now(),
    };
    const item: FeedItem = { type: 'message', message: msg };
    expect(item.type).toBe('message');
    expect(item.message?.role).toBe('user');
    expect(item.message?.content).toBe('Hello');
  });

  it('FeedItem with action has correct shape', () => {
    const action: ActionCardData = {
      id: 'act-1',
      toolName: 'list_projects',
      description: 'Listing projects',
      status: 'completed',
      output: '3 projects found',
      durationMs: 150,
    };
    const item: FeedItem = { type: 'action', action };
    expect(item.type).toBe('action');
    expect(item.action?.status).toBe('completed');
  });

  it('AssistantMessage supports user and assistant roles', () => {
    const user: AssistantMessage = {
      id: 'u1',
      role: 'user',
      content: 'test',
      timestamp: 1000,
    };
    const assistant: AssistantMessage = {
      id: 'a1',
      role: 'assistant',
      content: '**bold** response',
      timestamp: 1001,
    };
    expect(user.role).toBe('user');
    expect(assistant.role).toBe('assistant');
  });

  it('ActionCardData supports all statuses', () => {
    const statuses: ActionCardData['status'][] = ['pending', 'running', 'completed', 'error'];
    for (const status of statuses) {
      const card: ActionCardData = {
        id: `card-${status}`,
        toolName: 'test',
        description: 'test',
        status,
      };
      expect(card.status).toBe(status);
    }
  });
});
