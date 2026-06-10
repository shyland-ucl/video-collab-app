export function buildInviteUrl(origin, token) {
  return `${origin.replace(/\/+$/, '')}/join/${token}`
}
