// Minimal OpenAI-compatible client. Runs in the Electron main process (Node),
// so there are no browser CORS or mixed-content limits when talking to a
// model server elsewhere on the LAN (e.g. the Mac Studio).

function joinUrl(base, path) {
  return base.replace(/\/+$/, '') + path
}

function headers(ai) {
  const h = { 'Content-Type': 'application/json' }
  if (ai.apiKey) h.Authorization = `Bearer ${ai.apiKey}`
  return h
}

function friendlyNetworkError(e, url) {
  const code = e?.cause?.code || e?.code || ''
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Can't find the host in ${url}. Try the Mac's IP address instead of its name.`
  if (code === 'ECONNREFUSED') return `Connection refused at ${url}. Is the model server running and listening on the network (not just localhost)?`
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return `Timed out connecting to ${url}. Check the address and firewall.`
  if (e?.name === 'AbortError') return 'Stopped.'
  return `${e?.message || e}${code ? ` (${code})` : ''}`
}

export async function listModels(ai) {
  const url = joinUrl(ai.baseUrl, '/models')
  let res
  try {
    res = await fetch(url, { headers: headers(ai), signal: AbortSignal.timeout(8000) })
  } catch (e) {
    throw new Error(friendlyNetworkError(e, url))
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} from ${url}`)
  const json = await res.json()
  const list = json.data || json.models || []
  return list.map((m) => m.id || m.name || m.model).filter(Boolean).sort()
}

/**
 * Streamed chat completion. Calls onDelta({ content, reasoning }) as tokens
 * arrive and resolves to { content, reasoning, toolCalls, finishReason, usage }.
 */
// How servers are asked to think less. Each server reads the fields it knows and (usually) ignores
// the rest; one that rejects them gets the request again without them.
const THINKING = {
  auto: null,
  short: { reasoning_effort: 'low', chat_template_kwargs: { reasoning_effort: 'low' } },
  off: { reasoning_effort: 'low', think: false, chat_template_kwargs: { enable_thinking: false, thinking: false } }
}
const noExtras = new Set() // servers that rejected the extra fields

const NUDGE =
  "You have planned enough. Stop planning and act now: make the tool call (write the script, or make the change) with a simple version that works. You can improve it after it's built."

/**
 * Chat with a thinking budget. Thinking models can plan for a very long time before answering
 * (tens of thousands of tokens, which is half an hour on a slow computer). When the planning
 * passes the budget, the request is stopped and sent again with thinking turned down and a nudge
 * to act now.
 */
export async function chat(ai, opts) {
  const mode = THINKING[ai.thinking] !== undefined ? ai.thinking : 'auto'
  try {
    return await chatOnce(ai, { ...opts, thinking: mode })
  } catch (e) {
    if (e.code !== 'THINKING_BUDGET') throw e
    const used = useDraft(e, opts)
    if (used) return used
    opts.onDelta?.({ reasoning: `\n\n[Gamesmith: that's ${e.tokens.toLocaleString()} tokens of planning. Asking the model to stop planning and write it now.]\n\n` })
    const messages = [...opts.messages, { role: 'user', content: NUDGE }]
    try {
      return await chatOnce(ai, { ...opts, messages, thinking: 'off', budgetTokens: Math.max(2000, Math.round(e.budget / 2)) })
    } catch (e2) {
      if (e2.code !== 'THINKING_BUDGET') throw e2
      const used2 = useDraft(e2, opts)
      if (used2) return used2
      throw new Error(
        `The model planned for ${e.tokens.toLocaleString()} tokens, was asked to stop, and planned for another ${e2.tokens.toLocaleString()} without writing anything. ` +
          'Set "Model thinking" to Off in Settings → Advanced, or use a model without thinking for Blender models.'
      )
    }
  }
}

