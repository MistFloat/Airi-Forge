/**
 * Default heartbeat read timeout.
 *
 * Client ping interval is readTimeout/2 (default 15s), so 60s left little room
 * for timer throttling (hidden windows, busy event loops): one missed window
 * kicked the peer with close code 1006. 120s keeps a safe margin while still
 * detecting dead peers within ~2 minutes.
 */
export const serverWsDefaultHeartbeatTtlMs = 120_000

/** Number of liveness checks scheduled within one heartbeat TTL. */
export const serverWsHealthCheckIntervalDivisor = 5

/** Minimum interval to avoid busy liveness loops. */
export const serverWsMinimumHealthCheckIntervalMs = 5_000

/** Resolves the AIRI heartbeat health-check interval in milliseconds. */
export function resolveHealthCheckIntervalMs(heartbeatTtlMs: number) {
  return Math.max(serverWsMinimumHealthCheckIntervalMs, Math.floor(heartbeatTtlMs / serverWsHealthCheckIntervalDivisor))
}
