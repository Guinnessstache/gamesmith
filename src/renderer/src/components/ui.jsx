export function AiBadge({ settings, onClick }) {
  const ready = !!settings.ai.model
  let host = ''
  try {
    host = new URL(settings.ai.baseUrl).hostname
  } catch {
    host = 'not set'
  }
  return (
    <button className={`ai-badge ${ready ? 'ready' : 'missing'}`} onClick={onClick} title={settings.ai.baseUrl}>
      <span className="dot" aria-hidden />
      {ready ? (
        <>
          <span className="ai-model">{settings.ai.model}</span>
          <span className="ai-host">on {host}</span>
        </>
      ) : (
        <span>No AI model selected</span>
      )}
    </button>
  )
}

export function TemplateGlyph({ template }) {
  if (template === 'three-3d') {
    return (
      <svg className="glyph" viewBox="0 0 48 48" aria-hidden>
        <path d="M24 6 40 15v18L24 42 8 33V15z" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
        <path d="M8 15l16 9 16-9M24 24v18" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinejoin="round" />
      </svg>
    )
  }
  return (
    <svg className="glyph" viewBox="0 0 48 48" aria-hidden>
      <rect x="6" y="34" width="36" height="6" rx="1.5" fill="currentColor" opacity=".55" />
      <rect x="26" y="22" width="14" height="5" rx="1.5" fill="currentColor" opacity=".55" />
      <rect x="11" y="18" width="9" height="12" rx="2.5" fill="currentColor" />
      <circle cx="33" cy="13" r="4" fill="currentColor" />
    </svg>
  )
}

export function timeAgo(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hr ago`
  const d = Math.round(h / 24)
  return d === 1 ? 'yesterday' : `${d} days ago`
}

export function languageFor(path) {
  const ext = path.split('.').pop().toLowerCase()
  return (
    { js: 'javascript', mjs: 'javascript', json: 'json', html: 'html', htm: 'html', css: 'css', md: 'markdown', glsl: 'cpp', vert: 'cpp', frag: 'cpp', svg: 'xml' }[ext] ||
    'plaintext'
  )
}

export const isImage = (p) => /\.(png|jpe?g|gif|webp|svg|ico)$/i.test(p)
export const isTextFile = (p) => /\.(html?|css|m?js|json|md|txt|glsl|vert|frag|svg|csv|gitignore)$/i.test(p) || !p.split('/').pop().includes('.')
