export function makeRequireAuth(supabaseClient) {
  return async function requireAuth(req, res, next) {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) {
      return res.status(401).json({ error: 'missing_token' })
    }
    const { data, error } = await supabaseClient.auth.getUser(token)
    if (error || !data?.user) {
      return res.status(401).json({ error: 'invalid_token' })
    }
    req.user = data.user
    next()
  }
}
