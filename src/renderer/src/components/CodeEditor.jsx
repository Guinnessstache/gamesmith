import Editor from '@monaco-editor/react'
import { useRef } from 'react'
import '../monaco.js'
import { languageFor } from './ui.jsx'

export default function CodeEditor({ path, value, onChange, onSave }) {
  const saveRef = useRef(onSave)
  saveRef.current = onSave
  return (
    <Editor
      path={path}
      language={languageFor(path)}
      value={value}
      theme="gamesmith"
      onChange={(v) => onChange(v ?? '')}
      onMount={(editor, monaco) => {
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveRef.current())
      }}
      options={{
        fontSize: 14,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 2,
        wordWrap: 'on',
        automaticLayout: true,
        padding: { top: 12 }
      }}
    />
  )
}