/** The last finished code block in the model's thinking that looks like the answer (or ''). */
export function draftFrom(thoughts, looksRight = (code) => code.split('\n').length >= 4) {
  const blocks = [...String(thoughts).matchAll(/```[\w-]*[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1].trim())
  for (let k = blocks.length - 1; k >= 0; k--) if (looksRight(blocks[k])) return blocks[k]
  return ''
}

// opts.draftTool: { name, argument, check(code) } — a tool that can take a draft written in the thinking
// The Blender modeling agent's write_script tool takes a script drafted while planning.
const BLENDER_DRAFT = {
  name: 'write_script',
  argument: 'content',
  label: 'script',
  check: (code) => /\b(bpy\.|mat\(|assign\(|texture\(|terrain\(|Rig\.|smooth\()/.test(code) && code.split('\n').length >= 4
}

function useDraft(e, opts) {
  const tool = opts.draftTool ?? (opts.tools?.some((t) => t.function?.name === 'write_script') ? BLENDER_DRAFT : null)
  if (!tool || !e.draft || (tool.check && !tool.check(e.draft))) return null
  opts.onDelta?.({ reasoning: `\n\n[Gamesmith: the model wrote its ${tool.label || 'answer'} while planning, so Gamesmith is using that.]\n\n` })
  return {
    content: '',
    reasoning: '',
    finishReason: 'tool_calls',
    usage: null,
    toolCalls: [{ id: `draft_${Date.now()}`, name: tool.name, arguments: JSON.stringify({ [tool.argument]: e.draft }) }]
  }
}

async function chatOnce(ai, { messages, tools, signal, onDelta = () => {}, thinking = 'auto', budgetTokens }) {
  const url = joinUrl(ai.baseUrl, '/chat/completions')
  const body = {
    model: ai.model,
    messages,
    temperature: ai.temperature ?? 0.2,
    // a cap on one reply (thinking included), so a model that loops can't run forever
    max_tokens: Number(ai.maxReplyTokens) || 32768,
    stream: true
  }
  if (tools?.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }
  const extras = THINKING[thinking]
  if (extras && !noExtras.has(ai.baseUrl)) Object.assign(body, extras)
  // planning allowed before the model must start answering (0 = no limit)
  const budget = budgetTokens ?? (Number.isFinite(Number(ai.maxThinkingTokens)) ? Number(ai.maxThinkingTokens) : 6000)

  // The timeout is for silence, not total time: a slow local model that keeps writing is fine,
  // however long the answer. It fails only when nothing arrives for that long (or after 30 minutes).
  const idleMs = Math.max(1, Number(ai.requestTimeoutSec) || 600) * 1000
  const started = Date.now()
  const quiet = new AbortController()
  let timedOut = ''
  let timer
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = 'idle'
      quiet.abort()
    }, idleMs)
  }
  const ceiling = setTimeout(() => {
    timedOut = 'total'
    quiet.abort()
  }, Math.max(idleMs, 30 * 60 * 1000))
  arm()
  const combined = signal ? AbortSignal.any([signal, quiet.signal]) : quiet.signal
  const received = { chars: 0, text: '' } // text: the last part of what it wrote, for error messages
  const tail = () => {
    const t = received.text.replace(/\s+/g, ' ').trim().slice(-300)
    return t ? `\nIts last words were: "…${t}"` : ''
  }
  const rate = () => {
    const secs = (Date.now() - started) / 1000
    return secs > 1 ? `about ${Math.round(received.chars / 4 / secs)} tokens per second` : ''
  }
  let looping = ''
  let overBudget = 0
  let draft = ''
  let streaming = false
  const timeoutError = () => {
    const secs = Math.round((Date.now() - started) / 1000)
    if (overBudget) return Object.assign(new Error(`Planned for ${overBudget} tokens without answering.`), { code: 'THINKING_BUDGET', tokens: overBudget, budget, draft })
    if (looping) {
      return new Error(
        `The model got stuck repeating itself, so Gamesmith stopped it after ${secs} s. It kept writing: "${looping}"\n` +
          'Try again, or raise Temperature in Settings a little (0.6 suits most thinking models).'
      )
    }
    if (timedOut === 'total') {
      return new Error(
        `The model was still writing after ${Math.round(secs / 60)} minutes (${received.chars.toLocaleString()} characters, ${rate()}), so Gamesmith stopped it.` +
          tail()
      )
    }
    if (!received.chars && received.pings) {
      return new Error(
        `The model server kept the connection open for ${secs} s but sent no text at all, so the model may not be running. ` +
          'Check the model server on the Mac: the model may still be loading, the request may be queued behind another one, or the server may be stuck (restarting it usually helps).'
      )
    }
    return new Error(
      received.chars
        ? `The model stopped sending anything for ${idleMs / 1000} s (after ${secs} s and ${received.chars.toLocaleString()} characters). The model server may have stalled or run out of memory.${tail()}`
        : `The model didn't start answering within ${idleMs / 1000} s. A big model can take that long to read a long request: raise "Request timeout" in Settings → Advanced, or check that the model server is still running.`
    )
  }
  const done = () => {
    clearTimeout(timer)
    clearTimeout(ceiling)
  }

  let res
  try {
    res = await fetch(url, { method: 'POST', headers: headers(ai), body: JSON.stringify(body), signal: combined })
  } catch (e) {
    done()
    if (timedOut && !signal?.aborted) throw timeoutError()
    throw new Error(friendlyNetworkError(e, url))
  }
  arm()
  if (!res.ok) {
    done()
    if (extras && !noExtras.has(ai.baseUrl) && (res.status === 400 || res.status === 422)) {
      noExtras.add(ai.baseUrl) // this server doesn't take the thinking settings: ask again without them
      return chatOnce(ai, { messages, tools, signal, onDelta, thinking: 'auto', budgetTokens })
    }
    const text = await res.text().catch(() => '')
    throw new Error(`Model server error ${res.status}: ${text.slice(0, 600)}`)
  }

  const out = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null }
  const calls = new Map()

  const applyChoice = (choice) => {
    const d = choice.delta || choice.message || {}
    const piece = (d.reasoning_content || d.reasoning || '') + (d.content || '')
    if (piece || d.tool_calls?.length) arm()
    if (d.tool_calls?.length) received.acting = true
    if (budget > 0 && streaming && !received.acting) {
      // planning so far: the reasoning, plus any <think> section the server leaves in the text
      const visible = out.content + (d.content || '')
      const open = visible.trimStart().startsWith('<think>') && !visible.includes('</think>')
      const planned = out.reasoning.length + (d.reasoning_content || d.reasoning || '').length + (open ? visible.length : 0)
      const answering = !open && visible.replace(/<think>[\s\S]*?<\/think>/g, '').trim().length > 0
      if (answering) received.acting = true
      else if (planned / 4 > budget) {
        // Many thinking models draft the answer inside their thinking ("Final script: ```python ...").
        // Let a draft that's being written finish, then stop and hand it over.
        const thoughts = out.reasoning + (d.reasoning_content || d.reasoning || '') + (open ? visible : '')
        const fences = (thoughts.match(/```/g) || []).length
        const drafting = fences % 2 === 1 && planned / 4 < budget * 3
        if (!drafting) {
          overBudget = Math.round(planned / 4)
          draft = draftFrom(thoughts)
          quiet.abort()
          throw Object.assign(new Error('budget'), { name: 'AbortError' })
        }
      }
    }
    if (piece) {
      received.chars += piece.length
      received.text = (received.text + piece).slice(-8000)
      if (streaming && received.chars - (received.checkedAt || 0) > 500) {
        received.checkedAt = received.chars
        const rep = findLoop(received.text)
        if (rep) {
          looping = rep
          quiet.abort()
          throw Object.assign(new Error('loop'), { name: 'AbortError' })
        }
      }
    }
    if (d.content) {
      out.content += d.content
      onDelta({ content: d.content })
    }
    const r = d.reasoning_content || d.reasoning
    if (r) {
      out.reasoning += r
      onDelta({ reasoning: r })
    }
    if (Array.isArray(d.tool_calls)) {
      d.tool_calls.forEach((tc, i) => {
        const idx = tc.index ?? i
        const cur = calls.get(idx) || { id: '', name: '', arguments: '' }
        if (tc.id) cur.id = tc.id
        if (tc.function?.name) cur.name += tc.function.name
        if (tc.function?.arguments != null) {
          cur.arguments += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments)
        }
        calls.set(idx, cur)
      })
    }
    if (choice.finish_reason) out.finishReason = choice.finish_reason
  }

  const ctype = res.headers.get('content-type') || ''
  if (!ctype.includes('text/event-stream')) {
    // Server ignored stream:true and returned a single JSON body (nothing arrives until it's finished).
    let json
    try {
      json = await res.json()
    } catch (e) {
      if (combined.aborted) throw signal?.aborted ? new Error('Stopped.') : timeoutError()
      throw e
    } finally {
      done()
    }
    for (const c of json.choices || []) applyChoice(c)
    out.usage = json.usage || null
  } else {
    streaming = true
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done: ended } = await reader.read()
        if (ended) break
        // Only real output counts as progress. Keep-alive pings don't: a server can send those while the
        // request sits in a queue or the model never starts, and then the computer isn't working on it at all.
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (line.startsWith(':')) received.pings = (received.pings || 0) + 1
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (data === '[DONE]') continue
          let json
          try {
            json = JSON.parse(data)
          } catch {
            continue
          }
          if (json.error) throw new Error(`Model server error: ${json.error.message || JSON.stringify(json.error)}`)
          for (const c of json.choices || []) applyChoice(c)
          if (json.usage) out.usage = json.usage
        }
      }
    } catch (e) {
      if (e.name === 'AbortError' || combined.aborted) {
        throw signal?.aborted ? new Error('Stopped.') : timeoutError()
      }
      throw e
    } finally {
      done()
    }
  }

  if (out.finishReason === 'length' && !calls.size) {
    throw new Error(
      `The model wrote ${received.chars.toLocaleString()} characters (the ${body.max_tokens.toLocaleString()}-token limit for one reply) without finishing. ` +
        `Thinking models sometimes go round in circles: try again, or raise "Longest reply" in Settings → Advanced.${tail()}`
    )
  }

  out.toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c], i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, arguments: c.arguments }))
    .filter((c) => c.name)
  return out
}

/**
 * A model stuck in a loop writes the same passage over and over. Returns the repeated text, or ''.
 * Looks for the last 200 characters appearing 6+ times in the last 8,000 (normal code and prose
 * almost never repeat a 200-character run exactly, even with similar lines).
 */
export function findLoop(text) {
  if (text.length < 1500) return ''
  const probe = text.slice(-200)
  if (!probe.trim() || /^(.)\1*$/s.test(probe)) return /^(.)\1*$/s.test(probe) && probe.trim() ? probe.slice(0, 40) : ''
  let count = 0
  for (let i = text.indexOf(probe); i >= 0; i = text.indexOf(probe, i + 1)) if (++count >= 6) break
  if (count < 6) return ''
  // the shortest repeating unit, for the message
  for (let n = 10; n <= 200; n++) {
    const unit = text.slice(-n)
    if (text.slice(-n * 3) === unit.repeat(3)) return unit.replace(/\s+/g, ' ').trim().slice(0, 200)
  }
  return probe.replace(/\s+/g, ' ').trim()
}

/**
 * Some servers (or chat templates) leave tool calls inside the text, e.g.
 * Qwen's <tool_call>{...}</tool_call>. Recover those so the agent still works.
 */
export function extractTextToolCalls(content) {
  const found = []
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let m
  while ((m = re.exec(content))) {
    try {
      const j = JSON.parse(m[1].replace(/^```(?:json)?|```$/g, '').trim())
      if (j.name) {
        found.push({
          id: `text_call_${Date.now()}_${found.length}`,
          name: j.name,
          arguments: typeof j.arguments === 'string' ? j.arguments : JSON.stringify(j.arguments || j.parameters || {})
        })
      }
    } catch {
      /* ignore malformed */
    }
  }
  return found
}

/** Split out <think>…</think> blocks that some servers leave in the content. */
export function splitThinking(content) {
  let reasoning = ''
  const visible = content
    .replace(/<think>([\s\S]*?)(<\/think>|$)/g, (_m, t) => {
      reasoning += t
      return ''
    })
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .trim()
  return { visible, reasoning }
}
