// For vite-node run from the root (the development tools under tools/ that import the engine):
// the engine's programs need core/overlays.mjs, as in core's and ui's own configurations.
import { programOverlays } from './core/overlays.mjs';

export default { plugins: [programOverlays()] };
