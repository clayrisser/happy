/**
 * Entry point: `tsx src/drover/main.ts` (or the `happy drover-bridge`
 * command once wired into the CLI dispatch). Runs the Cattle Drover bridge
 * against the configured Happy server and the local drover bus.
 */

import { runDroverBridge } from './droverBridge'

runDroverBridge().catch((err) => {
    console.error('drover-bridge:', err.message)
    process.exit(1)
})
