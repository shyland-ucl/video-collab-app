import { describe, it, expect } from 'vitest'
import { buildHelperTaskStatusUpdate, helperTaskStatusLabel } from './taskFeedback'

describe('taskFeedback — helperTaskStatusLabel', () => {
  it('maps the app status values to probe wording', () => {
    expect(helperTaskStatusLabel('done')).toBe('finished')
    expect(helperTaskStatusLabel('needs_discussion')).toBe('needs discussion')
    expect(helperTaskStatusLabel('cant_do')).toBe('cannot complete')
  })

  it('falls back to "updated" for an unknown status', () => {
    expect(helperTaskStatusLabel('whatever')).toBe('updated')
  })
})

describe('taskFeedback — buildHelperTaskStatusUpdate', () => {
  it('names the task text AND the segment label so the creator knows which task resolved', () => {
    const task = { id: 't1', text: 'trim the intro', segment_label: 'Scene 3' }
    const update = buildHelperTaskStatusUpdate(task, 'done', 'Your helper')
    // Includes the helper label, the resolution, the segment, and the task text.
    expect(update.announcement).toBe('Your helper finished the task for Scene 3. Task: trim the intro')
    expect(update.announcement).toMatch(/Scene 3/)
    expect(update.announcement).toMatch(/trim the intro/)
  })

  it('needs_discussion uses the probe verbatim wording', () => {
    const task = { id: 't2', text: 'brighten this shot', segment_label: 'Scene 1' }
    const update = buildHelperTaskStatusUpdate(task, 'needs_discussion', 'Your helper')
    expect(update.announcement).toBe('Your helper needs discussion the task for Scene 1. Task: brighten this shot')
  })

  it("cant_do reads 'cannot complete'", () => {
    const task = { id: 't3', text: 'add music', segment_label: 'Scene 2' }
    const update = buildHelperTaskStatusUpdate(task, 'cant_do', 'Your helper')
    expect(update.announcement).toBe('Your helper cannot complete the task for Scene 2. Task: add music')
  })

  it('reads the scene from segment_label (app snake_case shape)', () => {
    const task = { id: 't4', text: 'fix colour', segment_label: 'Scene 5' }
    const update = buildHelperTaskStatusUpdate(task, 'done', 'Your helper')
    expect(update.announcement).toMatch(/for Scene 5/)
  })

  it('still accepts the probe segment/segmentName keys (parity)', () => {
    expect(
      buildHelperTaskStatusUpdate({ text: 'x', segment: 'Scene 9' }, 'done', 'Helper').announcement
    ).toBe('Helper finished the task for Scene 9. Task: x')
    expect(
      buildHelperTaskStatusUpdate({ text: 'x', segmentName: 'Scene 8' }, 'done', 'Helper').announcement
    ).toBe('Helper finished the task for Scene 8. Task: x')
  })

  it('omits the target when there is no segment label, and falls back when there is no task text', () => {
    expect(buildHelperTaskStatusUpdate({ text: 'do the thing' }, 'done', 'Your helper').announcement)
      .toBe('Your helper finished the task. Task: do the thing')
    expect(buildHelperTaskStatusUpdate({ segment_label: 'Scene 3' }, 'done', 'Your helper').announcement)
      .toBe('Your helper finished the task for Scene 3. Review the helper task status.')
  })
})
