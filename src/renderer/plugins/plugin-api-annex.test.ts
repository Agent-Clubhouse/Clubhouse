import { createAnnexAPI } from './plugin-api-annex';
import type { PluginContext } from '../../shared/plugin-types';

const createMockAnnexClient = () => ({
  agentSpawn: vi.fn().mockResolvedValue('remote-agent-id'),
  agentKill: vi.fn().mockResolvedValue(undefined),
  agentWake: vi.fn().mockResolvedValue(undefined),
  agentCreateDurable: vi.fn().mockResolvedValue({ id: 'durable-id' }),
  agentDeleteDurable: vi.fn().mockResolvedValue(undefined),
  agentWorktreeStatus: vi.fn().mockResolvedValue({ status: 'clean' }),
  agentReorder: vi.fn().mockResolvedValue(undefined),
  ptyInput: vi.fn().mockResolvedValue(undefined),
  ptyResize: vi.fn().mockResolvedValue(undefined),
  ptySpawnShell: vi.fn().mockResolvedValue(undefined),
  ptyGetBuffer: vi.fn().mockResolvedValue('buffer content'),
  clipboardImage: vi.fn().mockResolvedValue(undefined),
  fileTree: vi.fn().mockResolvedValue([]),
  fileRead: vi.fn().mockResolvedValue('file content'),
  gitOperation: vi.fn().mockResolvedValue({ success: true }),
  canvasMutation: vi.fn().mockResolvedValue(undefined),
  sessionList: vi.fn().mockResolvedValue([]),
  sessionTranscript: vi.fn().mockResolvedValue([]),
  sessionSummary: vi.fn().mockResolvedValue({}),
  gpGet: vi.fn().mockResolvedValue({}),
  gpUpdate: vi.fn().mockResolvedValue({}),
  gpBulletinDigest: vi.fn().mockResolvedValue([]),
  gpBulletinTopic: vi.fn().mockResolvedValue([]),
  gpBulletinAll: vi.fn().mockResolvedValue([]),
  gpBulletinPost: vi.fn().mockResolvedValue({}),
  gpShoulderTap: vi.fn().mockResolvedValue({}),
  gpDeleteMessage: vi.fn().mockResolvedValue(true),
  gpDeleteTopic: vi.fn().mockResolvedValue(true),
  gpSetTopicProtection: vi.fn().mockResolvedValue(true),
  gpInjectMessage: vi.fn().mockResolvedValue(true),
  gpSetPolling: vi.fn().mockResolvedValue({}),
  getSatellites: vi.fn().mockResolvedValue([]),
  scan: vi.fn().mockResolvedValue(undefined),
  connect: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  retry: vi.fn().mockResolvedValue(undefined),
  getDiscovered: vi.fn().mockResolvedValue([]),
  pairWith: vi.fn().mockResolvedValue(undefined),
  forgetSatellite: vi.fn().mockResolvedValue(undefined),
  forgetAllSatellites: vi.fn().mockResolvedValue(undefined),
  onSatellitesChanged: vi.fn().mockReturnValue(vi.fn()),
  onDiscoveredChanged: vi.fn().mockReturnValue(vi.fn()),
  onSatelliteEvent: vi.fn().mockReturnValue(vi.fn()),
});

const createMockPluginContext = (): PluginContext => ({
  extensionId: 'test-plugin',
  subscriptions: [],
  workbench: {} as any,
  commands: {} as any,
  settings: {} as any,
  project: {} as any,
  globalData: {} as any,
});

