import type { ContextUpdate, ModuleAnnouncedEvent } from '@proj-airi/server-sdk'

import type { MineflayerWithAgents } from '../cognitive/types'
import type { AiriBridge } from './airi-bridge'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { nanoid } from 'nanoid'

interface MinecraftStatusSnapshot {
  botUsername: string
  gameMode: string
  health: string
  /** The owner's in-game username (from BOT_MASTER_USERNAME), if configured. */
  masterUsername?: string
  otherPlayers: string[]
  position: string
  serverHost: string
  serverPort: number
}

const STATUS_CONTEXT_ID = 'minecraft:status'
const STATUS_LANE = 'minecraft:status'
const STATUS_REFRESH_INTERVAL_MS = 5_000

export class MinecraftContextService {
  private currentSnapshot: MinecraftStatusSnapshot | null = null
  private lastPublishedText = ''
  private readonly masterUsername?: string
  private refreshTimer: null | ReturnType<typeof setInterval> = null
  private runtimeBot: MineflayerWithAgents | null = null
  private readonly serverHost: string
  private readonly serverPort: number

  private unsubscribeModuleAnnounced: (() => void) | null = null

  constructor(private readonly deps: {
    airiBridge: Pick<AiriBridge, 'onModuleAnnounced' | 'sendContextUpdate'>
    masterUsername?: string
    refreshIntervalMs?: number
    serverHost: string
    serverPort: number
  }) {
    this.serverHost = deps.serverHost
    this.serverPort = deps.serverPort
    this.masterUsername = deps.masterUsername
  }

  bindBot(bot: MineflayerWithAgents) {
    this.runtimeBot = bot
    this.refreshStatusSnapshot()
    this.publishStatus({ force: true })

    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
    }

    this.refreshTimer = setInterval(() => {
      this.publishStatus()
    }, this.deps.refreshIntervalMs ?? STATUS_REFRESH_INTERVAL_MS)
  }

  destroy() {
    this.unbindBot()
    this.unsubscribeModuleAnnounced?.()
    this.unsubscribeModuleAnnounced = null
  }

  getStatusSnapshot() {
    return this.currentSnapshot ? { ...this.currentSnapshot, otherPlayers: [...this.currentSnapshot.otherPlayers] } : null
  }

  init() {
    if (this.unsubscribeModuleAnnounced) {
      return
    }

    this.unsubscribeModuleAnnounced = this.deps.airiBridge.onModuleAnnounced((event) => {
      const destinations = collectFrontendDestinations(event)
      if (destinations.length === 0) {
        return
      }

      this.publishStatus({ destinations, force: true })
    })
  }

  publishStatus(options: { destinations?: string[], force?: boolean } = {}) {
    const snapshot = this.refreshStatusSnapshot()
    if (!snapshot) {
      return
    }

    const text = buildStatusText(snapshot)
    if (!options.force && text === this.lastPublishedText) {
      return
    }

    const update: ContextUpdate = {
      contextId: STATUS_CONTEXT_ID,
      hints: [
        'status',
        snapshot.botUsername,
      ],
      id: nanoid(),
      lane: STATUS_LANE,
      strategy: ContextUpdateStrategy.ReplaceSelf,
      text,
    }

    if (options.destinations?.length) {
      update.destinations = options.destinations
    }

    this.deps.airiBridge.sendContextUpdate(update)
    this.lastPublishedText = text
  }

  unbindBot() {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }

    this.runtimeBot = null
    this.currentSnapshot = null
    this.lastPublishedText = ''
  }

  private refreshStatusSnapshot() {
    if (!this.runtimeBot) {
      return this.currentSnapshot
    }

    const otherPlayers = Object.keys(this.runtimeBot.bot.players ?? {})
      .filter(name => name !== this.runtimeBot?.username)
      .sort((left, right) => left.localeCompare(right))

    this.currentSnapshot = {
      botUsername: this.runtimeBot.username,
      gameMode: this.runtimeBot.bot.game?.gameMode ?? 'unknown',
      health: String(this.runtimeBot.bot.health ?? 20),
      masterUsername: this.masterUsername,
      otherPlayers,
      position: toPositionString(this.runtimeBot),
      serverHost: this.serverHost,
      serverPort: this.serverPort,
    }

    return this.currentSnapshot
  }
}

function buildStatusText(snapshot: MinecraftStatusSnapshot) {
  return [
    `Bot online: ${snapshot.botUsername}`,
    `Server: ${snapshot.serverHost}:${snapshot.serverPort}`,
    `Position: ${snapshot.position}`,
    `Health: ${snapshot.health}/20, Mode: ${snapshot.gameMode}`,
    `Other players online: ${snapshot.otherPlayers.length > 0 ? snapshot.otherPlayers.join(', ') : 'none'}`,
    ...(snapshot.masterUsername ? [`Master (your owner) in-game username: ${snapshot.masterUsername}`] : []),
  ].join('\n')
}

function collectFrontendDestinations(event: ModuleAnnouncedEvent) {
  const pluginId = event.identity?.plugin?.id
  const instanceId = event.identity?.id

  if (!pluginId || !instanceId) {
    return []
  }

  return [`instance:${instanceId}`]
}

function toPositionString(bot: MineflayerWithAgents) {
  const position = bot.bot.entity?.position
  return position
    ? `x: ${position.x.toFixed(1)}, y: ${position.y.toFixed(1)}, z: ${position.z.toFixed(1)}`
    : 'unknown'
}
