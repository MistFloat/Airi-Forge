import type { Card, ccv3 } from '@proj-airi/ccc'

import { useLocalStorageManualReset } from '@proj-airi/stage-shared/composables'
import { watchDebounced } from '@vueuse/core'
import { nanoid } from 'nanoid'
import { defineStore, storeToRefs } from 'pinia'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { DEFAULT_ARTISTRY_WIDGET_SPAWNING_PROMPT } from '../../constants/prompts/character-defaults'
import { capturePosthogEvent } from '../analytics/posthog'
import { useSettingsStageModel } from '../settings/stage-model'
import { useArtistryStore } from './artistry'
import { useConsciousnessStore } from './consciousness'
import { useSpeechStore } from './speech'
import { useVisionStore } from './vision'

export interface AiriCard extends Card {
  extensions: Card['extensions'] & {
    airi: AiriExtension
  }
}

export interface AiriExtension {
  agents: {
    [key: string]: { // example: minecraft
      enabled?: boolean
      prompt: string
    }
  }

  modules: {
    activeBackgroundId?: string

    artistry?: {
      autonomousEnabled?: boolean
      autonomousTarget?: 'assistant' | 'user'
      autonomousThreshold?: number
      enabled?: boolean
      model?: string
      options?: Record<string, any>
      promptPrefix?: string
      provider?: string
      spawnMode?: 'bg' | 'bg_widget' | 'inline' | 'widget'
      widgetInstruction?: string
      workflowId?: string
    }

    consciousness: {
      model: string // Example: "gpt-4o"
      provider: string // Example: "openai"
    }

    // ID from display-models store (e.g. 'preset-live2d-1', 'display-model-<nanoid>')
    displayModelId?: string

    live2d?: {
      file?: string // Example: "live2d/model.json"
      source?: 'file' | 'url'
      url?: string // Example: "https://example.com/live2d/model.json"
    }

    speech: {
      language?: string
      model: string // Example: "eleven_multilingual_v2"
      pitch?: number

      provider: string // Example: "elevenlabs"
      rate?: number
      ssml?: boolean
      voice_id: string // Example: "alloy"
    }
    vision: {
      model: string // Example: "llava"
      provider: string // Example: "ollama"
    }

    vrm?: {
      file?: string // Example: "vrm/model.vrm"
      source?: 'file' | 'url'
      url?: string // Example: "https://example.com/vrm/model.vrm"
    }
  }
}

