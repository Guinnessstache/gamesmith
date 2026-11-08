// The AI timeout counts silence, not total time: a slow model that keeps writing is fine.
import http from 'node:http'
import { chat, findLoop } from '../src/main/aiClient.js'

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
  } else if (mode === 'loop') {
    // a thinking model going round in circles
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Let me plan the barrel. I need a cylinder of radius 0.3. ' } }] })}\n\n`)
    for (let k = 0; k < 400 && !res.destroyed; k++) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'Wait, let me reconsider the hoops. Actually the hoops should be torus shapes around the barrel. ' } }] })}\n\n`)
      await sleep(2)
    }
  } else if (mode === 'length') {
    res.write(chunk('Thinking about it some more and more '))
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\n`)
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

const loop = await chat({ ...base('loop'), requestTimeoutSec: 60 }, { messages }).catch((e) => e)
ok(loop instanceof Error && /stuck repeating itself/.test(loop.message) && /reconsider the hoops/.test(loop.message), `a model looping in its thinking is stopped early: "${loop.message?.slice(0, 160)}…"`)

const long = await chat(base('length'), { messages }).catch((e) => e)
ok(long instanceof Error && /token limit for one reply/.test(long.message) && /some more and more/.test(long.message), 'hitting the reply length limit says so and shows the last words')

const script = Array.from({ length: 60 }, (_, k) => `rig.limb("Part${k}", width=0.${k % 9 + 1}, material=shirt, extend=0.01)\nbpy.ops.mesh.primitive_cube_add(size=1, location=(${k}, 0, 0))\n`).join('')
ok(!findLoop(script) && !findLoop('x'.repeat(100)), 'long scripts with similar lines are not mistaken for a loop')
ok(findLoop('intro '.repeat(10) + 'ok ok ok '.repeat(400)) === 'ok ok ok' || /ok/.test(findLoop('intro '.repeat(10) + 'ok ok ok '.repeat(400))), 'a short phrase repeated is a loop')

const stop = new AbortController()
setTimeout(() => stop.abort(), 200)
const stopped = await chat({ ...base('slow'), requestTimeoutSec: 60 }, { messages, signal: stop.signal }).catch((e) => e)
ok(stopped instanceof Error && stopped.message === 'Stopped.', 'the Stop button still stops it')

server.close()
console.log(failed ? `FAIL  AI timeout: ${failed} failed` : 'PASS  AI timeout: slow but steady models finish; silence, stalls, loops, length limit and Stop are handled')
process.exit(failed ? 1 : 0)
