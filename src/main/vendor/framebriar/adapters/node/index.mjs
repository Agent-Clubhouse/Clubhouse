// Framebriar SDK for Node/Electron main processes. Zero npm dependencies; Electron APIs
// (safeStorage, webContents.capturePage, net.isOnline) are injected by the host, never imported.
import {join} from 'node:path';
import {createSecureStore} from './secure-store.mjs';
import {createAccess,FRAMEBRIAR_ENDPOINT} from './access.mjs';
import {createOutbox} from './outbox.mjs';
import {createTelemetry} from './telemetry.mjs';
import {createFeedback} from './feedback.mjs';

export {createSecureStore,secureStorageAvailability,SecureStoreError} from './secure-store.mjs';
export {createAccess,FRAMEBRIAR_ENDPOINT,validEndpoint} from './access.mjs';
export {createOutbox} from './outbox.mjs';
export {sendReport,FeedbackDeliveryError} from './transport.mjs';
export {createTelemetry,EXCERPT_LIMITS,NODE_TELEMETRY_SDK_VERSION} from './telemetry.mjs';
export {createFeedback} from './feedback.mjs';
export {createFileLock} from './files.mjs';
export {otlpExporterOptions,otlpEndpoint} from '../browser/otel-exporter.mjs';

// One-call wiring. dataDir is app-private (e.g. join(app.getPath('userData'), 'framebriar')).
// telemetry: 'continuous' | 'excerpt-only' | 'off'.
export function createFramebriar({safeStorage,dataDir,appId,appVersion,buildSha=null,endpoint=FRAMEBRIAR_ENDPOINT,
  telemetry:telemetryMode='continuous',capture,fetchImpl,isOnline,captureErrors=false,now,onAccessChange,onOutboxChange,onReceipt}={}){
  if(typeof dataDir!=='string'||!dataDir)throw Error('createFramebriar requires dataDir');
  const opts=x=>Object.fromEntries(Object.entries(x).filter(([,v])=>v!==undefined));
  const store=createSecureStore({safeStorage,file:join(dataDir,'enrollment.json'),scope:`${endpoint}|${appId}`});
  const access=createAccess(opts({endpoint,appId,buildSha,store,fetchImpl,now,onChange:onAccessChange}));
  const outbox=createOutbox(opts({dir:join(dataDir,'outbox'),access,fetchImpl,now,isOnline,onChange:onOutboxChange,onReceipt}));
  const telemetry=telemetryMode==='off'?undefined:createTelemetry(opts({access,buildSha,mode:telemetryMode,fetchImpl,now,captureErrors}));
  const feedback=createFeedback(opts({access,outbox,telemetry,capture,buildSha,appVersion,now}));
  return Object.freeze({store,access,outbox,telemetry,feedback,
    // Access restores first so queued reports get a token; storage starts regardless.
    async start(){await access.start().catch(()=>{});await outbox.start().catch(()=>{});},
    async shutdown(){await telemetry?.shutdown();outbox.dispose();access.stop();access.dispose();},
  });
}
