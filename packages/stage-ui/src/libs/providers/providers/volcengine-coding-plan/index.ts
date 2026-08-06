import { createArkChatProviderDefinition } from '../ark-shared'

export const providerVolcengineCodingPlan = createArkChatProviderDefinition({
  defaultBaseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
  description: 'Volcengine Coding Plan',
  descriptionKey: 'settings.pages.providers.provider.volcengine-coding-plan.description',
  icon: 'i-lobe-icons:volcengine',
  iconColor: 'i-lobe-icons:volcengine',
  id: 'volcengine-coding-plan',
  modelPrefix: 'volcengine-coding-plan/',
  models: [
    { contextLength: 256000, id: 'doubao-seed-2.0-code' },
    { contextLength: 256000, id: 'doubao-seed-2.0-pro' },
    { contextLength: 256000, id: 'doubao-seed-2.0-lite' },
    { contextLength: 256000, id: 'doubao-seed-code' },
    { contextLength: 200000, id: 'minimax-m2.5' },
    { contextLength: 200000, id: 'glm-4.7' },
    { contextLength: 128000, id: 'deepseek-v3.2' },
    { contextLength: 256000, id: 'kimi-k2.5' },
  ],
  name: 'Volcengine Coding Plan',
  nameKey: 'settings.pages.providers.provider.volcengine-coding-plan.title',
  order: 7,
})