export const useAiriCardStore = defineStore('airi-card', () => {
  const { t } = useI18n()

  const cards = useLocalStorageManualReset<Map<string, AiriCard>>('airi-cards', new Map())
  const activeCardId = useLocalStorageManualReset<string>('airi-card-active-id', 'default')

  const activeCard = computed(() => cards.value.get(activeCardId.value))

  const consciousnessStore = useConsciousnessStore()
  const visionStore = useVisionStore()
  const speechStore = useSpeechStore()
  const artistryStore = useArtistryStore()
  const stageModelStore = useSettingsStageModel()

  const {
    activeModel: activeConsciousnessModel,
    activeProvider: activeConsciousnessProvider,
  } = storeToRefs(consciousnessStore)

  const {
    activeModel: activeVisionModel,
    activeProvider: activeVisionProvider,
  } = storeToRefs(visionStore)

  const {
    activeSpeechModel,
    activeSpeechProvider,
    activeSpeechVoiceId,
  } = storeToRefs(speechStore)

  /**
   * `source` feeds the `card_created` analytics event: `scratch` = built in
   * the creation dialog, `import` = ccv3 JSON upload, `duplicate` = cloned
   * from an existing card (profile switcher). Required so a new call site
   * can't silently degrade creation attribution.
   */
  const addCard = (card: AiriCard | Card | ccv3.CharacterCardV3, source: 'duplicate' | 'import' | 'scratch') => {
    const newCardId = nanoid()
    cards.value.set(newCardId, newAiriCard(card))
    capturePosthogEvent('card_created', { card_id: newCardId, source })
    return newCardId
  }

  const removeCard = (id: string) => {
    cards.value.delete(id)
    capturePosthogEvent('character_deleted', { character_id: id })
  }

  const updateCard = (id: string, updates: AiriCard | Card | ccv3.CharacterCardV3) => {
    const existingCard = cards.value.get(id)
    if (!existingCard)
      return false

    const updatedCard = {
      ...existingCard,
      ...updates,
    }

    cards.value.set(id, newAiriCard(updatedCard))
    return true
  }

  const getCard = (id: string) => {
    return cards.value.get(id)
  }

  function updateActiveCardModules(patch: (extension: AiriExtension) => Partial<AiriExtension['modules']>) {
    const cardId = activeCardId.value
    const card = cards.value.get(cardId)
    if (!card)
      return false

    const extension = resolveAiriExtension(card)
    cards.value.set(cardId, {
      ...card,
      extensions: {
        ...card.extensions,
        airi: {
          ...extension,
          modules: {
            ...extension.modules,
            ...patch(extension),
          },
        },
      },
    })

    return true
  }

  function updateActiveCardDisplayModel(displayModelId: string | undefined) {
    return updateActiveCardModules(() => ({ displayModelId }))
  }

  function updateActiveCardConsciousness(consciousness: AiriExtension['modules']['consciousness']) {
    return updateActiveCardModules(() => ({ consciousness }))
  }

  function updateActiveCardVision(vision: AiriExtension['modules']['vision']) {
    return updateActiveCardModules(() => ({ vision }))
  }

  function updateActiveCardSpeech(speech: Pick<AiriExtension['modules']['speech'], 'model' | 'provider' | 'voice_id'>) {
    return updateActiveCardModules(({ modules }) => ({
      speech: {
        ...modules.speech,
        ...speech,
      },
    }))
  }

  function resolveAiriExtension(card: Card | ccv3.CharacterCardV3): AiriExtension {
    // Get existing extension if available
    const existingExtension = ('data' in card
      ? card.data?.extensions?.airi
      : card.extensions?.airi) as AiriExtension

    // Create default modules config
    const defaultModules = {
      artistry: {
        autonomousEnabled: false,
        autonomousTarget: 'assistant' as const,
        autonomousThreshold: 70,
        enabled: false,
        model: artistryStore.globalModel,
        options: artistryStore.globalProviderOptions,
        promptPrefix: artistryStore.globalPromptPrefix,
        provider: artistryStore.globalProvider,
        spawnMode: 'bg_widget' as const,
        widgetInstruction: DEFAULT_ARTISTRY_WIDGET_SPAWNING_PROMPT,
      },
      consciousness: {
        model: activeConsciousnessModel.value,
        provider: activeConsciousnessProvider.value,
      },
      displayModelId: stageModelStore.stageModelSelected,
      speech: {
        model: activeSpeechModel.value,
        provider: activeSpeechProvider.value,
        voice_id: activeSpeechVoiceId.value,
      },
      vision: {
        model: activeVisionModel.value,
        provider: activeVisionProvider.value,
      },
    } as const

    // Return default if no extension exists
    if (!existingExtension) {
      return {
        agents: {},
        modules: defaultModules,
      }
    }

    // Merge existing extension with defaults
    return {
      agents: existingExtension.agents ?? {},
      modules: {
        activeBackgroundId: existingExtension.modules?.activeBackgroundId,
        artistry: {
          autonomousEnabled: existingExtension.modules?.artistry?.autonomousEnabled ?? (existingExtension as any).artistry?.autonomousEnabled ?? defaultModules.artistry.autonomousEnabled,
          autonomousTarget: existingExtension.modules?.artistry?.autonomousTarget ?? (existingExtension as any).artistry?.autonomousTarget ?? defaultModules.artistry.autonomousTarget,
          autonomousThreshold: existingExtension.modules?.artistry?.autonomousThreshold ?? (existingExtension as any).artistry?.autonomousThreshold ?? defaultModules.artistry.autonomousThreshold,
          enabled: existingExtension.modules?.artistry?.enabled ?? (existingExtension as any).artistry?.enabled ?? defaultModules.artistry.enabled,
          model: existingExtension.modules?.artistry?.model ?? (existingExtension as any).artistry?.model ?? defaultModules.artistry.model,
          options: existingExtension.modules?.artistry?.options ?? (existingExtension as any).artistry?.options ?? defaultModules.artistry.options,
          promptPrefix: existingExtension.modules?.artistry?.promptPrefix ?? (existingExtension as any).artistry?.promptPrefix ?? (existingExtension as any).artistry?.prompt_prefix ?? defaultModules.artistry.promptPrefix,
          provider: existingExtension.modules?.artistry?.provider ?? (existingExtension as any).artistry?.provider ?? defaultModules.artistry.provider,
          spawnMode: existingExtension.modules?.artistry?.spawnMode ?? (existingExtension as any).artistry?.spawnMode ?? defaultModules.artistry.spawnMode,
          widgetInstruction: existingExtension.modules?.artistry?.widgetInstruction ?? (existingExtension as any).artistry?.widgetInstruction ?? defaultModules.artistry.widgetInstruction,
          workflowId: existingExtension.modules?.artistry?.workflowId ?? (existingExtension as any).artistry?.workflowId ?? (existingExtension as any).artistry?.remixId,
        },
        consciousness: {
          model: existingExtension.modules?.consciousness?.model ?? defaultModules.consciousness.model,
          provider: existingExtension.modules?.consciousness?.provider ?? defaultModules.consciousness.provider,
        },
        displayModelId: existingExtension.modules?.displayModelId ?? defaultModules.displayModelId,
        live2d: existingExtension.modules?.live2d,
        speech: {
          language: existingExtension.modules?.speech?.language,
          model: existingExtension.modules?.speech?.model ?? defaultModules.speech.model,
          pitch: existingExtension.modules?.speech?.pitch,
          provider: existingExtension.modules?.speech?.provider ?? defaultModules.speech.provider,
          rate: existingExtension.modules?.speech?.rate,
          ssml: existingExtension.modules?.speech?.ssml,
          voice_id: existingExtension.modules?.speech?.voice_id ?? defaultModules.speech.voice_id,
        },
        vision: {
          model: existingExtension.modules?.vision?.model ?? defaultModules.vision.model,
          provider: existingExtension.modules?.vision?.provider ?? defaultModules.vision.provider,
        },
        vrm: existingExtension.modules?.vrm,
      },
    }
  }

  function newAiriCard(card: Card | ccv3.CharacterCardV3): AiriCard {
    // Handle ccv3 format if needed
    if ('data' in card) {
      const ccv3Card = card as ccv3.CharacterCardV3
      return {
        creator: ccv3Card.data.creator ?? '',
        description: ccv3Card.data.description ?? '',
        extensions: {
          airi: resolveAiriExtension(ccv3Card),
          ...ccv3Card.data.extensions,
        },
        greetings: [
          ccv3Card.data.first_mes,
          ...(ccv3Card.data.alternate_greetings ?? []),
        ],
        greetingsGroupOnly: ccv3Card.data.group_only_greetings ?? [],
        messageExample: ccv3Card.data.mes_example
          ? ccv3Card.data.mes_example
              .split('<START>\n')
              .filter(Boolean)
              .map(example => example.split('\n')
                .map((line) => {
                  if (line.startsWith('{{char}}:') || line.startsWith('{{user}}:'))
                    return line as `{{char}}: ${string}` | `{{user}}: ${string}`
                  throw new Error(`Invalid message example format: ${line}`)
                }))
          : [],
        name: ccv3Card.data.name,
        notes: ccv3Card.data.creator_notes ?? '',
        notesMultilingual: ccv3Card.data.creator_notes_multilingual,
        personality: ccv3Card.data.personality ?? '',
        postHistoryInstructions: ccv3Card.data.post_history_instructions ?? '',
        scenario: ccv3Card.data.scenario ?? '',
        systemPrompt: ccv3Card.data.system_prompt ?? '',
        tags: ccv3Card.data.tags ?? [],
        version: ccv3Card.data.character_version ?? '1.0.0',
      }
    }

    return {
      ...card,
      extensions: {
        airi: resolveAiriExtension(card),
        ...card.extensions,
      },
    }
  }

  function initialize() {
    if (cards.value.has('default'))
      return
    // The default card keeps only the persona description. The ACT/DELAY/CALL
    // streaming-control instructions moved out of the card into the persisted
    // default instruction seed (see memory-long-term), so developers can edit
    // the filter/action policy in one place instead of per-card.
    cards.value.set('default', newAiriCard({
      description: t('base.prompt.prefix'),
      name: 'ReLU',
      version: '1.0.0',
    }))
    if (!activeCardId.value)
      activeCardId.value = 'default'
  }

  watchDebounced(activeCard, (newCard: AiriCard | undefined) => {
    artistryStore.resetToGlobal()

    if (!newCard)
      return

    // TODO: Minecraft Agent, etc
    const extension = resolveAiriExtension(newCard)
    if (!extension)
      return

    activeConsciousnessProvider.value = extension?.modules?.consciousness?.provider
    activeConsciousnessModel.value = extension?.modules?.consciousness?.model

    activeVisionProvider.value = extension?.modules?.vision?.provider
    activeVisionModel.value = extension?.modules?.vision?.model

    activeSpeechProvider.value = extension?.modules?.speech?.provider
    activeSpeechModel.value = extension?.modules?.speech?.model
    activeSpeechVoiceId.value = extension?.modules?.speech?.voice_id

    // Apply body model if the card has a display model configured.
    // NOTICE: must set via store property directly (not storeToRefs .value) so Pinia's
    // proxy correctly calls the writable computed setter → stageModelSelectedState → updateStageModel().
    if (extension.modules?.displayModelId) {
      stageModelStore.stageModelSelected = extension.modules.displayModelId
    }

    if (extension.modules?.artistry) {
      if (extension.modules.artistry.provider)
        artistryStore.activeProvider = extension.modules.artistry.provider
      if (extension.modules.artistry.model)
        artistryStore.activeModel = extension.modules.artistry.model
      if (extension.modules.artistry.promptPrefix)
        artistryStore.defaultPromptPrefix = extension.modules.artistry.promptPrefix
      if (extension.modules.artistry.options)
        artistryStore.providerOptions = extension.modules.artistry.options
    }
  }, { debounce: 300, maxWait: 1000 })

  function resetState() {
    activeCardId.reset()
    cards.reset()
  }

  return {
    activeCard,
    activeCardId,
    addCard,
    cards,
    currentModels: computed(() => {
      return {
        activeBackgroundId: activeCard.value?.extensions?.airi?.modules?.activeBackgroundId,
        consciousness: {
          model: activeConsciousnessModel.value,
          provider: activeConsciousnessProvider.value,
        },
        displayModelId: stageModelStore.stageModelSelected,
        speech: {
          model: activeSpeechModel.value,
          provider: activeSpeechProvider.value,
          voice_id: activeSpeechVoiceId.value,
        },
        vision: {
          model: activeVisionModel.value,
          provider: activeVisionProvider.value,
        },
      } satisfies AiriExtension['modules']
    }),
    getCard,
    initialize,
    removeCard,
    resetState,
    systemPrompt: computed(() => {
      const card = activeCard.value
      if (!card)
        return ''

      const components = [
        card.systemPrompt,
        card.description,
        card.personality,
        card.extensions?.airi?.modules?.artistry?.widgetInstruction,
      ].filter(Boolean)

      return components.join('\n\n')
    }),
    updateActiveCardConsciousness,
    updateActiveCardDisplayModel,
    updateActiveCardSpeech,

    updateActiveCardVision,

    updateCard,
  }
})
