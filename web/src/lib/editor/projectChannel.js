export const PLAYHEAD_THROTTLE_MS = 2000

export function joinProjectChannel(supabase, {
  projectId, userId, role,
  onStateInsert, onTaskChange, onPresence, onPlayhead, onTransport, onActivity,
  onReconnect, onError,
}) {
  const channel = supabase.channel(`project:${projectId}`, {
    config: { presence: { key: userId } },
  })

  channel
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'project_state', filter: `project_id=eq.${projectId}` },
      (payload) => onStateInsert?.(payload.new))
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'tasks', filter: `project_id=eq.${projectId}` },
      // realtime-js leaves payload.new as {} (not null) on DELETE
      (payload) => onTaskChange?.({
        eventType: payload.eventType,
        task: payload.eventType === 'DELETE' ? payload.old : payload.new,
      }))
    .on('presence', { event: 'sync' }, () => onPresence?.(channel.presenceState()))
    .on('broadcast', { event: 'playhead' }, ({ payload }) => onPlayhead?.(payload))
    .on('broadcast', { event: 'transport' }, ({ payload }) => onTransport?.(payload))
    .on('broadcast', { event: 'activity' }, ({ payload }) => onActivity?.(payload))

  let subscribedOnce = false
  let hadError = false
  channel.subscribe(async (status, err) => {
    if (status === 'SUBSCRIBED') {
      await channel.track({ userId, role })
      // Fire onReconnect on any re-subscribe AND on a first subscribe that
      // follows an error — the caller's sync-down alarm must clear either way.
      if (subscribedOnce || hadError) onReconnect?.()
      subscribedOnce = true
      hadError = false
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
      hadError = true
      // the editor must be able to TELL the user sync is down
      onError?.({ status, err })
    }
  })

  let lastPlayhead = 0
  function sendPlayhead(payload) {
    const now = Date.now()
    if (now - lastPlayhead < PLAYHEAD_THROTTLE_MS) return
    lastPlayhead = now
    channel.send({ type: 'broadcast', event: 'playhead', payload: { ...payload, actor: role } })
  }

  const sendTransport = (payload) =>
    channel.send({ type: 'broadcast', event: 'transport', payload: { ...payload, actor: role } })
  const sendActivity = (payload) =>
    channel.send({ type: 'broadcast', event: 'activity', payload: { ...payload, actor: role } })

  return {
    sendPlayhead,
    sendTransport,
    sendActivity,
    leave: () => supabase.removeChannel(channel),
  }
}
