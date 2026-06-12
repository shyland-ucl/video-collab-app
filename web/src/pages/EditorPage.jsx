import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabaseClient'
import { useAuth } from '../contexts/AuthContext'
import { announce } from '../utils/announcer'
import { buildInitialState, loadLatestState, saveState, saveWithRebase } from '../lib/editor/stateStore'
import { joinProjectChannel } from '../lib/editor/projectChannel'
import { createTask, listTasks, setTaskStatus } from '../lib/editor/tasksApi'
import { summarizeEditStateChange } from '../lib/editor/projectOverview'
import CreatorDevice from '../components/editor/CreatorDevice'
import HelperDevice from '../components/editor/HelperDevice'

// Signed URLs live for 3600 s; refresh at 50 minutes so playback never lapses.
const URL_TTL_SECONDS = 3600
const URL_REFRESH_MS = 50 * 60 * 1000
const READY_POLL_MS = 60 * 1000
const TOAST_MS = 6000

const LOAD_ERROR_TEXT = "Couldn't load the editor — try again"
const MEMBER_ERROR_TEXT = 'Project not found, or you are not a member of it.'
const SYNC_DOWN_TEXT =
  "Live sync is unavailable — your edits still save, but you won't see your collaborator's changes until it reconnects"
const NEW_SCENES_TEXT = 'New scenes are available — reload the editor to include them.'
const CONFLICT_TEXT = "Your change conflicted with your helper's — the timeline was updated"
const SAVE_FAILED_TEXT = "That change didn't save — try again"

const TASK_STATUS_LABELS = { done: 'done', needs_discussion: 'needs discussion', cant_do: "can't do" }

function roleLabel(role) {
  if (role === 'helper') return 'Your helper'
  if (role === 'creator') return 'The creator'
  return 'Your collaborator'
}

