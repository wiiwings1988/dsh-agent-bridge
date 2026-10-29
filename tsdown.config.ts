import { clientBundle } from './shared/tsdown.client.ts'

/** Host half from src/index.ts, browser half from src/client/index.ts; the preset owns both. */
export default clientBundle('dsh-agent-bridge', ['src/index.ts'])
