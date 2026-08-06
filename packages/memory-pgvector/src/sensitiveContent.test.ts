import { describe, expect, it } from 'vitest'

import { containsSensitiveSecret } from './sensitiveContent'

describe('sensitive content filter', () => {
  it('blocks private key blocks', () => {
    expect(containsSensitiveSecret('-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA')).toBe(true)
    expect(containsSensitiveSecret('-----BEGIN OPENSSH PRIVATE KEY-----')).toBe(true)
  })

  it('blocks credential assignment and secret-bearing tokens', () => {
    expect(containsSensitiveSecret('api_key = sk_test_123456789012345')).toBe(true)
    expect(containsSensitiveSecret('password: correct-horse-battery-staple')).toBe(true)
    expect(containsSensitiveSecret('token=eyJhbGciOiJIUzI1NiJ9.abcdef')).toBe(true)
    expect(containsSensitiveSecret('jina_abc123456789012')).toBe(true)
  })

  it('allows ordinary durable profile statements', () => {
    expect(containsSensitiveSecret('我现在住在上海，并且喜欢爵士乐。')).toBe(false)
  })
})
