// The AI timeout counts silence, not total time: a slow model that keeps writing is fine.
import http from 'node:http'
import { chat, findLoop } from '../src/main/aiClient.js'

let failed = 0
const seen = []
const ok = (c, m) => {
  console.log(`${c ? 'ok  ' : 'FAIL'} ${m}`)
  if (!c) failed++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const chunk = (text) => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`

const server = http.createServer(async (req, res) => {
  let raw = ''
  for await (const c of req) raw += c
  const body = raw ? JSON.parse(raw) : {}
  const mode = req.url.split('/')[1]
  seen.push({ mode, body })
  if (mode === 'strict' && body.chat_template_kwargs) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ error: { message: 'unknown field chat_template_kwargs' } }))
  }
  const nudged = (body.messages || []).some((m) => /planned enough/.test(m.content || ''))
  if ((mode === 'planner' || mode === 'stubborn') && !(mode === 'planner' && nudged)) {
    // a thinking model that plans and plans (never the same sentence twice)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    for (let k = 0; k < 3000 && !res.destroyed; k++) {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: `Consideration ${k}: maybe the lid should be ${k % 7} cm thicker, or the hinges at ${k * 3} mm. ` } }] })}\n\n`)
      if (k % 20 === 0) await sleep(1)
    }
    return res.end('data: [DONE]\n\n')
  }
  if (mode === 'planner' || mode === 'strict') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'OK, writing it.' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_script', arguments: '{"content":"x"}' } }] }, finish_reason: 'tool_calls' }] })}\n\n`)
    return res.end('data: [DONE]\n\n')
  }
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
    for (let k = 0; k < 2 && !res.destroyed; k++) {
      res.write(': still thinking\n\n') // SSE comment, no tokens
      await sleep(300)
    }
    res.write(chunk('done'))
  } else if (mode === 'pingsonly') {
    // keeps the connection open with pings but never produces anything (queued or stuck)
    for (let k = 0; k < 20 && !res.destroyed; k++) {
      res.write(': ping\n\n')
      await sleep(200)
    }
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
ok(!(kept instanceof Error) && kept.content === 'done', 'keep-alive messages before the answer are fine')

const pings = await chat(base('pingsonly'), { messages }).catch((e) => e)
ok(pings instanceof Error && /sent no text at all/.test(pings.message), `pings with no output don't keep it waiting: "${pings.message?.slice(0, 120)}…"`)

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

const notes = []
const plan = await chat({ ...base('planner'), requestTimeoutSec: 60, maxThinkingTokens: 2000 }, { messages, onDelta: (d) => d.reasoning && /Gamesmith:/.test(d.reasoning) && notes.push(d.reasoning) }).catch((e) => e)
const retry = seen.filter((r) => r.mode === 'planner').at(-1)?.body
ok(!(plan instanceof Error) && plan.toolCalls[0]?.name === 'write_script' && notes.length === 1, `too much planning: stopped, then asked again and it acts (${plan.message || plan.toolCalls?.[0]?.name})`)
ok(retry?.chat_template_kwargs?.enable_thinking === false && /planned enough/.test(retry.messages.at(-1).content), 'the second try turns thinking off and tells it to act now')
const stubborn = await chat({ ...base('stubborn'), requestTimeoutSec: 60, maxThinkingTokens: 2000 }, { messages }).catch((e) => e)
ok(stubborn instanceof Error && /Model thinking/.test(stubborn.message), `a model that keeps planning anyway gets clear advice: "${stubborn.message?.slice(0, 110)}…"`)
const strict = await chat({ ...base('strict'), thinking: 'off' }, { messages }).catch((e) => e)
const strictReqs = seen.filter((r) => r.mode === 'strict')
ok(!(strict instanceof Error) && strictReqs.length === 2 && !strictReqs[1].body.chat_template_kwargs, 'a server that rejects the thinking settings is asked again without them')
const unlimited = await chat({ ...base('slow'), maxThinkingTokens: 0 }, { messages }).catch((e) => e)
ok(!(unlimited instanceof Error) && !seen.filter((r) => r.mode === 'slow').at(-1).body.chat_template_kwargs, 'by default (Let the model decide) no thinking settings are sent')

const stop = new AbortController()
setTimeout(() => stop.abort(), 200)
const stopped = await chat({ ...base('slow'), requestTimeoutSec: 60 }, { messages, signal: stop.signal }).catch((e) => e)
ok(stopped instanceof Error && stopped.message === 'Stopped.', 'the Stop button still stops it')

server.close()
console.log(failed ? `FAIL  AI timeout: ${failed} failed` : 'PASS  AI timeout: slow but steady models finish; silence, stalls, loops, too much planning, length limit and Stop are handled')
process.exit(failed ? 1 : 0)
