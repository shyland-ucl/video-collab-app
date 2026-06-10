import { describe, it, expect } from 'vitest'
import { safeNext } from './safeNext'

describe('safeNext', () => {
  it('accepts a same-origin absolute path', () => {
    expect(safeNext('/projects/123?tab=people')).toBe('/projects/123?tab=people')
  })
  it('rejects absolute URLs', () => {
    expect(safeNext('https://evil.com/x')).toBe('/')
  })
  it('rejects protocol-relative URLs', () => {
    expect(safeNext('//evil.com')).toBe('/')
  })
  it('rejects authority-extension tricks', () => {
    expect(safeNext('.evil.com/x')).toBe('/')
    expect(safeNext('@evil.com')).toBe('/')
  })
  it('falls back to / for null or empty', () => {
    expect(safeNext(null)).toBe('/')
    expect(safeNext('')).toBe('/')
  })
})