export default function EditorPage() {
  const { projectId } = useParams()
  const { user } = useAuth()
  const userId = user?.id

  const [role, setRole] = useState(null)
  const [error, setError] = useState(null)
  const [snapshot, setSnapshot] = useState(null) // { version, state }
  const [sources, setSources] = useState([])
  const [descriptions, setDescriptions] = useState({})
  const [tasks, setTasks] = useState([])
  const [remote, setRemote] = useState({ playhead: null, transport: null, activity: null })
  const [syncDown, setSyncDown] = useState(false)
  const [toast, setToast] = useState(null)
  const [newScenes, setNewScenes] = useState(false)

  // Refs mirror the bits the realtime callbacks and applyAndSave need to read
  // without re-subscribing the channel on every render.
  const snapshotRef = useRef(null)
  const tasksRef = useRef([])
  const roleRef = useRef(null)
  const otherRoleRef = useRef(null)
  const otherOnlineRef = useRef(false)
  const channelRef = useRef(null)
  const videosRef = useRef([])
  const initialReadyCountRef = useRef(0)
  const newScenesAnnouncedRef = useRef(false)
  const toastTimerRef = useRef(null)

  const applySnapshot = useCallback((next) => {
    snapshotRef.current = next
    setSnapshot(next)
  }, [])

  const applyTasks = useCallback((updater) => {
    tasksRef.current = typeof updater === 'function' ? updater(tasksRef.current) : updater
    setTasks(tasksRef.current)
  }, [])

  const showToast = useCallback((text) => {
    if (!text) return
    setToast(text)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [])

  const refreshSources = useCallback(async (videos) => {
    if (!videos.length) {
      setSources([])
      return
    }
    const paths = videos.map((v) => v.storage_path)
    const { data: signed } = await supabase.storage.from('videos').createSignedUrls(paths, URL_TTL_SECONDS)
    const urlByPath = {}
    for (const item of signed ?? []) {
      if (!item.error) urlByPath[item.path] = item.signedUrl
    }
    setSources(
      videos.map((v) => ({
        id: v.id,
        name: v.original_name,
        src: urlByPath[v.storage_path] ?? null,
        duration: Number(v.duration_seconds),
      }))
    )
  }, [])

  useEffect(() => {
    if (!projectId || !userId) return undefined
    let cancelled = false
    let urlTimer = null
    let pollTimer = null

    function fail() {
      setError(LOAD_ERROR_TEXT)
      announce(LOAD_ERROR_TEXT, { assertive: true })
    }

    async function load() {
      // 1. Membership + role.
      const { data: member, error: memberErr } = await supabase
        .from('project_members')
        .select('role')
        .eq('project_id', projectId)
        .eq('user_id', userId)
        .maybeSingle()
      if (cancelled) return
      if (memberErr || !member) {
        setError(MEMBER_ERROR_TEXT)
        return
      }
      setRole(member.role)
      roleRef.current = member.role

      // 2. Ready videos.
      const { data: vids, error: vidsErr } = await supabase
        .from('videos')
        .select('id, original_name, status, duration_seconds, storage_path, created_at')
        .eq('project_id', projectId)
        .eq('status', 'ready')
        .order('created_at', { ascending: true })
      if (cancelled) return
      if (vidsErr) {
        fail()
        return
      }
      const videos = vids ?? []
      videosRef.current = videos
      initialReadyCountRef.current = videos.length

      // 3. Segments + all three description levels, keyed by root segment id.
      let segments = []
      if (videos.length > 0) {
        const { data: segs, error: segErr } = await supabase
          .from('segments')
          .select('id, video_id, idx, start_seconds, end_seconds, descriptions ( level, text )')
          .in('video_id', videos.map((v) => v.id))
          .order('idx')
        if (cancelled) return
        if (segErr) {
          fail()
          return
        }
        segments = segs ?? []
      }
      const descMap = {}
      for (const seg of segments) {
        const byLevel = {}
        for (const d of seg.descriptions ?? []) byLevel[d.level] = d.text
        descMap[seg.id] = byLevel
      }
      setDescriptions(descMap)

      // 4. Signed URLs for the originals (+ periodic refresh below).
      await refreshSources(videos)
      if (cancelled) return

      // 5. Latest edit state (bootstrap version 1 when none) + tasks.
      try {
        let latest = await loadLatestState(supabase, projectId)
        if (!latest) {
          const built = buildInitialState(videos, segments)
          const saved = await saveState(supabase, projectId, userId, built, 0)
          // A conflict here means the other member bootstrapped first — take theirs.
          latest = saved.ok ? { version: saved.version, state: built } : await loadLatestState(supabase, projectId)
        }
        if (cancelled) return
        if (!latest) {
          fail()
          return
        }
        applySnapshot(latest)

        const taskRows = await listTasks(supabase, projectId)
        if (cancelled) return
        applyTasks(taskRows)
      } catch {
        if (!cancelled) fail()
        return
      }

      // 6. Realtime channel.
      const channel = joinProjectChannel(supabase, {
        projectId,
        userId,
        role: member.role,
        onStateInsert: (row) => {
          if (!row || row.updated_by === userId) return
          const current = snapshotRef.current
          if (!current || Number(row.version) <= current.version) return
          const prev = current.state
          applySnapshot({ version: Number(row.version), state: row.state })
          const summary = summarizeEditStateChange(prev, row.state, roleLabel(otherRoleRef.current))
          // summarize returns an EMPTY announcement when nothing actually
          // changed (spurious re-insert) — stay silent in that case.
          if (summary.announcement) {
            announce(summary.announcement)
            showToast(summary.shortText)
          }
        },
        onTaskChange: ({ eventType, task }) => {
          if (!task?.id) return
          if (eventType === 'INSERT') {
            applyTasks((current) =>
              current.some((t) => t.id === task.id)
                ? current.map((t) => (t.id === task.id ? task : t))
                : [task, ...current]
            )
            if (roleRef.current === 'helper' && task.created_by !== userId) {
              announce(`Creator sent you a task: ${task.text}`)
            }
          } else if (eventType === 'UPDATE') {
            applyTasks((current) => current.map((t) => (t.id === task.id ? task : t)))
            if (roleRef.current === 'creator') {
              const statusLabel = TASK_STATUS_LABELS[task.status]
              if (statusLabel) announce(`Your helper marked a task ${statusLabel}`)
            }
          }
        },
        onPresence: (presenceState) => {
          const others = Object.entries(presenceState ?? {})
            .filter(([key]) => key !== userId)
            .flatMap(([, metas]) => metas)
          if (others[0]?.role) otherRoleRef.current = others[0].role
          const online = others.length > 0
          if (online !== otherOnlineRef.current) {
            otherOnlineRef.current = online
            announce(`${roleLabel(otherRoleRef.current)} ${online ? 'joined' : 'left'} the editor`)
          }
        },
        onPlayhead: (payload) => setRemote((r) => ({ ...r, playhead: payload })),
        onTransport: (payload) => setRemote((r) => ({ ...r, transport: payload })),
        onActivity: (payload) => setRemote((r) => ({ ...r, activity: payload })),
        onReconnect: async () => {
          setSyncDown(false)
          try {
            const latest = await loadLatestState(supabase, projectId)
            if (latest && latest.version > (snapshotRef.current?.version ?? 0)) {
              applySnapshot(latest)
            }
            const taskRows = await listTasks(supabase, projectId)
            applyTasks(taskRows)
          } catch {
            // Transient refetch failure — the next state insert or reconnect catches us up.
          }
        },
        onError: () => {
          setSyncDown(true)
          announce(SYNC_DOWN_TEXT, { assertive: true })
        },
      })
      if (cancelled) {
        channel.leave()
        return
      }
      channelRef.current = channel

      // URL refresh + new-ready-scenes poll.
      urlTimer = setInterval(() => refreshSources(videosRef.current), URL_REFRESH_MS)
      pollTimer = setInterval(async () => {
        const { data } = await supabase
          .from('videos')
          .select('id')
          .eq('project_id', projectId)
          .eq('status', 'ready')
        if ((data?.length ?? 0) > initialReadyCountRef.current && !newScenesAnnouncedRef.current) {
          newScenesAnnouncedRef.current = true
          setNewScenes(true)
          announce(NEW_SCENES_TEXT)
        }
      }, READY_POLL_MS)
    }

    load()

    return () => {
      cancelled = true
      if (urlTimer) clearInterval(urlTimer)
      if (pollTimer) clearInterval(pollTimer)
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
      channelRef.current?.leave()
      channelRef.current = null
    }
  }, [projectId, userId, applySnapshot, applyTasks, refreshSources, showToast])

  const applyAndSave = useCallback(
    async (opFn, announceText) => {
      const current = snapshotRef.current
      if (!current) return
      const next = opFn(current.state)
      // Optimistic local apply.
      applySnapshot({ version: current.version, state: next })
      const result = await saveWithRebase(supabase, projectId, userId, opFn, next, current.version)
      if (result.ok) {
        // The saved state may differ from the optimistic one after a rebase.
        applySnapshot({ version: result.version, state: result.state })
        if (announceText) announce(announceText)
        return
      }
      if (result.conflict) {
        try {
          const latest = await loadLatestState(supabase, projectId)
          if (latest) applySnapshot(latest)
        } catch {
          // Keep the optimistic state; realtime will deliver the winner.
        }
        announce(CONFLICT_TEXT, { assertive: true })
        return
      }
      // Plain failure — revert the optimistic apply.
      applySnapshot(current)
      announce(SAVE_FAILED_TEXT, { assertive: true })
    },
    [projectId, userId, applySnapshot]
  )

  const onCreateTask = useCallback(
    async ({ text, segmentLabel }) => {
      try {
        const task = await createTask(supabase, { projectId, userId, text, segmentLabel })
        applyTasks((current) => (current.some((t) => t.id === task.id) ? current : [task, ...current]))
        return task
      } catch (err) {
        announce('The task could not be sent — try again', { assertive: true })
        throw err
      }
    },
    [projectId, userId, applyTasks]
  )

  const onSetTaskStatus = useCallback(
    async (taskId, status) => {
      try {
        const task = await setTaskStatus(supabase, taskId, status)
        applyTasks((current) => current.map((t) => (t.id === task.id ? task : t)))
        return task
      } catch (err) {
        announce('The task status could not be saved — try again', { assertive: true })
        throw err
      }
    },
    [applyTasks]
  )

  const channelApi = useMemo(
    () => ({
      sendPlayhead: (payload) => channelRef.current?.sendPlayhead(payload),
      sendTransport: (payload) => channelRef.current?.sendTransport(payload),
      sendActivity: (payload) => channelRef.current?.sendActivity(payload),
    }),
    []
  )

  if (error) {
    return (
      <main id="main" tabIndex={-1} className="mx-auto max-w-lg p-4">
        <p role="alert">{error}</p>
        <Link to={`/projects/${projectId}`} className="underline">Back to project</Link>
      </main>
    )
  }
  if (!role || !snapshot) {
    return (
      <main id="main" tabIndex={-1} className="p-4">
        <p role="status">Loading the editor…</p>
      </main>
    )
  }

  const Device = role === 'creator' ? CreatorDevice : HelperDevice

  return (
    <main id="main" tabIndex={-1} className="p-4">
      {syncDown && (
        <p role="alert" className="mb-3 rounded border border-red-700 bg-red-50 p-3 text-red-700">
          {SYNC_DOWN_TEXT}
        </p>
      )}
      {newScenes && (
        <p role="status" className="mb-3 rounded border border-gray-300 p-3 text-lg">
          {NEW_SCENES_TEXT}
        </p>
      )}
      {toast && (
        <p role="status" className="mb-3 rounded border border-gray-300 bg-gray-50 p-3">
          {toast}
        </p>
      )}
      <Device
        role={role}
        projectId={projectId}
        user={user}
        state={snapshot.state}
        version={snapshot.version}
        sources={sources}
        descriptions={descriptions}
        tasks={tasks}
        applyAndSave={applyAndSave}
        channel={channelApi}
        remote={remote}
        onCreateTask={onCreateTask}
        onSetTaskStatus={onSetTaskStatus}
        syncDown={syncDown}
      />
    </main>
  )
}
