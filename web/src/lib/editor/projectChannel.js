export const PLAYHEAD_THROTTLE_MS = 2000

export function joinProjectChannel(supabase, {
  projectId, userId, role,
  onStateInsert, onTaskChange, onPresence, onPlayhead, onTransport, onActivity,
  onReconnect,
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
      (payload) => onTaskChange?.({ eventType: payload.eventType, task: payload.new ?? payload.old }))
    .on('presence', { event: 'sync' }, () => onPresence?.(channel.presenceState()))
    .on('broadcast', { event: 'playhead' }, ({ payload }) => onPlayhead?.(payload))
    .on('broadcast', { event: 'transport' }, ({ payload }) => onTransport?.(payload))
    .on('broadcast', { event: 'activity' }, ({ payload }) => onActivity?.(payload))

  let subscribedOnce = false
  channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await channel.track({ userId, role })
      if (subscribedOnce) onReconnect?.()
      subscribedOnce = true
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
