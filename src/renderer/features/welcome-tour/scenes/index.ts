import type { TourScene } from '../tour-model';
import type { SceneDef } from './types';
import { welcomeNew, welcomeUpgrade } from './welcome';
import { alsoNew } from './also-new';
import { getStarted } from './get-started';
import { compose, share, skills, switched, updates } from './managed';
import { dispatcher } from './dispatcher';
import { orch } from './orchestrators';
import { smartRouting } from './smart-routing';

export type { SceneDef } from './types';

export const SCENES: Record<TourScene, SceneDef> = {
  'welcome-new': welcomeNew,
  'welcome-upgrade': welcomeUpgrade,
  switched,
  compose,
  skills,
  updates,
  share,
  dispatcher,
  orch,
  'smart-routing': smartRouting,
  alsonew: alsoNew,
  start: getStarted,
};
