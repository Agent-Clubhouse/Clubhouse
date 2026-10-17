// Optional: route an app's existing OpenTelemetry SDK through Framebriar (docs/telemetry.md,
// "Bring your own OpenTelemetry"). Works with the browser and Node/Electron access controllers.
// Pure helper: no DOM, no OTel dependency. Apps that only use screenshot feedback ignore it.
//
//   new OTLPTraceExporter(otlpExporterOptions(access, 'traces'))
//   new OTLPLogExporter(otlpExporterOptions(access, 'logs'))
//   new OTLPMetricExporter({...otlpExporterOptions(access, 'metrics'), temporalityPreference: DELTA})
const SIGNALS=['traces','logs','metrics'];
export function otlpEndpoint(access,signal){
  if(!SIGNALS.includes(signal))throw Error('signal must be traces, logs or metrics');
  const endpoint=access?.endpoint;
  if(typeof endpoint!=='string'||!/^https?:\/\//.test(endpoint))throw Error('Framebriar access controller with an endpoint required');
  return `${endpoint.replace(/\/$/,'')}/v1/otlp/v1/${signal}`;
}
// headers is an async factory, so each export uses the current (≤ 1 hour) enrolled token.
// Not enrolled → no Authorization header → the gateway answers 401 and the exporter drops that batch.
export function otlpExporterOptions(access,signal){
  if(typeof access?.getToken!=='function')throw Error('Framebriar access controller required');
  return {url:otlpEndpoint(access,signal),headers:async()=>{
    let token;try{token=await access.getToken();}catch{token=undefined;}
    return typeof token==='string'&&token?{authorization:`Bearer ${token}`}:{};
  }};
}
