<script setup lang="ts">
import {
  ProviderSettingsContainer,
  ProviderSettingsLayout,
} from '@proj-airi/stage-ui/components'
import { useAuthStore } from '@proj-airi/stage-ui/stores/auth'
import { useProvidersStore } from '@proj-airi/stage-ui/stores/providers'
import { Callout } from '@proj-airi/ui'
import { storeToRefs } from 'pinia'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const router = useRouter()
const { t } = useI18n()
const authStore = useAuthStore()
const providersStore = useProvidersStore()
const { isAuthenticated, needsLogin } = storeToRefs(authStore)

const providerId = 'vision-official-provider'
const providerMetadata = providersStore.getProviderMetadata(providerId)

function handleLogin() {
  needsLogin.value = true
}
</script>

<template>
  <ProviderSettingsLayout
    v-if="providerMetadata"
    :provider-name="providerMetadata?.localizedName"
    :provider-icon-color="providerMetadata?.iconColor"
    :on-back="() => router.back()"
  >
    <ProviderSettingsContainer>
      <div v-if="!isAuthenticated" flex flex-col gap-4>
        <Callout theme="primary">
          <template #label>
            {{ t('settings.dialogs.onboarding.official.title') }}
          </template>
          <div flex flex-col gap-3>
            <p>{{ t('settings.dialogs.onboarding.loginPrompt') }}</p>
            <button
              type="button"
              class="w-fit rounded-lg bg-primary-500 px-4 py-2 text-white transition-colors active:scale-95 hover:bg-primary-600"
              @click="handleLogin"
            >
              {{ t('settings.dialogs.onboarding.loginAction') }}
            </button>
          </div>
        </Callout>
      </div>

      <div v-else flex flex-col gap-6>
        <div class="border border-neutral-200/50 rounded-xl p-4 dark:border-neutral-700/50">
          <div flex items-center gap-3>
            <div class="h-2 w-2 animate-pulse rounded-full bg-green-500" />
            <span text="sm neutral-600 dark:neutral-300">
              {{ t('settings.pages.providers.provider.common.status.valid') }}
            </span>
          </div>
        </div>
      </div>
    </ProviderSettingsContainer>
  </ProviderSettingsLayout>
  <div v-else class="p-8 text-center text-neutral-500">
    Provider is not available.
  </div>
</template>

<route lang="yaml">
meta:
  layout: settings
  stageTransition:
    name: slide
</route>
