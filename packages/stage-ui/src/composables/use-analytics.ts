import posthog from 'posthog-js'

import { isStageCapacitor, isStageTamagotchi } from '@proj-airi/stage-shared'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { useSharedAnalyticsStore } from '../stores/analytics'
import { ensurePosthogInitialized, isPosthogAvailableInBuild } from '../stores/analytics/posthog'
import { getAnalyticsPrivacyPolicyUrl } from '../stores/analytics/privacy-policy'
import { useSettingsAnalytics } from '../stores/settings/analytics'
import { useSettingsGeneral } from '../stores/settings/general'

export type ChatActivationFailureStage = 'llm_response' | 'message_send' | 'model_list' | 'provider_config' | 'tts'

/**
 * Low-cardinality source names for conversation action events.
 */
export type ConversationAnalyticsSource = 'chat_controls' | 'history' | 'sessions_drawer'

/**
 * User-facing chat surfaces that can emit product analytics.
 */
export type ConversationAnalyticsSurface = 'electron' | 'mobile' | 'web'
export type ConversationEventSource = 'fork' | 'history' | 'new_session' | 'share_button' | 'unknown'
export type FeedbackCategory = 'chat_activation' | 'crash' | 'desktop_window' | 'live2d' | 'mobile' | 'model_list' | 'payment' | 'performance' | 'provider_config' | 'tts' | 'ui_ux' | 'unknown' | 'update' | 'voice_input'
export type FeedbackDescriptionLengthBucket = 'empty' | 'long' | 'medium' | 'short'
export type FeedbackSeverity = 'blocker' | 'major' | 'minor' | 'suggestion'
export type FeedbackSource = 'app' | 'discord' | 'email' | 'github' | 'other' | 'qq'
export type FeedbackUserType = 'developer_user' | 'new_user' | 'overseas_user' | 'paid_user' | 'role_chat_user' | 'unknown'
export type FluxBalanceBucket = '1_100' | '101_1000' | '1001_10000' | '10000_plus' | 'unknown' | 'zero'
export type MessageInputMode = 'text' | 'voice'
/**
 * Full stage vocabulary of the cross-surface `oauth_callback_failed` event.
 * The web/PKCE stages fire from `pages/auth/callback.vue`; the electron
 * relay stages fire from ui-server-auth's `electron-callback.vue`, which
 * imports this type so the two emitters can't drift apart silently.
 */
export type OauthCallbackFailureStage
  = | 'missing_code_or_state'
    | 'missing_flow_state'
    | 'parse'
    | 'provider_error'
    | 'relay_unreachable'
    | 'token_exchange_failed'
export type OfficialProviderSelectionSource = 'default_auto' | 'onboarding' | 'settings'
export type OfficialTtsExposureSource = 'chat_controls' | 'onboarding' | 'post_first_chat' | 'settings'
export type ProductAnalyticsEntry = 'app_start' | 'chat' | 'onboarding' | 'pricing' | 'quota_banner' | 'settings' | 'unknown'
export type ProviderConfigStep = 'manual_chat_ping' | 'onboarding_validate' | 'settings_auto_validate'
export type ProviderMode = 'custom' | 'official' | 'unknown'
export type VoiceAnalyticsSource = 'chat_auto_tts' | 'manual_preview' | 'onboarding' | 'settings'

export type VoiceType = 'custom_configured' | 'official_default' | 'official_selected' | 'unknown' | 'voice_pack'

interface ChatActivationBaseProperties extends ChatRoundCorrelationProperties {
  model_id: string
  provider_id: string
  provider_mode: ProviderMode
  source: MessageInputMode
}

interface ChatRoundCorrelationProperties {
  conversation_id: string
  round_id: string
  turn_index: number
}

interface ConversationBaseProperties {
  conversation_id: string
  model: string
  provider_name: string
  provider_type: ProviderMode
}

interface FeedbackBaseProperties {
  category: FeedbackCategory
  entrypoint: string
  severity: FeedbackSeverity
  source: FeedbackSource
  user_type: FeedbackUserType
}

interface OfficialTtsBaseProperties {
  source: OfficialTtsExposureSource
  tts_model_id: string
  tts_provider_id: string
}

interface OnboardingProviderProperties {
  selected_provider_id?: string
  selected_provider_type: ProviderMode
  selected_use_case?: string
}

interface ProviderConfigBaseProperties {
  provider_id: string
  provider_mode: ProviderMode
  step: ProviderConfigStep
}

interface TtsVoiceBaseProperties {
  source: VoiceAnalyticsSource
  tts_model_id: string
  tts_provider_id: string
}

