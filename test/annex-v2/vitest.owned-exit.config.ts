import { defineConfig } from 'vitest/config';
import type { PoolOptions } from 'vitest/node';
import base from '../../vitest.config';
import { OwnedGracefulForks } from './owned-graceful-forks';

const integration = base.test?.projects?.find((project) => (
  typeof project === 'object' && project !== null && 'test' in project && project.test?.name === 'integration'
));
if (!integration || typeof integration !== 'object' || !('test' in integration) || !integration.test) {
  throw new Error('Owned exit fixture requires the existing integration project');
}

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    projects: [{
      ...integration,
      test: {
        ...integration.test,
        include: ['test/annex-v2/reverse-inventory-worker.test.ts'],
        pool: { name: 'owned-graceful-forks', createPoolWorker: (options: PoolOptions) => new OwnedGracefulForks(options) },
        isolate: true,
        maxWorkers: 1,
        fileParallelism: false,
      },
    }],
  },
});
