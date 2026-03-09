import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TranscriptViewer } from './TranscriptViewer';

// IntersectionObserver polyfill for jsdom
if (typeof globalThis.IntersectionObserver === 'undefined') {
  globalThis.IntersectionObserver = class IntersectionObserver {
    constructor(_cb: any, _opts?: any) {}
    observe() {}
    unobserve() {}
    disconnect() {}
  } as any;
}

describe('TranscriptViewer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.clubhouse.agent.getTranscriptInfo = vi.fn().mockResolvedValue({
      totalEvents: 3,
      fileSizeBytes: 1024,
    });
    window.clubhouse.agent.readTranscriptPage = vi.fn().mockResolvedValue({
      totalEvents: 3,
      events: [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', id: 't1' }] } },
        { type: 'result', result: 'Task complete', cost_usd: 0.05, duration_ms: 30000 },
      ],
    });
  });

  it('renders loading state initially', () => {
    render(<TranscriptViewer agentId="agent-1" />);
    expect(screen.getByText('Loading transcript...')).toBeInTheDocument();
  });

  it('loads and displays transcript events', async () => {
    render(<TranscriptViewer agentId="agent-1" />);
    await waitFor(() => {
      expect(screen.getByText('Hello world')).toBeInTheDocument();
    });
    expect(screen.getByText('Read')).toBeInTheDocument();
    expect(screen.getByText('Task complete')).toBeInTheDocument();
  });

  it('shows cost and duration for result events', async () => {
    render(<TranscriptViewer agentId="agent-1" />);
    await waitFor(() => {
      expect(screen.getByText('$0.0500')).toBeInTheDocument();
      expect(screen.getByText('30s')).toBeInTheDocument();
    });
  });

  it('shows event count footer', async () => {
    render(<TranscriptViewer agentId="agent-1" />);
    await waitFor(() => {
      expect(screen.getByText('3 of 3 events loaded')).toBeInTheDocument();
    });
  });

  it('shows error message on failure', async () => {
    window.clubhouse.agent.getTranscriptInfo = vi.fn().mockRejectedValue(new Error('fail'));
    render(<TranscriptViewer agentId="agent-1" />);
    await waitFor(() => {
      expect(screen.getByText('Failed to load transcript.')).toBeInTheDocument();
    });
  });

  it('shows empty state when no events', async () => {
    window.clubhouse.agent.getTranscriptInfo = vi.fn().mockResolvedValue({
      totalEvents: 0,
      fileSizeBytes: 0,
    });
    window.clubhouse.agent.readTranscriptPage = vi.fn().mockResolvedValue({
      totalEvents: 0,
      events: [],
    });
    render(<TranscriptViewer agentId="agent-1" />);
    await waitFor(() => {
      expect(screen.getByText('No transcript data available.')).toBeInTheDocument();
    });
  });

  it('shows large transcript warning for files > 50MB', async () => {
    window.clubhouse.agent.getTranscriptInfo = vi.fn().mockResolvedValue({
      totalEvents: 100000,
      fileSizeBytes: 60 * 1024 * 1024,
    });
    render(<TranscriptViewer agentId="agent-1" />);
    await waitFor(() => {
      expect(screen.getByText(/60\.0 MB/)).toBeInTheDocument();
      expect(screen.getByText('Load transcript')).toBeInTheDocument();
    });
  });

  it('loads large transcript when warning dismissed', async () => {
    window.clubhouse.agent.getTranscriptInfo = vi.fn().mockResolvedValue({
      totalEvents: 200,
      fileSizeBytes: 60 * 1024 * 1024,
    });
    render(<TranscriptViewer agentId="agent-1" />);
    await waitFor(() => {
      expect(screen.getByText('Load transcript')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Load transcript'));
    await waitFor(() => {
      expect(window.clubhouse.agent.readTranscriptPage).toHaveBeenCalled();
    });
  });

  it('truncates long text and shows expand button', async () => {
    const longText = 'A'.repeat(300);
    window.clubhouse.agent.readTranscriptPage = vi.fn().mockResolvedValue({
      totalEvents: 1,
      events: [
        { type: 'assistant', message: { content: [{ type: 'text', text: longText }] } },
      ],
    });
    render(<TranscriptViewer agentId="agent-1" />);
    await waitFor(() => {
      expect(screen.getByText('Show more')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Show more'));
    expect(screen.getByText('Show less')).toBeInTheDocument();
  });

  it('handles null transcript info', async () => {
    window.clubhouse.agent.getTranscriptInfo = vi.fn().mockResolvedValue(null);
    render(<TranscriptViewer agentId="agent-1" />);
    await waitFor(() => {
      expect(screen.getByText('No transcript data available.')).toBeInTheDocument();
    });
  });
});