interface VoiceInputBaseProperties {
  duration_ms?: number
  stt_provider_id: string
}

export function useAnalytics() {
  const analyticsStore = useSharedAnalyticsStore()
  const settingsAnalytics = useSettingsAnalytics()
  const settingsGeneral = useSettingsGeneral()
  const { locale } = useI18n()

  const privacyPolicyUrl = computed(() => getAnalyticsPrivacyPolicyUrl(locale.value || settingsGeneral.language))

  const isAnalyticsEnabled = computed(() => isPosthogAvailableInBuild() && settingsAnalytics.analyticsEnabled)

  function canCapture(): boolean {
    if (!isAnalyticsEnabled.value)
      return false

    // Ensure PostHog is initialized before any capture call.
    return ensurePosthogInitialized(true)
  }

  function trackProviderClick(providerId: string, module: string) {
    if (!canCapture())
      return

    posthog.capture('provider_card_clicked', {
      module,
      provider_id: providerId,
    })
  }

  function trackFirstMessage() {
    if (!canCapture())
      return

    // Only track the first message once
    if (analyticsStore.firstMessageTracked)
      return

    analyticsStore.markFirstMessageTracked()

    // Calculate time from app start to message sent
    const timeToFirstMessageMs = analyticsStore.appStartTime
      ? Date.now() - analyticsStore.appStartTime
      : null

    posthog.capture('first_message_sent', {
      time_to_first_message_ms: timeToFirstMessageMs,
    })
  }

  /**
   * Pricing funnel — step 1.
   *
   * Use when:
   * - Any UI surface that shows Flux packages / subscription plans renders.
   *   Current surfaces: `settings_flux` (in-app billing settings). Future
   *   surfaces (a public pricing landing page, an upsell modal) just pass a
   *   different `entry_surface` so the funnel split stays clean.
   *
   * Expects:
   * - `entry_surface` is a stable identifier — don't rename without coordinating
   *   PostHog funnel definitions in `docs/ai-context/metrics-ownership.md`.
   */
  function trackPricingViewed(entrySurface: string, planPeriod?: 'annual' | 'monthly' | 'one_time') {
    if (!canCapture())
      return
    posthog.capture('pricing_page_viewed', { entry_surface: entrySurface, ...(planPeriod && { plan_period: planPeriod }) })
  }

  /**
   * Pricing funnel — step 2. Fires when the user picks a plan/package but
   * hasn't yet kicked off the Stripe checkout redirect.
   */
  function trackPlanSelected(planId: string, properties: { currency?: string, entry_surface: string, price_minor_unit?: number }) {
    if (!canCapture())
      return
    posthog.capture('plan_selected', { plan_id: planId, ...properties })
  }

  /**
   * Pricing funnel — step 3. Fires right before redirecting to Stripe
   * checkout (i.e. the SPA has the `checkout_session_id` and is about to
   * `window.location.href = data.url`).
   *
   * Expects:
   * - Caller awaits or fire-and-forgets this call immediately before
   *   `window.location.href = ...`. We pass `send_instantly: true` and
   *   `transport: 'sendBeacon'` so the event survives page navigation —
   *   the regular batched queue would race the redirect and drop the
   *   event, which breaks the funnel.
   *
   * The funnel terminator `payment_completed` is forwarded to PostHog
   * server-side by the product-events service (allowlist in
   * `apps/server/src/services/domain/product-events.ts`), keyed by the
   * Better Auth user id.
   */
  function trackCheckoutStarted(planId: string, properties: { checkout_session_id?: string, currency?: string, entry_surface: string, price_minor_unit?: number }) {
    if (!canCapture())
      return
    posthog.capture(
      'checkout_started',
      { plan_id: planId, ...properties },
      { send_instantly: true, transport: 'sendBeacon' },
    )
  }

  function trackPaywallSeen(properties: {
    entry_surface: string
    flux_balance_bucket: FluxBalanceBucket
    reason: 'checkout_recovery' | 'insufficient_balance' | 'manual_topup' | 'unknown'
  }) {
    if (!canCapture())
      return
    posthog.capture('paywall_seen', {
      app_surface: getConversationAnalyticsSurface(),
      entry_surface: properties.entry_surface,
      flux_balance_bucket: properties.flux_balance_bucket,
      reason: properties.reason,
    })
  }

  /**
   * OAuth/OIDC callback landing failed before a session existed. Stage
   * values map 1:1 to the guard branches in `pages/auth/callback.vue` so
   * the funnel can tell a provider-side denial from a lost PKCE state.
   */
  function trackOauthCallbackFailed(properties: {
    stage: Extract<OauthCallbackFailureStage, 'missing_code_or_state' | 'missing_flow_state' | 'provider_error' | 'token_exchange_failed'>
  }) {
    if (!canCapture())
      return
    posthog.capture('oauth_callback_failed', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  // ─── Account lifecycle (same event names as apps/ui-server-auth's
  // analytics module — both surfaces feed one PostHog series) ───────────

  function trackPasswordChanged() {
    if (!canCapture())
      return
    posthog.capture('password_changed', { app_surface: getConversationAnalyticsSurface() })
  }

  function trackPasswordResetRequested() {
    if (!canCapture())
      return
    posthog.capture('password_reset_requested', { app_surface: getConversationAnalyticsSurface() })
  }

  function trackOauthProviderLinkStarted(properties: { provider: string }) {
    if (!canCapture())
      return
    // The only caller (`useLinkedAccounts.link`) navigates to the OAuth
    // consent page right after this hook — the batched queue would race
    // the unload and drop the event, same as `trackCheckoutStarted`.
    posthog.capture(
      'oauth_provider_link_started',
      {
        ...properties,
        app_surface: getConversationAnalyticsSurface(),
      },
      { send_instantly: true, transport: 'sendBeacon' },
    )
  }

  function trackOauthProviderUnlinked(properties: { provider: string }) {
    if (!canCapture())
      return
    posthog.capture('oauth_provider_unlinked', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  /**
   * Deletion email sent (user confirmed in the dialog). The completion
   * event lands on ui-server-auth's success page; this one is the churn
   * intent signal even when the user never clicks the email link.
   */
  function trackAccountDeletionRequested() {
    if (!canCapture())
      return
    posthog.capture('account_deletion_requested', { app_surface: getConversationAnalyticsSurface() })
  }

  function trackOnboardingStarted(properties: { entry: ProductAnalyticsEntry }) {
    if (!canCapture())
      return
    posthog.capture('onboarding_started', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackOnboardingCompleted(properties: OnboardingProviderProperties) {
    if (!canCapture())
      return
    posthog.capture('onboarding_completed', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  /** Retention driver — character creation is a strong D7 retention predictor. */
  function trackCharacterCreated(properties: { character_type: 'built_in' | 'custom', voice_enabled: boolean }) {
    if (!canCapture())
      return
    posthog.capture('character_created', properties)
  }

  /** Feature adoption — voice mode is a candidate retention lever; cohort comparisons live in PostHog. */
  function trackVoiceModeActivated(characterId?: string) {
    if (!canCapture())
      return
    posthog.capture('voice_mode_activated', characterId ? { character_id: characterId } : {})
  }

  /**
   * Feature adoption — model switching frequency tells us whether
   * routing/auto-pick changes are needed. Reason discriminates manual UI
   * switch vs future auto-routing decisions.
   */
  function trackModelSwitched(fromModel: string, toModel: string, reason: 'auto' | 'manual' = 'manual') {
    if (!canCapture())
      return
    posthog.capture('model_switched', { from_model: fromModel, reason, to_model: toModel })
    posthog.capture('model_changed', {
      app_surface: getConversationAnalyticsSurface(),
      from_model: fromModel,
      reason,
      to_model: toModel,
    })
  }

  /**
   * Retention cohort denominator — every chat session start. Pair with
   * `payment_completed` cohort to compute "active paying user" retention
   * curves in PostHog.
   */
  function trackChatSessionStarted(modelId: string, sessionIndex?: number) {
    if (!canCapture())
      return
    posthog.capture('chat_session_started', { model_id: modelId, ...(sessionIndex != null && { session_index: sessionIndex }) })
  }

  // ─── LLM round events (client-known fields only) ──────────────────────
  // Source-of-truth for HTTP status / token usage / billing stage is the
  // server (apps/server/src/routes/openai/v1), which records them as
  // Postgres `product_events` rows — deliberately NOT forwarded to PostHog
  // (per-request volume stays in DB/Grafana). These client emits supply the
  // user-facing latency picture (TTFT, render time) the server cannot see.

  function trackMessageSendStarted(properties: ChatRoundCorrelationProperties & { model?: string, source: MessageInputMode }) {
    if (!canCapture())
      return
    posthog.capture('message_send_started', properties)
  }

  function trackLlmRequestStarted(properties: ChatRoundCorrelationProperties & { has_voice: boolean, model: string, provider: string }) {
    if (!canCapture())
      return
    posthog.capture('llm_request_started', properties)
  }

  /** First token from a streaming LLM response — perceived responsiveness anchor. */
  function trackLlmFirstToken(properties: ChatRoundCorrelationProperties & { model: string, ttfb_ms: number }) {
    if (!canCapture())
      return
    posthog.capture('llm_first_token', properties)
  }

  /** Stream finished and the UI has fully rendered the assistant message. */
  function trackAssistantResponseRendered(properties: ChatRoundCorrelationProperties & { latency_ms: number, model: string }) {
    if (!canCapture())
      return
    posthog.capture('assistant_response_rendered', properties)
  }

  /** Closing event for one full message round (user send → assistant render). */
  function trackMessageRound(properties: ChatRoundCorrelationProperties & { duration_ms: number, has_voice: boolean, model: string }) {
    if (!canCapture())
      return
    posthog.capture('message_round', properties)
  }

  /** Canonical failure event for every user-to-assistant round, including post-activation turns. */
  function trackMessageRoundFailed(properties: ChatRoundCorrelationProperties & {
    error_code: string
    failure_stage: ChatActivationFailureStage
    model_id: string
    provider_id: string
    source: MessageInputMode
  }) {
    if (!canCapture())
      return
    posthog.capture('message_round_failed', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  // ─── Chat activation events ──────────────────────────────────────────

  function trackChatActivationStarted(properties: ChatActivationBaseProperties) {
    if (!canCapture())
      return
    posthog.capture('chat_activation_started', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackChatActivationSucceeded(properties: ChatActivationBaseProperties & { time_to_first_message_ms?: number }) {
    if (!canCapture())
      return
    posthog.capture('chat_activation_succeeded', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackChatActivationFailed(properties: ChatActivationBaseProperties & {
    error_code: string
    failure_stage: ChatActivationFailureStage
  }) {
    if (!canCapture())
      return
    posthog.capture('chat_activation_failed', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackOfficialProviderSelected(properties: {
    auto_selected: boolean
    model_id?: string
    provider_id: string
    provider_mode: ProviderMode
    source: OfficialProviderSelectionSource
  }) {
    if (!canCapture())
      return
    posthog.capture('official_provider_selected', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackMessageSent(properties: ConversationBaseProperties & {
    has_attachment: boolean
    message_id?: string
    message_index?: number
    message_length?: number
    mode: MessageInputMode
    round_id: string
    turn_index: number
  }) {
    if (!canCapture())
      return
    posthog.capture('message_sent', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackSecondTurnStarted(properties: ChatActivationBaseProperties) {
    if (!canCapture())
      return
    posthog.capture('second_turn_started', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackModelListLoaded(properties: {
    duration_ms: number
    model_count: number
    provider_id: string
    provider_mode: ProviderMode
  }) {
    if (!canCapture())
      return
    posthog.capture('model_list_loaded', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackModelListFailed(properties: {
    duration_ms: number
    error_code: string
    provider_id: string
    provider_mode: ProviderMode
  }) {
    if (!canCapture())
      return
    posthog.capture('model_list_failed', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackProviderConfigStarted(properties: ProviderConfigBaseProperties) {
    if (!canCapture())
      return
    posthog.capture('provider_config_started', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackProviderConfigSucceeded(properties: ProviderConfigBaseProperties & { duration_ms: number }) {
    if (!canCapture())
      return
    posthog.capture('provider_config_succeeded', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
    trackProviderConfigCompleted({
      ...properties,
      success: true,
    })
    if (properties.provider_mode === 'official') {
      trackOfficialProviderEnabled({
        entry: properties.step === 'onboarding_validate' ? 'onboarding' : 'settings',
        provider_name: properties.provider_id,
      })
    }
  }

  function trackProviderConfigFailed(properties: ProviderConfigBaseProperties & {
    duration_ms: number
    error_code: string
  }) {
    if (!canCapture())
      return
    posthog.capture('provider_config_failed', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackProviderConfigCompleted(properties: ProviderConfigBaseProperties & {
    duration_ms: number
    error_code?: string
    success: boolean
  }) {
    if (!canCapture())
      return
    posthog.capture('provider_config_completed', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
      entry_page: properties.step,
      provider_name: properties.provider_id,
      provider_type: properties.provider_mode,
    })
  }

  function trackOfficialProviderEnabled(properties: {
    entry: 'chat' | 'onboarding' | 'settings'
    provider_name: string
  }) {
    if (!canCapture())
      return
    posthog.capture('official_provider_enabled', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  // ─── Conversation action events ─────────────────────────────────────

  function trackTtsStopClicked(properties: { reason: 'manual-chat' }) {
    if (!canCapture())
      return
    posthog.capture('tts_stop_clicked', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackChatSessionSelected(properties: { cloud_synced: boolean, message_count: number, source: 'sessions_drawer' }) {
    if (!canCapture())
      return
    posthog.capture('chat_session_selected', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackChatMessageDeleted(properties: { message_role: string, source: 'history' }) {
    if (!canCapture())
      return
    posthog.capture('chat_message_deleted', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackChatMessagesCleared(properties: { message_count: number, source: 'chat_controls' }) {
    if (!canCapture())
      return
    posthog.capture('chat_messages_cleared', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackChatMessageRetried(properties: { source: 'history' }) {
    if (!canCapture())
      return
    posthog.capture('chat_message_retried', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackConversationCreated(properties: {
    character_id?: string
    cloud_synced: boolean
    conversation_id: string
    source: ConversationEventSource
  }) {
    if (!canCapture())
      return
    posthog.capture('conversation_created', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackConversationRenamed(properties: {
    conversation_id: string
    source: 'history' | 'sessions_drawer' | 'unknown'
  }) {
    if (!canCapture())
      return
    posthog.capture('conversation_renamed', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackConversationShared(properties: {
    conversation_id: string
    source: ConversationEventSource
  }) {
    if (!canCapture())
      return
    posthog.capture('conversation_shared', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackConversationDeleted(properties: {
    cloud_synced: boolean
    conversation_id: string
    message_count: number
  }) {
    if (!canCapture())
      return
    posthog.capture('conversation_deleted', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  // ─── STT events ──────────────────────────────────────────────────────

  function trackSttStarted(provider: string) {
    if (!canCapture())
      return
    posthog.capture('stt_started', { provider })
  }

  function trackSttSucceeded(properties: { char_count: number, latency_ms: number, provider: string, stream: boolean }) {
    if (!canCapture())
      return
    posthog.capture('stt_succeeded', properties)
  }

  function trackSttFailed(properties: { error_code?: string, provider: string }) {
    if (!canCapture())
      return
    posthog.capture('stt_failed', properties)
  }

  function trackVoiceInputStarted(properties: VoiceInputBaseProperties) {
    if (!canCapture())
      return
    posthog.capture('voice_input_started', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
    posthog.capture('voice_input_used', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackMicrophonePermissionRequested(properties: VoiceInputBaseProperties) {
    if (!canCapture())
      return
    posthog.capture('microphone_permission_requested', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackMicrophonePermissionDenied(properties: VoiceInputBaseProperties & { error_code?: 'permission_denied' | string }) {
    if (!canCapture())
      return
    posthog.capture('microphone_permission_denied', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackAudioDeviceUnavailable(properties: VoiceInputBaseProperties & { error_code?: 'device_unavailable' | string }) {
    if (!canCapture())
      return
    posthog.capture('audio_device_unavailable', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackVoiceInputCancelled(properties: VoiceInputBaseProperties) {
    if (!canCapture())
      return
    posthog.capture('voice_input_cancelled', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  // ─── Feedback and community triage events ────────────────────────────

  function trackBugReportSubmitted(properties: FeedbackBaseProperties & {
    description_length_bucket: FeedbackDescriptionLengthBucket
    include_triage_context: boolean
    screenshot_attached: boolean
  }) {
    if (!canCapture())
      return
    posthog.capture('bug_report_submitted', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackFeedbackSubmitted(properties: FeedbackBaseProperties) {
    if (!canCapture())
      return
    posthog.capture('feedback_submitted', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  // ─── PTT events ──────────────────────────────────────────────────────

  function trackPttPressed() {
    if (!canCapture())
      return
    posthog.capture('ptt_pressed')
  }

  function trackPttReleased(holdMs: number) {
    if (!canCapture())
      return
    posthog.capture('ptt_released', { hold_ms: holdMs })
  }

  // ─── TTS events (forwarded from speech bus by use-speech-pipeline-analytics) ─
  // Selection events use catalog `voice_id` values for adoption analysis.
  // Custom voices must pass `voice_id = custom` from the callsite when the
  // raw provider value is user supplied.

  function trackTtsIntentStarted(properties: { intent_id: string, turn_id?: string }) {
    if (!canCapture())
      return
    posthog.capture('tts_intent_started', properties)
  }

  function trackTtsIntentEnded(properties: { duration_ms: number, intent_id: string, turn_id?: string }) {
    if (!canCapture())
      return
    posthog.capture('tts_intent_ended', properties)
  }

  function trackTtsIntentCancelled(properties: { intent_id: string, reason?: string, turn_id?: string }) {
    if (!canCapture())
      return
    posthog.capture('tts_intent_cancelled', properties)
  }

  function trackTtsProviderSelected(properties: TtsVoiceBaseProperties) {
    if (!canCapture())
      return
    posthog.capture('tts_provider_selected', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackVoiceSelected(properties: TtsVoiceBaseProperties & {
    voice_id: string
    voice_pack_id?: string
    voice_type: VoiceType
  }) {
    if (!canCapture())
      return
    posthog.capture('voice_selected', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackVoicePreviewPlayed(properties: TtsVoiceBaseProperties & {
    voice_id: string
    voice_pack_id?: string
    voice_type: VoiceType
  }) {
    if (!canCapture())
      return
    posthog.capture('voice_preview_played', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackVoicePackBound(properties: TtsVoiceBaseProperties & {
    voice_id: string
    voice_pack_id: string
  }) {
    if (!canCapture())
      return
    posthog.capture('voice_pack_bound', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackAttachmentUploaded(properties: {
    attachment_type: 'audio' | 'document' | 'image' | 'unknown'
    size_bytes?: number
    source: ProductAnalyticsEntry
    success: boolean
  }) {
    if (!canCapture())
      return
    posthog.capture('attachment_uploaded', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackOfficialTtsExposed(properties: OfficialTtsBaseProperties) {
    if (!canCapture())
      return
    posthog.capture('official_tts_exposed', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackPresetUsed(properties: {
    preset_id: string
    preset_type: 'background' | 'character' | 'stage_model' | 'unknown' | 'voice'
    source: ProductAnalyticsEntry
  }) {
    if (!canCapture())
      return
    posthog.capture('preset_used', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackOfficialTtsPreviewStarted(properties: Omit<TtsVoiceBaseProperties, 'source'> & {
    source: Extract<VoiceAnalyticsSource, 'manual_preview'>
    voice_id: string
    voice_pack_id?: string
    voice_type: VoiceType
  }) {
    if (!canCapture())
      return
    posthog.capture('official_tts_preview_started', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackOfficialTtsPreviewSucceeded(properties: Omit<TtsVoiceBaseProperties, 'source'> & {
    duration_ms: number
    source: Extract<VoiceAnalyticsSource, 'manual_preview'>
    voice_id: string
    voice_pack_id?: string
    voice_type: VoiceType
  }) {
    if (!canCapture())
      return
    posthog.capture('official_tts_preview_succeeded', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackProviderSwitched(properties: {
    from_provider?: string
    from_provider_type?: ProviderMode
    reason: 'auto' | 'manual'
    to_provider: string
    to_provider_type: ProviderMode
  }) {
    if (!canCapture())
      return
    posthog.capture('provider_switched', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackSettingsChanged(properties: {
    new_value: boolean | number | string
    previous_value?: boolean | number | string
    setting_name: string
    source: ProductAnalyticsEntry
  }) {
    if (!canCapture())
      return
    posthog.capture('settings_changed', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackSupportContacted(properties: {
    category?: FeedbackCategory
    channel: FeedbackSource
    source: ProductAnalyticsEntry
  }) {
    if (!canCapture())
      return
    posthog.capture('support_contacted', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackOfficialTtsAutoEnabled(properties: Omit<TtsVoiceBaseProperties, 'source'> & {
    enabled: boolean
    source: Extract<VoiceAnalyticsSource, 'chat_auto_tts' | 'settings'>
  }) {
    if (!canCapture())
      return
    posthog.capture('official_tts_auto_enabled', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  // ─── Autonomous LLM path (artistry-autonomous bypasses chat orchestrator) ─

  function trackAutonomousGenerateText(properties: { model: string, reason?: string }) {
    if (!canCapture())
      return
    posthog.capture('autonomous_generate_text', properties)
  }

  // ─── AIRI card (ccv3 character card) events ──────────────────────────
  // `card_created` is emitted store-side (`stores/modules/airi-card.ts`)
  // because creation has three entry points; edit has exactly one
  // user-driven entry (the creation dialog in edit mode), so it lives
  // here. Background card writes (autonomous artistry, image journal,
  // scene background) intentionally do NOT count as edits.

  function trackCardEdited(properties: { card_id: string }) {
    if (!canCapture())
      return
    posthog.capture('card_edited', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  /** Stage background switched on the active card. `cleared` = set to none. */
  function trackSceneBackgroundSet(properties: { cleared: boolean, source: 'card_gallery' | 'scene_settings' }) {
    if (!canCapture())
      return
    posthog.capture('scene_background_set', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  function trackCharacterUpdated(properties: { character_id: string }) {
    if (!canCapture())
      return
    posthog.capture('character_updated', properties)
  }

  // ─── App lifecycle ───────────────────────────────────────────────────

  function trackAppLoaded(properties: { cold_start_ms?: number, platform: 'desktop' | 'mobile' | 'web', version: string }) {
    if (!canCapture())
      return
    posthog.capture('app_loaded', properties)
  }

  // ─── Feature usage / retention ───────────────────────────────────────

  function trackCharacterDeleted(properties: { character_id: string }) {
    if (!canCapture())
      return
    posthog.capture('character_deleted', properties)
  }

  function trackCharacterSwitched(properties: { from_character_id?: string, to_character_id: string }) {
    if (!canCapture())
      return
    posthog.capture('character_switched', properties)
  }

  function trackChatSessionDeleted(properties: { message_count: number, session_id: string }) {
    if (!canCapture())
      return
    posthog.capture('chat_session_deleted', properties)
  }

  function trackOnboardingStepCompleted(step: string) {
    if (!canCapture())
      return
    posthog.capture('onboarding_step_completed', { step })
  }

  function trackOnboardingSkipped(at_step: string) {
    if (!canCapture())
      return
    posthog.capture('onboarding_skipped', { at_step })
  }

  // ─── Monetization (client side) ──────────────────────────────────────

  function trackFluxLowWarningShown(properties: { balance: number, threshold: number }) {
    if (!canCapture())
      return
    posthog.capture('flux_low_warning_shown', properties)
  }

  function trackFluxTopupClicked(properties: { balance: number, entry_surface: string }) {
    if (!canCapture())
      return
    posthog.capture('flux_topup_clicked', properties)
  }

  function trackQuotaLimitReached(properties: {
    current_usage: number
    entry: ProductAnalyticsEntry
    limit_type: 'flux' | 'rate_limit' | 'subscription'
    limit_value?: number
  }) {
    if (!canCapture())
      return
    posthog.capture('quota_limit_reached', properties)
  }

  function trackUpgradeClicked(properties: {
    current_plan?: string
    source_page: string
    trigger: 'feature_gate' | 'manual_topup' | 'pricing_page' | 'quota_limit'
  }) {
    if (!canCapture())
      return
    posthog.capture('upgrade_clicked', properties)
  }

  function trackFeatureUsed(properties: {
    business_domain: string
    entry: ProductAnalyticsEntry
    feature_name: string
    success: boolean
  }) {
    if (!canCapture())
      return
    posthog.capture('feature_used', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  // ─── Data maintenance (churn-precursor signals) ──────────────────────

  /**
   * One event for every destructive/exporting action on the data settings
   * page. Wipes and exports often precede churn, so cohorts built on this
   * event feed the at-risk-user list. Fires only after the action
   * succeeded — a failed wipe is not a churn signal.
   */
  function trackDataAction(properties: {
    action: 'app_data_cleared' | 'chats_cleared' | 'chats_exported' | 'chats_imported' | 'desktop_state_reset' | 'models_cache_cleared' | 'modules_settings_reset' | 'provider_settings_reset'
  }) {
    if (!canCapture())
      return
    posthog.capture('data_action', {
      ...properties,
      app_surface: getConversationAnalyticsSurface(),
    })
  }

  // ─── Desktop (Electron / Tamagotchi) differentiators ─────────────────
  // These measure whether the desktop-only surfaces earn their upkeep:
  // spotlight quick-input, floating widgets, the in-app updater, MCP
  // server management. Input text never leaves the device — events carry
  // counts and low-cardinality ids only.

  function trackSpotlightUsed() {
    if (!canCapture())
      return
    posthog.capture('spotlight_used')
  }

  function trackWidgetOpened(properties: { widget_id: string }) {
    if (!canCapture())
      return
    posthog.capture('widget_opened', properties)
  }

  function trackUpdateCheckClicked(properties: { channel: string }) {
    if (!canCapture())
      return
    posthog.capture('update_check_clicked', properties)
  }

  function trackUpdateDownloaded(properties: { channel: string, version?: string }) {
    if (!canCapture())
      return
    posthog.capture('update_downloaded', properties)
  }

  /** User confirmed restart-and-install; the app quits right after. */
  function trackUpdateInstallClicked(properties: { channel: string, version?: string }) {
    if (!canCapture())
      return
    posthog.capture('update_install_clicked', properties, { send_instantly: true, transport: 'sendBeacon' })
  }

  function trackMcpServerAdded() {
    if (!canCapture())
      return
    posthog.capture('mcp_server_added')
  }

  function trackMcpServerRemoved() {
    if (!canCapture())
      return
    posthog.capture('mcp_server_removed')
  }

  function trackMcpConnectionTestRun(properties: { success: boolean }) {
    if (!canCapture())
      return
    posthog.capture('mcp_connection_test_run', properties)
  }

  /** Pairing QR revealed — the funnel start for `device_channel_connected`. */
  function trackDevicePairingQrShown() {
    if (!canCapture())
      return
    posthog.capture('device_pairing_qr_shown')
  }

  // ─── Voice clone (custom TTS voice) ──────────────────────────────────

  function trackVoiceCloneCreated(properties: { provider: string }) {
    if (!canCapture())
      return
    posthog.capture('voice_clone_created', properties)
  }

  // ─── Device pairing / channel (Electron / Tamagotchi) ─────────────────

  function trackDeviceChannelConnected(properties: { channel: string }) {
    if (!canCapture())
      return
    posthog.capture('device_channel_connected', properties)
  }

  return {
    privacyPolicyUrl,
    trackAccountDeletionRequested,
    trackAppLoaded,
    trackAssistantResponseRendered,
    trackAttachmentUploaded,
    trackAudioDeviceUnavailable,
    trackAutonomousGenerateText,
    trackBugReportSubmitted,
    trackCardEdited,
    trackCharacterCreated,
    trackCharacterDeleted,
    trackCharacterSwitched,
    trackCharacterUpdated,
    trackChatActivationFailed,
    trackChatActivationStarted,
    trackChatActivationSucceeded,
    trackChatMessageDeleted,
    trackChatMessageRetried,
    trackChatMessagesCleared,

    trackChatSessionDeleted,
    trackChatSessionSelected,
    trackChatSessionStarted,
    trackCheckoutStarted,
    trackConversationCreated,
    trackConversationDeleted,
    trackConversationRenamed,
    trackConversationShared,
    trackDataAction,
    trackDeviceChannelConnected,
    trackDevicePairingQrShown,
    trackFeatureUsed,
    trackFeedbackSubmitted,
    trackFirstMessage,
    trackFluxLowWarningShown,
    trackFluxTopupClicked,
    trackLlmFirstToken,
    trackLlmRequestStarted,
    trackMcpConnectionTestRun,
    trackMcpServerAdded,
    trackMcpServerRemoved,
    trackMessageRound,
    trackMessageRoundFailed,
    trackMessageSendStarted,
    trackMessageSent,
    trackMicrophonePermissionDenied,
    trackMicrophonePermissionRequested,
    trackModelListFailed,

    trackModelListLoaded,
    trackModelSwitched,
    trackOauthCallbackFailed,
    trackOauthProviderLinkStarted,
    trackOauthProviderUnlinked,
    trackOfficialProviderEnabled,
    trackOfficialProviderSelected,
    trackOfficialTtsAutoEnabled,
    trackOfficialTtsExposed,
    trackOfficialTtsPreviewStarted,

    trackOfficialTtsPreviewSucceeded,
    trackOnboardingCompleted,

    trackOnboardingSkipped,
    trackOnboardingStarted,
    trackOnboardingStepCompleted,
    trackPasswordChanged,
    trackPasswordResetRequested,
    trackPaywallSeen,
    trackPlanSelected,
    trackPresetUsed,
    trackPricingViewed,
    trackProviderClick,
    trackProviderConfigCompleted,
    trackProviderConfigFailed,
    trackProviderConfigStarted,
    trackProviderConfigSucceeded,
    trackProviderSwitched,
    trackPttPressed,

    trackPttReleased,

    trackQuotaLimitReached,

    trackSceneBackgroundSet,
    trackSecondTurnStarted,
    trackSettingsChanged,
    trackSpotlightUsed,
    trackSttFailed,
    trackSttStarted,
    trackSttSucceeded,
    trackSupportContacted,

    trackTtsIntentCancelled,
    trackTtsIntentEnded,
    trackTtsIntentStarted,
    trackTtsProviderSelected,
    trackTtsStopClicked,
    trackUpdateCheckClicked,
    trackUpdateDownloaded,

    trackUpdateInstallClicked,
    trackUpgradeClicked,
    trackVoiceCloneCreated,
    trackVoiceInputCancelled,
    trackVoiceInputStarted,
    trackVoiceModeActivated,
    trackVoicePackBound,
    trackVoicePreviewPlayed,
    trackVoiceSelected,
    trackWidgetOpened,
  }
}

function getConversationAnalyticsSurface(): ConversationAnalyticsSurface {
  if (isStageTamagotchi())
    return 'electron'

  if (isStageCapacitor())
    return 'mobile'

  return 'web'
}
