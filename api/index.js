// Compile Nest with tsc before Vercel bundles it: DI requires decorator metadata.
// The HTTP server export preserves request AND WebSocket upgrade listeners.
module.exports = require('../server/dist/vercel').default;
