// PILOT, never ships. The worker script the contract says a host writes, which is one line.
/* global self */
import { serveScreenshotWorker } from './pilot-vendor/screenshot-editor.mjs';

serveScreenshotWorker(self);
