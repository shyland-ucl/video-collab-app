// Accept only same-origin absolute paths: single leading slash (not "//"),
// so values like "https://evil.com", "//evil.com", "@evil.com" fall back to "/".
export function safeNext(value) {
  return value && /^\/(?!\/)/.test(value) ? value : '/'
}
