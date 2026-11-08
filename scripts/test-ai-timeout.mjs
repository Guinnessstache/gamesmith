// The AI timeout counts silence, not total time: a slow model that keeps writing is fine.
import http from 'node:http'
import { chat } from '../src/main/aiClient.js'

let failed = 0
const ok = (c, m) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`)
  if (!c) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chunk = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`

const server = http.createServer(async (req, res) => {
  for await (const _ of req);
  const mode = req.url.split('/')[1]
  if (mode === 'never') {
    await sleep(2500) // still reading the prompt: no headers yet
    if (res.destroyed) return
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  if (mode === 'slow') {
    // 12 tokens, one every 300 ms: 3.6 s in all, longer than the 1 s timeout
    for (let k = 0; k < 12 && !res.destroyed; k++) {
      res.write(chunk(`t${k} `))
      await sleep(300)
    }
  } else if (mode === 'keepalive') {
    for (let k = 0; k < 6 && !res.destroyed; k++) {
      res.write(': still thinking\n\n') // SSE comment, no tokens
      await sleep(400)
    }
    res.write(chunk('done'))
  } else if (mode === 'stall') {
    res.write(chunk('partial answer'))
    await sleep(3000)
  }
  if (!res.destroyed) res.end('data: [DONE]\n\n')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = (mode) => ({ baseUrl: `http://127.0.0.1:${server.address().port}/${mode}`, model: 'm', requestTimeoutSec: 1 })
const messages = [{ role: 'user', content: 'hi' }]

const t0 = Date.now()
const slow = await chat(base('slow'), { messages }).catch((e) => e)
ok(!(slow instanceof Error) && slow.content.trim().split(' ').length === 12, `a model that keeps writing for ${((Date.now() - t0) / 1000).toFixed(1)} s with a 1 s timeout finishes`)

const kept = await chat(base('keepalive'), { messages }).catch((e) => e)
ok(!(kept instanceof Error) && kept.content === 'done', 'keep-alive messages from the server count as working')

const stall = await chat(base('stall'), { messages }).catch((e) => e)
ok(stall instanceof Error && /stopped sending anything for 1 s/.test(stall.message) && /14 characters/.test(stall.message), `a model that goes quiet mid-answer is stopped: "${stall.message}"`)

const never = await chat(base('never'), { messages }).catch((e) => e)
ok(never instanceof Error && /didn't start answering within 1 s/.test(never.message) && /Settings/.test(never.message), `a model that never starts gets advice: "${never.message}"`)

const stop = new AbortController()
setTimeout(() => stop.abort(), 200)
const stopped = await chat({ ...base('slow'), requestTimeoutSec: 60 }, { messages, signal: stop.signal }).catch((e) => e)
ok(stopped instanceof Error && stopped.message === 'Stopped.', 'the Stop button still stops it')

server.close()
console.log(failed ? `FAIL  AI timeout: ${failed} failed` : 'PASS  AI timeout: slow but steady models finish; silence, stalls and Stop are handled')
process.exit(failed ? 1 : 0)
