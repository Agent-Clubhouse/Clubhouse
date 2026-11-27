import { Button } from '../../../components/Button';
import { openDispatcherSetupFromTour } from '../tour-actions';
import type { SceneDef } from './types';

/**
 * The Dispatcher. Its button opens the Dispatcher's own setup (#3047), which
 * still owns the first real conversation. Opening it wakes nothing and spends
 * no tokens; that waits until you send something.
 */

function DispatcherExtra() {
  return (
    <div className="wt-x">
      <Button onClick={openDispatcherSetupFromTour}>Set it up now</Button>
      <span className="wt-muted">Pick its name, look and personality.</span>
    </div>
  );
}

export const dispatcher: SceneDef = {
  title: 'Meet the Dispatcher',
  text: 'Tell it what you want in plain words. It keeps track of what your agents are doing, gets work going across your projects, sets things up to happen on a schedule, and remembers what you decide. It only reaches agents you connect to it.',
  Extra: DispatcherExtra,
};
