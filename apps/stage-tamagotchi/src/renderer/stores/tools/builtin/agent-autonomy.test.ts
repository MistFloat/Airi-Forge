import { describe, expect, it } from 'vitest'

import { installStrictToolSchemaMatchers } from '../testing/strict-tool-schema'
import { agentAutonomyTools } from './agent-autonomy'

installStrictToolSchemaMatchers()

describe('agent autonomy tools', () => {
  it('exposes provider-strict Goal and Schedule schemas', async () => {
    const tools = await agentAutonomyTools()

    expect(tools).toHaveLength(2)
    expect(tools).toSatisfyStrictToolSchemas()
  })
})
