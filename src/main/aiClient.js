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
export async function chat(ai, { messages, tools, signal, onDelta = () => {} }) {
  const url = joinUrl(ai.baseUrl, '/chat/completions')
  const body = {
    model: ai.model,
    messages,
    temperature: ai.temperature ?? 0.2,
    stream: true
  }
  if (tools?.length) {
    body.tools = tools
    body.tool_choice = 'auto'
  }

  const timeout = AbortSignal.timeout((ai.requestTimeoutSec || 600) * 1000)
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout

  let res
  try {
    res = await fetch(url, { method: 'POST', headers: headers(ai), body: JSON.stringify(body), signal: combined })
  } catch (e) {
    throw new Error(friendlyNetworkError(e, url))
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Model server error ${res.status}: ${text.slice(0, 600)}`)
  }

  const out = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null }
  const calls = new Map()

  const applyChoice = (choice) => {
    const d = choice.delta || choice.message || {}
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
    // Server ignored stream:true and returned a single JSON body.
    const json = await res.json()
    for (const c of json.choices || []) applyChoice(c)
    out.usage = json.usage || null
  } else {
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
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
        throw new Error(signal?.aborted ? 'Stopped.' : 'The model took too long to respond (request timeout).')
      }
      throw e
    }
  }

  out.toolCalls = [...calls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c], i) => ({ id: c.id || `call_${Date.now()}_${i}`, name: c.name, arguments: c.arguments }))
    .filter((c) => c.name)
  return out
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