describe('plugin-api-annex', () => {
  let mockAnnexClient: ReturnType<typeof createMockAnnexClient>;
  let mockPluginContext: PluginContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAnnexClient = createMockAnnexClient();
    mockPluginContext = createMockPluginContext();
    (window.clubhouse as any) = {
      annexClient: mockAnnexClient,
    };
  });

  describe('agentSpawn passthrough', () => {
    it('calls window.clubhouse.annexClient.agentSpawn with correct params', async () => {
      const api = createAnnexAPI(mockPluginContext);
      const params = { model: 'test-model', instructions: 'test' };
      
      await api.agentSpawn('sat-1', params);
      
      expect(mockAnnexClient.agentSpawn).toHaveBeenCalledWith('sat-1', params);
    });

    it('returns the result from window.clubhouse.annexClient.agentSpawn', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      const result = await api.agentSpawn('sat-1', {});
      
      expect(result).toBe('remote-agent-id');
    });
  });

  describe('agentKill passthrough', () => {
    it('calls window.clubhouse.annexClient.agentKill with correct params', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.agentKill('sat-1', 'agent-1');
      
      expect(mockAnnexClient.agentKill).toHaveBeenCalledWith('sat-1', 'agent-1');
    });
  });

  describe('agentCreateDurable passthrough', () => {
    it('calls window.clubhouse.annexClient.agentCreateDurable with correct params', async () => {
      const api = createAnnexAPI(mockPluginContext);
      const params = {
        name: 'durable-agent',
        color: '#ff0000',
        model: 'claude-3',
      };
      
      await api.agentCreateDurable('sat-1', 'proj-1', params);
      
      expect(mockAnnexClient.agentCreateDurable).toHaveBeenCalledWith('sat-1', 'proj-1', params);
    });

    it('returns the result from window.clubhouse.annexClient.agentCreateDurable', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      const result = await api.agentCreateDurable('sat-1', 'proj-1', {
        name: 'test',
        color: '#000',
      });
      
      expect(result).toEqual({ id: 'durable-id' });
    });
  });

  describe('agentDeleteDurable passthrough', () => {
    it('calls window.clubhouse.annexClient.agentDeleteDurable with correct params', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.agentDeleteDurable('sat-1', 'proj-1', 'agent-1', 'soft');
      
      expect(mockAnnexClient.agentDeleteDurable).toHaveBeenCalledWith(
        'sat-1',
        'proj-1',
        'agent-1',
        'soft'
      );
    });
  });

  describe('ptyInput passthrough', () => {
    it('calls window.clubhouse.annexClient.ptyInput with correct params', async () => {
      const api = createAnnexAPI(mockPluginContext);
      const data = 'echo hello\n';
      
      await api.ptyInput('sat-1', 'session-1', data);
      
      expect(mockAnnexClient.ptyInput).toHaveBeenCalledWith('sat-1', 'session-1', data);
    });
  });

  describe('ptySpawnShell passthrough', () => {
    it('calls window.clubhouse.annexClient.ptySpawnShell with correct params', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.ptySpawnShell('sat-1', 'session-1', 'proj-1');
      
      expect(mockAnnexClient.ptySpawnShell).toHaveBeenCalledWith('sat-1', 'session-1', 'proj-1');
    });
  });

  describe('fileRead passthrough', () => {
    it('calls window.clubhouse.annexClient.fileRead with correct params', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.fileRead('sat-1', 'proj-1', 'src/main.ts');
      
      expect(mockAnnexClient.fileRead).toHaveBeenCalledWith('sat-1', 'proj-1', 'src/main.ts');
    });

    it('returns the file content from window.clubhouse.annexClient.fileRead', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      const result = await api.fileRead('sat-1', 'proj-1', 'src/main.ts');
      
      expect(result).toBe('file content');
    });
  });

  describe('gitOperation passthrough', () => {
    it('calls window.clubhouse.annexClient.gitOperation with correct params', async () => {
      const api = createAnnexAPI(mockPluginContext);
      const params = { operation: 'status' };
      
      await api.gitOperation('sat-1', 'proj-1', params);
      
      expect(mockAnnexClient.gitOperation).toHaveBeenCalledWith('sat-1', 'proj-1', params);
    });

    it('returns the result from window.clubhouse.annexClient.gitOperation', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      const result = await api.gitOperation('sat-1', 'proj-1', { operation: 'log' });
      
      expect(result).toEqual({ success: true });
    });
  });

  describe('additional passthroughs', () => {
    it('getSatellites passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.getSatellites();
      
      expect(mockAnnexClient.getSatellites).toHaveBeenCalled();
    });

    it('scan passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.scan();
      
      expect(mockAnnexClient.scan).toHaveBeenCalled();
    });

    it('connect passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.connect('fp-123', 'token');
      
      expect(mockAnnexClient.connect).toHaveBeenCalledWith('fp-123', 'token');
    });

    it('disconnect passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.disconnect('fp-123');
      
      expect(mockAnnexClient.disconnect).toHaveBeenCalledWith('fp-123');
    });

    it('retry passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.retry('fp-123');
      
      expect(mockAnnexClient.retry).toHaveBeenCalledWith('fp-123');
    });

    it('getDiscovered passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.getDiscovered();
      
      expect(mockAnnexClient.getDiscovered).toHaveBeenCalled();
    });

    it('pairWith passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.pairWith('fp-123', '1234');
      
      expect(mockAnnexClient.pairWith).toHaveBeenCalledWith('fp-123', '1234');
    });

    it('forgetSatellite passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.forgetSatellite('fp-123');
      
      expect(mockAnnexClient.forgetSatellite).toHaveBeenCalledWith('fp-123');
    });

    it('forgetAllSatellites passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.forgetAllSatellites();
      
      expect(mockAnnexClient.forgetAllSatellites).toHaveBeenCalled();
    });

    it('agentWake passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.agentWake('sat-1', 'agent-1', { resume: true });
      
      expect(mockAnnexClient.agentWake).toHaveBeenCalledWith('sat-1', 'agent-1', {
        resume: true,
      });
    });

    it('agentWorktreeStatus passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.agentWorktreeStatus('sat-1', 'proj-1', 'agent-1');
      
      expect(mockAnnexClient.agentWorktreeStatus).toHaveBeenCalledWith(
        'sat-1',
        'proj-1',
        'agent-1'
      );
    });

    it('agentReorder passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.agentReorder('sat-1', 'proj-1', ['a1', 'a2']);
      
      expect(mockAnnexClient.agentReorder).toHaveBeenCalledWith('sat-1', 'proj-1', ['a1', 'a2']);
    });

    it('ptyResize passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.ptyResize('sat-1', 'session-1', 80, 24);
      
      expect(mockAnnexClient.ptyResize).toHaveBeenCalledWith('sat-1', 'session-1', 80, 24);
    });

    it('ptyGetBuffer passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.ptyGetBuffer('sat-1', 'session-1');
      
      expect(mockAnnexClient.ptyGetBuffer).toHaveBeenCalledWith('sat-1', 'session-1');
    });

    it('clipboardImage passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.clipboardImage('sat-1', 'agent-1', 'base64data', 'image/png');
      
      expect(mockAnnexClient.clipboardImage).toHaveBeenCalledWith(
        'sat-1',
        'agent-1',
        'base64data',
        'image/png'
      );
    });

    it('fileTree passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.fileTree('sat-1', 'proj-1', { path: 'src', depth: 2 });
      
      expect(mockAnnexClient.fileTree).toHaveBeenCalledWith('sat-1', 'proj-1', {
        path: 'src',
        depth: 2,
      });
    });

    it('canvasMutation passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      const mutation = { type: 'update' };
      
      await api.canvasMutation('sat-1', 'proj-1', 'canvas-1', 'global', mutation);
      
      expect(mockAnnexClient.canvasMutation).toHaveBeenCalledWith(
        'sat-1',
        'proj-1',
        'canvas-1',
        'global',
        mutation
      );
    });

    it('sessionList passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.sessionList('sat-1', 'agent-1', 'proj-1', 'orchestrator-1');
      
      expect(mockAnnexClient.sessionList).toHaveBeenCalledWith(
        'sat-1',
        'agent-1',
        'proj-1',
        'orchestrator-1'
      );
    });

    it('sessionTranscript passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.sessionTranscript('sat-1', 'agent-1', 'session-1', 'proj-1', 0, 100, 'orch');
      
      expect(mockAnnexClient.sessionTranscript).toHaveBeenCalledWith(
        'sat-1',
        'agent-1',
        'session-1',
        'proj-1',
        0,
        100,
        'orch'
      );
    });

    it('sessionSummary passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.sessionSummary('sat-1', 'agent-1', 'session-1', 'proj-1', 'orch');
      
      expect(mockAnnexClient.sessionSummary).toHaveBeenCalledWith(
        'sat-1',
        'agent-1',
        'session-1',
        'proj-1',
        'orch'
      );
    });

    it('gpGet passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpGet('sat-1', 'gp-1');
      
      expect(mockAnnexClient.gpGet).toHaveBeenCalledWith('sat-1', 'gp-1');
    });

    it('gpUpdate passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      const fields = { name: 'Updated' };
      
      await api.gpUpdate('sat-1', 'gp-1', fields);
      
      expect(mockAnnexClient.gpUpdate).toHaveBeenCalledWith('sat-1', 'gp-1', fields);
    });

    it('gpBulletinDigest passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpBulletinDigest('sat-1', 'gp-1', { minutes: 60 });
      
      expect(mockAnnexClient.gpBulletinDigest).toHaveBeenCalledWith(
        'sat-1',
        'gp-1',
        { minutes: 60 }
      );
    });

    it('gpBulletinTopic passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpBulletinTopic('sat-1', 'gp-1', 'news', '2026-01-01', 10);
      
      expect(mockAnnexClient.gpBulletinTopic).toHaveBeenCalledWith(
        'sat-1',
        'gp-1',
        'news',
        '2026-01-01',
        10
      );
    });

    it('gpBulletinAll passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpBulletinAll('sat-1', 'gp-1', '2026-01-01', 50);
      
      expect(mockAnnexClient.gpBulletinAll).toHaveBeenCalledWith(
        'sat-1',
        'gp-1',
        '2026-01-01',
        50
      );
    });

    it('gpBulletinPost passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpBulletinPost('sat-1', 'gp-1', 'agent-1', 'topic', 'message body');
      
      expect(mockAnnexClient.gpBulletinPost).toHaveBeenCalledWith(
        'sat-1',
        'gp-1',
        'agent-1',
        'topic',
        'message body'
      );
    });

    it('gpShoulderTap passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpShoulderTap('sat-1', 'gp-1', 'agent-1', 'message', 'sender');
      
      expect(mockAnnexClient.gpShoulderTap).toHaveBeenCalledWith(
        'sat-1',
        'gp-1',
        'agent-1',
        'message',
        'sender'
      );
    });

    it('gpDeleteMessage passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpDeleteMessage('sat-1', 'gp-1', 'topic', 'msg-1');
      
      expect(mockAnnexClient.gpDeleteMessage).toHaveBeenCalledWith(
        'sat-1',
        'gp-1',
        'topic',
        'msg-1'
      );
    });

    it('gpDeleteTopic passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpDeleteTopic('sat-1', 'gp-1', 'topic');
      
      expect(mockAnnexClient.gpDeleteTopic).toHaveBeenCalledWith('sat-1', 'gp-1', 'topic');
    });

    it('gpSetTopicProtection passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpSetTopicProtection('sat-1', 'gp-1', 'topic', true);
      
      expect(mockAnnexClient.gpSetTopicProtection).toHaveBeenCalledWith(
        'sat-1',
        'gp-1',
        'topic',
        true
      );
    });

    it('gpInjectMessage passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpInjectMessage('sat-1', 'agent-1', 'message text');
      
      expect(mockAnnexClient.gpInjectMessage).toHaveBeenCalledWith('sat-1', 'agent-1', 'message text');
    });

    it('gpSetPolling passthrough works', async () => {
      const api = createAnnexAPI(mockPluginContext);
      
      await api.gpSetPolling('sat-1', 'gp-1', true);
      
      expect(mockAnnexClient.gpSetPolling).toHaveBeenCalledWith('sat-1', 'gp-1', true);
    });
  });

  describe('event subscriptions', () => {
    it('onSatellitesChanged registers a subscription', () => {
      const api = createAnnexAPI(mockPluginContext);
      const callback = vi.fn();
      
      api.onSatellitesChanged(callback);
      
      expect(mockAnnexClient.onSatellitesChanged).toHaveBeenCalledWith(callback);
      expect(mockPluginContext.subscriptions.length).toBe(1);
    });

    it('onDiscoveredChanged registers a subscription', () => {
      const api = createAnnexAPI(mockPluginContext);
      const callback = vi.fn();
      
      api.onDiscoveredChanged(callback);
      
      expect(mockAnnexClient.onDiscoveredChanged).toHaveBeenCalledWith(callback);
      expect(mockPluginContext.subscriptions.length).toBe(1);
    });

    it('onSatelliteEvent registers a subscription', () => {
      const api = createAnnexAPI(mockPluginContext);
      const callback = vi.fn();
      
      api.onSatelliteEvent(callback);
      
      expect(mockAnnexClient.onSatelliteEvent).toHaveBeenCalledWith(callback);
      expect(mockPluginContext.subscriptions.length).toBe(1);
    });

    it('subscription disposables have dispose method', () => {
      const api = createAnnexAPI(mockPluginContext);
      const callback = vi.fn();
      
      const disposable = api.onSatellitesChanged(callback);
      
      expect(disposable.dispose).toBeDefined();
      expect(typeof disposable.dispose).toBe('function');
    });
  });
});
