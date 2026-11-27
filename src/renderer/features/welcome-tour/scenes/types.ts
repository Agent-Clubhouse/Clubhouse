import type { ComponentType } from 'react';
import type { WelcomeTourVariant } from '../../../../shared/welcome-tour';
import type { ScenePlay } from '../scene-engine';

/** One scene of the tour: its words, an optional row of actions, and its picture. */
export interface SceneDef {
  title: string | ((variant: WelcomeTourVariant) => string);
  /** A first paragraph in the stronger text color (the upgraders' thank-you). */
  lead?: string;
  text: string;
  /** Links and buttons under the text. Each one closes the tour and goes somewhere. */
  Extra?: ComponentType;
  /** The picture, drawn on the 740 by 300 stage. None means the step is words only. */
  Stage?: ComponentType;
  /** A stage that grows with its content instead of the fixed picture size. */
  tall?: boolean;
  /** What moves, once the stage is drawn. */
  play?: ScenePlay;
}
