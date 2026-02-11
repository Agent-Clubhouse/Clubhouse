export const IPC = {
  PTY: {
    SPAWN: 'pty:spawn',
    WRITE: 'pty:write',
    RESIZE: 'pty:resize',
    KILL: 'pty:kill',
    DATA: 'pty:data',
    EXIT: 'pty:exit',
  },
  PROJECT: {
    LIST: 'project:list',
    ADD: 'project:add',
    REMOVE: 'project:remove',
    PICK_DIR: 'project:pick-dir',
    CHECK_GIT: 'project:check-git',
    GIT_INIT: 'project:git-init',
  },
  AGENT: {
    CREATE_DURABLE: 'agent:create-durable',
    LIST_DURABLE: 'agent:list-durable',
    DELETE_DURABLE: 'agent:delete-durable',
    GET_SETTINGS: 'agent:get-settings',
    SAVE_SETTINGS: 'agent:save-settings',
  },
  FILE: {
    READ_TREE: 'file:read-tree',
    READ: 'file:read',
    WRITE: 'file:write',
  },
  GIT: {
    INFO: 'git:info',
    CHECKOUT: 'git:checkout',
    STAGE: 'git:stage',
    UNSTAGE: 'git:unstage',
    COMMIT: 'git:commit',
    PUSH: 'git:push',
    PULL: 'git:pull',
  },
  WATCH: {
    START: 'watch:start',
    STOP: 'watch:stop',
    EVENT: 'watch:event',
  },
} as const;
