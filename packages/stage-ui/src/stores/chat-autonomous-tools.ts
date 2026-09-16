import type { Tool } from '@xsai/shared-chat'

/** Resolves the platform toolset for an autonomous ordinary follow-up turn. */
export type ChatAutonomousToolsResolver = () => Promise<Tool[]>

let activeResolver: ChatAutonomousToolsResolver | undefined

/** Installs the platform tool resolver with ownership-safe cleanup. */
export function configureChatAutonomousToolsResolver(resolver?: ChatAutonomousToolsResolver) {
  activeResolver = resolver
  return () => {
    if (activeResolver === resolver)
      activeResolver = undefined
  }
}

/** Resolves tools lazily at model dispatch so MCP/plugin state stays current. */
export async function resolveChatAutonomousTools(): Promise<Tool[]> {
  return activeResolver ? await activeResolver() : []
}
