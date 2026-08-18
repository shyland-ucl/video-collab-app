/**
 * Trial data export (design 2026-08-18) — dump the events log as CSV for
 * analysis: one combined file plus one per project (pair), with participant
 * email and role joined in. Researcher-only: needs the service role key.
 *
 * Run from repo root:
 *   node --env-file=server/.env scripts/export-events.mjs [--from 2026-09-01] [--to 2026-12-31] [--out export]
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in server/.env.
 */
import { createClient } from '@supabase/supabase-js'
import fs from 'node:fs/promises'
import path from 'node:path'

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (server/.env).')
  process.exit(1)
}

function arg(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt
}
const from = arg('from')
const to = arg('to')
const outDir = arg('out', 'export')

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })

// Every value CSV-escaped; payload serialized as JSON in one column.
const esc = (v) => {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const HEADER = 'created_at,project_id,project_title,user_id,email,role,event_type,payload'

function toRow(e, users, members, projects) {
  const u = users.get(e.user_id)
  const role = members.get(`${e.project_id}:${e.user_id}`) ?? ''
  const title = projects.get(e.project_id) ?? ''
  return [
    e.created_at, e.project_id ?? '', title, e.user_id ?? '',
    u ?? '', role, e.event_type, JSON.stringify(e.payload ?? {}),
  ].map(esc).join(',')
}

// --- load lookups -----------------------------------------------------------
const users = new Map()
{
  let page = 1
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 })
    if (error) { console.error('listUsers failed:', error.message); process.exit(1) }
    for (const u of data.users) users.set(u.id, u.email)
    if (data.users.length < 200) break
    page += 1
  }
}
const members = new Map()
{
  const { data, error } = await admin.from('project_members').select('project_id, user_id, role')
  if (error) { console.error('members query failed:', error.message); process.exit(1) }
  for (const m of data) members.set(`${m.project_id}:${m.user_id}`, m.role)
}
const projects = new Map()
{
  const { data, error } = await admin.from('projects').select('id, title')
  if (error) { console.error('projects query failed:', error.message); process.exit(1) }
  for (const p of data) projects.set(p.id, p.title)
}

// --- load events (paged, time-filtered) -------------------------------------
const events = []
{
  const PAGE = 1000
  for (let fromIdx = 0; ; fromIdx += PAGE) {
    let q = admin.from('events').select('*').order('created_at', { ascending: true })
      .range(fromIdx, fromIdx + PAGE - 1)
    if (from) q = q.gte('created_at', from)
    if (to) q = q.lte('created_at', to)
    const { data, error } = await q
    if (error) { console.error('events query failed:', error.message); process.exit(1) }
    events.push(...data)
    if (data.length < PAGE) break
  }
}
console.log(`${events.length} events${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}`)

// --- write ------------------------------------------------------------------
await fs.mkdir(outDir, { recursive: true })
const combined = [HEADER, ...events.map((e) => toRow(e, users, members, projects))].join('\n')
await fs.writeFile(path.join(outDir, 'events.csv'), combined + '\n')
console.log(`wrote ${path.join(outDir, 'events.csv')}`)

const byProject = new Map()
for (const e of events) {
  const key = e.project_id ?? 'no-project'
  if (!byProject.has(key)) byProject.set(key, [])
  byProject.get(key).push(e)
}
for (const [pid, list] of byProject) {
  const f = path.join(outDir, `events-${pid}.csv`)
  await fs.writeFile(f, [HEADER, ...list.map((e) => toRow(e, users, members, projects))].join('\n') + '\n')
  console.log(`wrote ${f} (${list.length} rows)`)
}
