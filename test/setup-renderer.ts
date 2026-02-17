import '@testing-library/jest-dom';

// Baseline window.clubhouse mock — same shape as the preload bridge.
// Individual tests can override specific methods via vi.mocked() or vi.spyOn().

const noop = () => {};
const asyncNoop = async () => {};

vi.stubGlobal('clubhouse', {
  project: {
    readFile: asyncNoop,
    writeFile: asyncNoop,
    deleteFile: asyncNoop,
    fileExists: async () => false,
    listDirectory: async () => [],
    pickDirectory: async () => null,
  },
  agent: {
    list: () => [],
    spawn: asyncNoop,
    kill: asyncNoop,
    resume: asyncNoop,
    writeStdin: noop,
    getOutput: async () => '',
    onStatusChange: () => ({ dispose: noop }),
    onStdout: () => ({ dispose: noop }),
  },
  file: {
    readTree: async () => [],
    readFile: async () => '',
    readBinary: async () => '',
    writeFile: asyncNoop,
    stat: async () => ({ size: 0, isDirectory: false, isFile: true, modifiedAt: 0 }),
    rename: asyncNoop,
    copy: asyncNoop,
    mkdir: asyncNoop,
    delete: asyncNoop,
    showInFolder: asyncNoop,
  },
  git: {
    status: async () => [],
    log: async () => [],
    currentBranch: async () => 'main',
    diff: async () => '',
  },
  plugin: {
    startupMarkerRead: async () => null,
    startupMarkerClear: asyncNoop,
    discoverCommunity: async () => [],
    storageRead: async () => undefined,
    storageWrite: asyncNoop,
    storageDelete: asyncNoop,
    storageList: async () => [],
  },
  pty: {
    spawn: asyncNoop,
    write: noop,
    resize: noop,
    kill: asyncNoop,
    getBuffer: async () => '',
    onData: () => ({ dispose: noop }),
    onExit: () => ({ dispose: noop }),
  },
  voice: {
    checkModels: async () => [],
    downloadModels: asyncNoop,
    onDownloadProgress: () => noop,
    transcribe: async () => '',
    startSession: async () => ({ sessionId: '' }),
    sendTurn: asyncNoop,
    onTurnChunk: () => noop,
    onTurnComplete: () => noop,
    endSession: asyncNoop,
  },
  log: {
    write: noop,
  },
});
