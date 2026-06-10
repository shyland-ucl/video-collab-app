// Raw SMTP handshake diagnostic: EHLO -> STARTTLS -> AUTH LOGIN -> MAIL FROM -> RCPT TO
// Usage: node --env-file=.env scripts/diag-smtp.mjs <user> <from> <to>
import net from 'node:net'
import tls from 'node:tls'

const [user, from, to] = process.argv.slice(2)
const pass = process.env.SMTP_PASS
const host = 'smtp-relay.brevo.com'
const port = 587

function talk(socket, cmd) {
  return new Promise((resolve) => {
    let buf = ''
    const onData = (d) => {
      buf += d.toString()
      // complete when last line is "NNN " (space after code)
      if (/^\d{3} [^\r\n]*\r?\n$/m.test(buf.split(/\r?\n/).filter(Boolean).pop() + '\n')) {
        socket.off('data', onData)
        resolve(buf.trim())
      }
    }
    socket.on('data', onData)
    if (cmd !== null) socket.write(cmd + '\r\n')
  })
}

const plain = net.createConnection(port, host)
plain.setTimeout(15000, () => { console.log('TIMEOUT'); process.exit(1) })
await new Promise((r) => plain.once('connect', r))
console.log('banner:', await talk(plain, null))
console.log('EHLO:', (await talk(plain, 'EHLO diag.local')).split('\n')[0])
console.log('STARTTLS:', await talk(plain, 'STARTTLS'))

const sec = tls.connect({ socket: plain, servername: host })
await new Promise((r) => sec.once('secureConnect', r))
console.log('EHLO(tls):', (await talk(sec, 'EHLO diag.local')).split('\n')[0])
console.log('AUTH:', await talk(sec, 'AUTH LOGIN'))
console.log('user:', await talk(sec, Buffer.from(user).toString('base64')))
console.log('pass:', await talk(sec, Buffer.from(pass).toString('base64')))
console.log('MAIL FROM:', await talk(sec, `MAIL FROM:<${from}>`))
console.log('RCPT TO:', await talk(sec, `RCPT TO:<${to}>`))
await talk(sec, 'QUIT').catch(() => {})
sec.end()
process.exit(0)
