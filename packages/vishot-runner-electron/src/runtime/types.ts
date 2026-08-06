import type { ElectronApplication, Page } from 'playwright'

import type { StageWindowName, StageWindowSnapshot } from '../utils/windows'

export type ArtifactTransformer = (
  artifact: VishotArtifact,
) => Promise<VishotArtifact | VishotArtifact[]>
export interface CaptureOptions {
  fullPage?: boolean
  transformers?: ArtifactTransformer[]
}

export interface ControlsIslandApi {
  expand: (page: Page) => Promise<void>
  openChat: (page: Page) => Promise<StageWindowSnapshot>
  openHearing: (page: Page) => Promise<Page>
  openSettings: (page: Page) => Promise<StageWindowSnapshot>
  waitForReady: (page: Page) => Promise<void>
}

export interface DialogsApi {
  dismiss: (page: Page) => Promise<void>
}

export interface DrawersApi {
  dismiss: (page: Page) => Promise<void>
  swipeDown: (page: Page) => Promise<void>
}

export interface ElectronScenario {
  id: string
  run: (context: ScenarioContext) => Promise<void>
}

export interface ScenarioContext {
  capture: (name: string, page: Page, options?: CaptureOptions) => Promise<VishotArtifact[]>
  controlsIsland: ControlsIslandApi
  dialogs: DialogsApi
  drawers: DrawersApi
  electronApp: ElectronApplication
  outputDir: string
  settingsWindow: SettingsWindowApi
  stageWindows: StageWindowsApi
}

export interface SettingsWindowApi {
  goToConnection: (page: Page) => Promise<Page>
  goToRoute: (page: Page, routePath: string) => Promise<Page>
  waitFor: (timeout?: number) => Promise<StageWindowSnapshot>
}

export interface StageWindowsApi {
  waitFor: (name: StageWindowName, timeout?: number) => Promise<StageWindowSnapshot>
}

export interface VishotArtifact {
  artifactName: string
  filePath: string
  format: string
  kind: VishotArtifactKind
  metadata?: Record<string, unknown>
  stage: VishotArtifactStage
}

export type VishotArtifactKind = 'image'

export type VishotArtifactStage = 'browser-final' | 'electron-raw'
