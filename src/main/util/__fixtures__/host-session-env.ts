/**
 * Test fixtures: the environment a Claude Code host session leaked into
 * Clubhouse when it was launched from a Claude Code terminal (seen live
 * 2026-10-18), and user Claude configuration that must survive stripping.
 */
export const HOST_SESSION_ENV_FIXTURE: Readonly<Record<string, string>> = {
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop',
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: 'host-session-id',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_HOST_SESSION_ID: 'host-id',
  CLAUDE_PID: '4242',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/host.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'host-token',
  CLAUDE_CODE_EXECPATH: '/host/claude',
  CLAUDE_CODE_DESKTOP_APP_VERSION: '9.9.9',
  CLAUDE_CODE_OAUTH_SCOPES: 'user:inference',
  CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: '1',
  CLAUDE_CODE_ORGANIZATION_UUID: 'org-uuid',
  CLAUDE_CODE_ACCOUNT_UUID: 'account-uuid',
  CLAUDE_CODE_USER_EMAIL: 'host@example.test',
  CLAUDE_CODE_TERMINAL_MCP_TOOLS: '1',
  CLAUDE_CODE_REPORT_FINDINGS: '1',
  CLAUDE_CODE_STARTUP_FAILURE_RESULTS: '1',
  CLAUDE_CODE_EMIT_TOOL_USE_SUMMARIES: '1',
  CLAUDE_CODE_ENABLE_ASK_USER_QUESTION_TOOL: '1',
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: '1',
  CLAUDE_CODE_SIMPLE: '1',
  CLAUDE_CODE_DISABLE_CRON: '1',
  CLAUDE_CODE_EAGER_FLUSH: '1',
  CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING: 'true',
  CLAUDE_AGENT_SDK_MCP_NO_PREFIX: '1',
  CLAUDE_AGENT_SDK_VERSION: '0.0.1',
  CLAUDE_PREVIEW_CLASSIFIER_FLOOR: '1',
  CLAUDE_EFFORT: 'max',
};

export const USER_CLAUDE_CONFIG_FIXTURE: Readonly<Record<string, string>> = {
  CLAUDE_CONFIG_DIR: '/profiles/work/.claude',
  ANTHROPIC_API_KEY: 'sk-test-key',
  ANTHROPIC_BASE_URL: 'https://gateway.example.test',
  CLAUDE_CODE_USE_BEDROCK: '1',
  CLAUDE_CODE_USE_VERTEX: '1',
  CLOUD_ML_REGION: 'us-east5',
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64000',
  HTTPS_PROXY: 'http://proxy.example.test:8080',
};
