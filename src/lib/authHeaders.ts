// src/lib/authHeaders.ts
// Per-request key headers (B1: keys live browser-side via settingsStore → IDB).
//   X-Mivo-Api-Key  — mivo_ MCP key. Drives BFF platform ctx + per-key token
//                      bucketing (server/lib/keys.ts resolvePlatformCtx + state.ts).
//   X-Gateway-Key   — sk- gateway key. Drives llm-proxy calls (enhance /
//                      describe-region / compose-mask-edit via resolveGatewayKey).
// Both absent → BFF falls back to env (MIVO_PLATFORM_KEY / MIVO_LLM_API_KEY) so
// legacy single-deployment env-key configs keep working. Reading getState() per
// call (not a hook) keeps this usable from non-component call sites + always
// reflects the latest persisted key.
import { useSettingsStore } from '../store/settingsSlice'

export const MIVO_API_KEY_HEADER = 'X-Mivo-Api-Key'
export const GATEWAY_KEY_HEADER = 'X-Gateway-Key'

export const authHeaders = (): Record<string, string> => {
  const { mivoKey, gatewayKey } = useSettingsStore.getState()
  const headers: Record<string, string> = {}
  if (mivoKey) headers[MIVO_API_KEY_HEADER] = mivoKey
  if (gatewayKey) headers[GATEWAY_KEY_HEADER] = gatewayKey
  return headers
}
