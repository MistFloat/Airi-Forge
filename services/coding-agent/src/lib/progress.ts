import type { ProgressNotification } from '@modelcontextprotocol/sdk/types.js'

export interface ProgressExtra {
  _meta?: { progressToken?: number | string }
  sendNotification: (notification: ProgressNotification) => Promise<void>
}

/**
 * Sink for reporting MCP `notifications/progress` to the requesting client.
 *
 * Created per tool call; returns `undefined` when the client did not attach a
 * `progressToken`, in which case callers simply skip progress reporting.
 */
export interface ProgressSink {
  report: (params: Omit<ProgressNotification['params'], 'progressToken'>) => Promise<void>
}

export function createProgressSink(extra: ProgressExtra): ProgressSink | undefined {
  const progressToken = extra._meta?.progressToken
  if (progressToken === undefined)
    return undefined
  return {
    async report(params) {
      await extra.sendNotification({
        method: 'notifications/progress',
        params: { progressToken, ...params },
      })
    },
  }
}
