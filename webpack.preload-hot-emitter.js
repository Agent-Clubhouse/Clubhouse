// Dev-only stand-in for webpack/hot/emitter.js in the preload bundle (see preloadConfig in forge.config.ts).
// Importing the polyfill by path keeps it out of forge's `events` external, which Electron 45's sandboxed
// preload can no longer satisfy.
var EventEmitter = require('events/events.js');
module.exports = new EventEmitter();
