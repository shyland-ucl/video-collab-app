import { describe, it, expect } from 'vitest'
import { buildInviteUrl } from './inviteUrl'

describe('buildInviteUrl', () => {
  it('builds an absolute /join URL from origin and token', () => {
    expect(buildInviteUrl('https://app.example.com', 'abc-123')).toBe(
      'https://app.example.com/join/abc-123'
    )
  })

  it('tolerates a trailing slash on the origin', () => {
    expect(buildInviteUrl('https://app.example.com/', 'abc-123')).toBe(
      'https://app.example.com/join/abc-123'
    )
  })
})
