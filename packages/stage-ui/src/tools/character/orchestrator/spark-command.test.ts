import type { JsonSchema } from 'xsschema'

import z from 'zod/v4'

import { ContextUpdateStrategy } from '@proj-airi/server-sdk'
import { rawTool } from '@xsai/tool'
import { describe, expect, it, vi } from 'vitest'
import { toJsonSchema } from 'xsschema'

import { createSparkCommandTool } from './spark-command'
import { normalizeNullableAnyOf, sparkNotifyCommandItemSchema } from './spark-command-shared'

/**
 * Asserts array membership ignoring order. JSON Schema `required` order is not
 * contractual — xsschema/zod emit it in their own (dependency-versioned) key
 * order, so the assertions in this file only pin down the key set.
 */
function expectSameMembers(actual: readonly string[] | undefined, expected: readonly string[]) {
  expect(actual).toBeDefined()
  expect([...(actual as string[])].sort()).toEqual([...expected].sort())
}

function findObjectSchema(schema: JsonSchema | undefined, predicate: (schema: JsonSchema) => boolean): JsonSchema | undefined {
  if (!schema)
    return undefined

  const objectSchema = getObjectSchema(schema)
  if (objectSchema && predicate(objectSchema))
    return objectSchema

  for (const candidate of [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].filter(isJsonSchema)) {
    const found = findObjectSchema(candidate, predicate)
    if (found)
      return found
  }

  return undefined
}

function getArraySchema(schema?: JsonSchema) {
  if (!schema)
    return undefined

  if (schema.type === 'array')
    return schema

  const candidates = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].filter(isJsonSchema)
  return candidates.find(candidate => candidate?.type === 'array')
}

function getObjectSchema(schema?: JsonSchema) {
  if (!schema)
    return undefined

  if (schema.type === 'object')
    return schema

  const candidates = [...(schema.anyOf ?? []), ...(schema.oneOf ?? [])].filter(isJsonSchema)
  return candidates.find(candidate => candidate?.type === 'object')
}

function isJsonSchema(value: boolean | JsonSchema | undefined): value is JsonSchema {
  return Boolean(value && typeof value === 'object')
}

