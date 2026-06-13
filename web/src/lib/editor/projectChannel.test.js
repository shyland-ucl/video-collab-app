import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { joinProjectChannel, PLAYHEAD_THROTTLE_MS } from './projectChannel'

function fakeChannel() {
  const handlers = { broadcast: {}, postgres: [], presence: {} }
  const sent = []
  const channel = {
    handlers, sent,
    on: vi.fn((type, filter, cb) => {
      if (type === 'broadcast') handlers.broadcast[filter.event] = cb
      if (type === 'postgres_changes') handlers.postgres.push({ filter, cb })
      if (type === 'presence') handlers.presence[filter.event] = cb
      return channel
    }),
    subscribe: vi.fn((cb) => { channel.statusCb = cb; cb?.('SUBSCRIBED'); return channel }),
    send: vi.fn(async (msg) => { sent.push(msg) }),
    track: vi.fn(async () => {}),
    presenceState: vi.fn(() => ({})),
    unsubscribe: vi.fn(async () => {}),
  }
  return channel
}

function fakeSupabase(channel) {
  return { channel: vi.fn(() => channel), removeChannel: vi.fn() }
}

describe('joinProjectChannel', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('subscribes to state inserts, task changes, presence, and broadcasts', async () => {
    const channel = fakeChannel()
    const onStateInsert = vi.fn()
    const onTaskChange = vi.fn()
    const onSuggestionChange = vi.fn()
    const onRenderChange = vi.fn()
    const handle = joinProjectChannel(fakeSupabase(channel), {
      projectId: 'p1', userId: 'u1', role: 'creator',
      onStateInsert, onTaskChange, onSuggestionChange, onRenderChange, onPresence: vi.fn(), onPlayhead: vi.fn(), onTransport: vi.fn(), onActivity: vi.fn(),
    })

    const suggestionSub = channel.handlers.postgres.find((h) => h.filter.table === 'suggestions')
    expect(suggestionSub.filter).toMatchObject({ event: '*', filter: 'project_id=eq.p1' })
    suggestionSub.cb({ eventType: 'INSERT', new: { id: 'sug1', text: 'x' } })
    expect(onSuggestionChange).toHaveBeenCalledWith({ eventType: 'INSERT', suggestion: { id: 'sug1', text: 'x' } })
    suggestionSub.cb({ eventType: 'DELETE', new: {}, old: { id: 'sug9' } })
    expect(onSuggestionChange).toHaveBeenCalledWith({ eventType: 'DELETE', suggestion: { id: 'sug9' } })

    const renderSub = channel.handlers.postgres.find((h) => h.filter.table === 'renders')
    expect(renderSub.filter).toMatchObject({ event: '*', filter: 'project_id=eq.p1' })
    renderSub.cb({ eventType: 'UPDATE', new: { id: 'r1', status: 'ready' } })
    expect(onRenderChange).toHaveBeenCalledWith({ eventType: 'UPDATE', render: { id: 'r1', status: 'ready' } })

    const stateSub = channel.handlers.postgres.find((h) => h.filter.table === 'project_state')
    expect(stateSub.filter).toMatchObject({ event: 'INSERT', schema: 'public', filter: 'project_id=eq.p1' })
    stateSub.cb({ new: { version: 3, state: { clips: [] }, updated_by: 'u2' } })
    expect(onStateInsert).toHaveBeenCalledWith({ version: 3, state: { clips: [] }, updated_by: 'u2' })

    const taskSub = channel.handlers.postgres.find((h) => h.filter.table === 'tasks')
    expect(taskSub.filter).toMatchObject({ event: '*', filter: 'project_id=eq.p1' })
    taskSub.cb({ eventType: 'UPDATE', new: { id: 't1', status: 'done' } })
    expect(onTaskChange).toHaveBeenCalledWith({ eventType: 'UPDATE', task: { id: 't1', status: 'done' } })

    // realtime-js leaves payload.new as {} (not null) on DELETE
    taskSub.cb({ eventType: 'DELETE', new: {}, old: { id: 't9' } })
    expect(onTaskChange).toHaveBeenCalledWith({ eventType: 'DELETE', task: { id: 't9' } })

    expect(channel.track).toHaveBeenCalledWith({ userId: 'u1', role: 'creator' })
    expect(typeof handle.leave).toBe('function')
  })

  it('throttles playhead broadcasts and never throttles transport', async () => {
    const channel = fakeChannel()
    const handle = joinProjectChannel(fakeSupabase(channel), {
      projectId: 'p1', userId: 'u1', role: 'creator',
      onStateInsert: vi.fn(), onTaskChange: vi.fn(), onPresence: vi.fn(), onPlayhead: vi.fn(), onTransport: vi.fn(), onActivity: vi.fn(),
    })

    handle.sendPlayhead({ isPlaying: true, time: 1 })
    handle.sendPlayhead({ isPlaying: true, time: 1.5 })
    expect(channel.sent.filter((m) => m.event === 'playhead')).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(PLAYHEAD_THROTTLE_MS + 10)
    handle.sendPlayhead({ isPlaying: true, time: 3 })
    expect(channel.sent.filter((m) => m.event === 'playhead')).toHaveLength(2)

    handle.sendTransport({ action: 'pause', time: 3 })
    handle.sendTransport({ action: 'play', time: 3 })
    expect(channel.sent.filter((m) => m.event === 'transport')).toHaveLength(2)
  })

  it('routes incoming broadcasts to the right callbacks', () => {
    const channel = fakeChannel()
    const onPlayhead = vi.fn(); const onTransport = vi.fn(); const onActivity = vi.fn()
    joinProjectChannel(fakeSupabase(channel), {
      projectId: 'p1', userId: 'u1', role: 'helper',
      onStateInsert: vi.fn(), onTaskChange: vi.fn(), onPresence: vi.fn(), onPlayhead, onTransport, onActivity,
    })
    channel.handlers.broadcast.playhead({ payload: { time: 9 } })
    channel.handlers.broadcast.transport({ payload: { action: 'seek', time: 4 } })
    channel.handlers.broadcast.activity({ payload: { action: 'Seeked', detail: '0:45' } })
    expect(onPlayhead).toHaveBeenCalledWith({ time: 9 })
    expect(onTransport).toHaveBeenCalledWith({ action: 'seek', time: 4 })
    expect(onActivity).toHaveBeenCalledWith({ action: 'Seeked', detail: '0:45' })
  })

  it('fires onReconnect once when a failed first connect later succeeds', async () => {
    const channel = fakeChannel()
    // Don't auto-fire SUBSCRIBED — drive the status callback by hand.
    channel.subscribe = vi.fn((cb) => { channel.statusCb = cb; return channel })
    const onError = vi.fn()
    const onReconnect = vi.fn()
    joinProjectChannel(fakeSupabase(channel), {
      projectId: 'p1', userId: 'u1', role: 'creator',
      onStateInsert: vi.fn(), onTaskChange: vi.fn(), onPresence: vi.fn(),
      onPlayhead: vi.fn(), onTransport: vi.fn(), onActivity: vi.fn(),
      onError, onReconnect,
    })

    channel.statusCb('CHANNEL_ERROR', new Error('down'))
    await channel.statusCb('SUBSCRIBED')

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('does not fire onReconnect on a clean first subscribe', async () => {
    const channel = fakeChannel()
    channel.subscribe = vi.fn((cb) => { channel.statusCb = cb; return channel })
    const onReconnect = vi.fn()
    joinProjectChannel(fakeSupabase(channel), {
      projectId: 'p1', userId: 'u1', role: 'creator',
      onStateInsert: vi.fn(), onTaskChange: vi.fn(), onPresence: vi.fn(),
      onPlayhead: vi.fn(), onTransport: vi.fn(), onActivity: vi.fn(),
      onReconnect,
    })

    await channel.statusCb('SUBSCRIBED')
    expect(onReconnect).not.toHaveBeenCalled()

    // ...but a later re-subscribe (drop + recover) does fire it.
    await channel.statusCb('SUBSCRIBED')
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('calls onError with status and err on CHANNEL_ERROR and does not call track', () => {
    const errorChannel = {
      ...fakeChannel(),
      subscribe: vi.fn((cb) => { cb('CHANNEL_ERROR', new Error('down')); return errorChannel }),
      track: vi.fn(async () => {}),
    }
    // fakeChannel's on() returns channel; wire it up for the error channel
    errorChannel.on = vi.fn(() => errorChannel)
    const onError = vi.fn()
    joinProjectChannel(fakeSupabase(errorChannel), {
      projectId: 'p1', userId: 'u1', role: 'creator',
      onStateInsert: vi.fn(), onTaskChange: vi.fn(), onPresence: vi.fn(),
      onPlayhead: vi.fn(), onTransport: vi.fn(), onActivity: vi.fn(),
      onError,
    })
    expect(onError).toHaveBeenCalledWith({ status: 'CHANNEL_ERROR', err: expect.any(Error) })
    expect(errorChannel.track).not.toHaveBeenCalled()
  })
})