describe('tools/character/orchestrator/spark-command', () => {
  it('normalizes scalar|null anyOf into a type array', async () => {
    const schemaTestUnion = await toJsonSchema(z.object({
      testField: z.union([z.string(), z.null()]),
    }))
    const normalized = normalizeNullableAnyOf(schemaTestUnion as JsonSchema)
    const testField = normalized.properties?.testField as JsonSchema

    expect(testField.type).toEqual(['string', 'null'])
    expect(testField.anyOf).toBeUndefined()
  })

  it('deduplicates primitive types after normalization', async () => {
    const schemaTestUnion = await toJsonSchema(z.object({
      testField: z.union([z.literal('force'), z.literal('soft'), z.literal(false)]),
    }))
    const normalized = normalizeNullableAnyOf(schemaTestUnion as JsonSchema)
    const testField = normalized.properties?.testField as JsonSchema

    expect(testField.type).toEqual(['string', 'boolean'])
    expect(testField.anyOf).toBeUndefined()
  })

  it('removes required keys that are not declared in sibling properties', () => {
    const normalized = normalizeNullableAnyOf({
      properties: {
        contexts: {
          anyOf: [
            {
              items: {
                properties: {
                  metadata: {
                    anyOf: [
                      {
                        items: {
                          properties: {
                            key: { type: 'string' },
                          },
                          required: ['key', 'value'],
                          type: 'object',
                        },
                        type: 'array',
                      },
                      { type: 'null' },
                    ],
                  },
                },
                type: 'object',
              },
              type: 'array',
            },
            { type: 'null' },
          ],
        },
      },
      required: ['contexts'],
      type: 'object',
    } as JsonSchema)

    const contexts = getArraySchema(normalized.properties?.contexts as JsonSchema)
    const contextItem = contexts?.items as JsonSchema
    const metadata = getArraySchema(contextItem.properties?.metadata as JsonSchema)
    const metadataItem = metadata?.items as JsonSchema

    expect(metadataItem.required).toEqual(['key'])
  })

  it('should render sparkNotifyCommandItemSchema into correct schema', async () => {
    const schemaTest = await toJsonSchema(sparkNotifyCommandItemSchema)
    const normalized = normalizeNullableAnyOf(schemaTest as JsonSchema)

    const res = rawTool({
      execute: () => ({ success: true }),
      name: 'test_tool',
      parameters: normalized,
      strict: true,
    })
    expect(res.function.parameters).toStrictEqual(normalized)
  })

  it('emits a strict parameter schema', async () => {
    const tools = await createSparkCommandTool({
      sendSparkCommand: () => undefined,
    })

    expect(tools[0].function.name).toBe('builtIn_emitSparkCommand')
    expect(tools[0].function.parameters.additionalProperties).toBe(false)
  })

  it('avoids propertyNames in provider-facing schema', async () => {
    const tools = await createSparkCommandTool({
      sendSparkCommand: () => undefined,
    })

    const schema = tools[0].function.parameters as JsonSchema
    const guidance = getObjectSchema(schema.properties?.guidance as JsonSchema)
    const guidancePersona = guidance?.properties?.persona as JsonSchema
    const contexts = getArraySchema(schema.properties?.contexts as JsonSchema)
    const contextItem = contexts?.items as JsonSchema
    const metadata = contextItem.properties?.metadata as JsonSchema

    expect(guidancePersona.propertyNames).toBeUndefined()
    expect(metadata.propertyNames).toBeUndefined()
  })

  it('uses explicit required keys for nested strict option objects', async () => {
    const tools = await createSparkCommandTool({
      sendSparkCommand: () => undefined,
    })

    const schema = tools[0].function.parameters as JsonSchema
    expectSameMembers(schema.required, [
      'destinations',
      'interrupt',
      'priority',
      'intent',
      'ack',
      'parentEventId',
      'guidance',
      'contexts',
    ])
    const guidance = getObjectSchema(schema.properties?.guidance as JsonSchema)
    const options = guidance?.properties?.options as JsonSchema
    const optionItem = options.items as JsonSchema
    const contexts = getArraySchema(schema.properties?.contexts as JsonSchema)
    const contextItem = contexts?.items as JsonSchema
    const destinations = contextItem.properties?.destinations as JsonSchema
    const destinationsFilter = findObjectSchema(
      destinations,
      candidate => Boolean(candidate.properties?.include || candidate.properties?.exclude),
    )

    expectSameMembers(guidance?.required, [
      'type',
      'persona',
      'options',
    ])
    expectSameMembers(optionItem.required, [
      'label',
      'steps',
      'rationale',
      'possibleOutcome',
      'risk',
      'fallback',
      'triggers',
    ])
    expectSameMembers(contextItem.required, [
      'lane',
      'ideas',
      'hints',
      'strategy',
      'text',
      'destinations',
      'metadata',
    ])
    expectSameMembers(destinationsFilter?.required, [
      'include',
      'exclude',
    ])
  })

  it('builds and dispatches spark commands with generated ids', async () => {
    const sendSparkCommand = vi.fn()
    const tools = await createSparkCommandTool({
      sendSparkCommand,
    })

    const result = await tools[0].execute({
      ack: 'check this',
      contexts: [{
        destinations: ['memory'],
        hints: null,
        ideas: null,
        lane: 'game',
        metadata: [
          { key: 'threat', value: 'zombie' },
          { key: 'urgent', value: true },
        ],
        strategy: ContextUpdateStrategy.AppendSelf,
        text: 'Zombie nearby',
      }],
      destinations: ['minecraft'],
      guidance: {
        options: [{
          fallback: null,
          label: 'Move',
          possibleOutcome: null,
          rationale: 'Closer inspection',
          risk: null,
          steps: ['Walk forward'],
          triggers: null,
        }],
        persona: [
          { strength: 'high', traits: 'bravery' },
        ],
        type: 'instruction',
      },
      intent: 'proposal',
      interrupt: 'soft',
      parentEventId: 'parent-1',
      priority: 'high',
    }, { messages: [], toolCallId: 'tool-call-id' })

    expect(sendSparkCommand).toHaveBeenCalledTimes(1)
    expect(sendSparkCommand).toHaveBeenCalledWith(expect.objectContaining({
      ack: 'check this',
      contexts: [expect.objectContaining({
        destinations: ['memory'],
        lane: 'game',
        metadata: {
          threat: 'zombie',
          urgent: true,
        },
        strategy: ContextUpdateStrategy.AppendSelf,
        text: 'Zombie nearby',
      })],
      destinations: ['minecraft'],
      guidance: {
        options: [{
          fallback: undefined,
          label: 'Move',
          possibleOutcome: undefined,
          rationale: 'Closer inspection',
          risk: undefined,
          steps: ['Walk forward'],
          triggers: undefined,
        }],
        persona: {
          bravery: 'high',
        },
        type: 'instruction',
      },
      intent: 'proposal',
      interrupt: 'soft',
      parentEventId: 'parent-1',
      priority: 'high',
    }))

    const command = sendSparkCommand.mock.calls[0][0]
    expect(command.id).toEqual(expect.any(String))
    expect(command.eventId).toEqual(expect.any(String))
    expect(command.commandId).toEqual(expect.any(String))
    expect(command.contexts?.[0].id).toEqual(expect.any(String))
    expect(command.contexts?.[0].contextId).toEqual(expect.any(String))
    expect(result).toContain('spark:command sent')
    expect(result).toContain(command.commandId)
  })

  it('reports a broadcast without crashing when the channel sender clears destinations', async () => {
    // The real sendSparkCommand (stores/llm.ts) deletes command.destinations to broadcast to every
    // authenticated peer; the success message must not then call .join on undefined.
    const sendSparkCommand = vi.fn((command: { destinations?: unknown }) => {
      delete command.destinations
    })
    const tools = await createSparkCommandTool({ sendSparkCommand })

    const result = await tools[0].execute({
      ack: null,
      contexts: null,
      destinations: [],
      guidance: null,
      intent: 'action',
      interrupt: 'soft',
      parentEventId: null,
      priority: 'normal',
    }, { messages: [], toolCallId: 'tool-call-id' })

    expect(sendSparkCommand).toHaveBeenCalledOnce()
    expect(result).toContain('spark:command sent')
    expect(result).toContain('broadcast')
  })
})
