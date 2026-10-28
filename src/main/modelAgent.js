// The modeling AI: writes and fixes a Blender Python script for one library asset.
//
// Same loop shape as the game agent (agent.js): native or text tool calls, then an
// automatic build when the model says it's done, with build errors sent back for a fix.
import { chat, extractTextToolCalls, splitThinking } from './aiClient.js'
import { applyEdit, parseArgs } from './agent.js'
import * as library from './library.js'

const HISTORY_TURNS = 10

function motionList() {
  let list = []
  try {
    list = library.listMotions()
  } catch {
    /* no library */
  }
  if (!list.length) return 'The user has no recorded motions yet (they record them in the Motions section). Keyframe clips with rig.pose instead.'
  return `The user's recorded motions (from videos of themselves) can become clips on a humanoid rig:
  rig.apply_motion("Wave")                                     # clip named after the motion; plays once unless it was recorded as a loop
  rig.apply_motion("Sword swing", clip="Attack", start=0.4, end=1.6, speed=1.2)   # rename, trim (seconds), speed up
Available: ${list.map((m) => `"${m.name}" (${m.seconds} s${m.loop ? ', loops' : ''})`).join(', ')}.
Prefer a recorded motion when the user asks for that move; you can mix them with keyframed clips.`
}

function systemPrompt(meta, script) {
  return `You are a 3D modeling assistant inside Gamesmith. You build game-ready 3D models by writing a Blender ${'5.x'} Python script (bpy).
The asset is "${meta.name}"${meta.description ? `: ${meta.description}` : ''}.

How it works:
- The whole model is ONE script, model.py. Gamesmith runs it in an empty scene in Blender (background mode, no window), exports every mesh to model.glb, renders preview.png and measures the result.
- Tools: read_script, write_script (replace it), edit_script (exact search and replace), build_model (run it in Blender; returns size, triangles and materials, or the error and line).
- After you finish, Gamesmith builds the model and sends you any errors to fix.

Rules for game-ready models:
- Units are meters, Z is up. The model stands on the ground: its lowest point at z = 0, centered on x = 0, y = 0. Front faces -Y.
- Use real-world sizes (a door is about 2 m tall, a crate about 0.6 m, a person 1.75 m).
- Keep it light: under 5,000 triangles for props, under 15,000 for vehicles or buildings. Low segment counts (8 to 24 for cylinders) are fine.
- Build from primitives (bpy.ops.mesh.primitive_*_add), bmesh, or modifiers (bevel, mirror, array, solidify). Modifiers are applied on export.
- Do not use external files, images, add-ons or bpy.ops that need a window (no view3d or screen operators, no edit-mode selection by mouse).
- Give parts names (obj.name = "Lid") and simple materials. Colors look best when not fully saturated.
- Never delete or clear the scene; it starts empty. Do not save .blend files or export yourself.

Helpers already defined in the script (no import needed): bpy, bmesh, math, Vector,
  mat(name, color=(r,g,b), roughness=0.6, metallic=0.0, emission=None) -> material (colors 0..1, reused by name)
  assign(obj, material) -> obj   (replaces the object's materials)
  shade_smooth(obj, angle_deg=40) -> obj   (smooth shading with sharp edges kept)

Example:
bpy.ops.mesh.primitive_cylinder_add(vertices=16, radius=0.3, depth=0.9, location=(0, 0, 0.45))
barrel = bpy.context.object
barrel.name = "Barrel"
assign(shade_smooth(barrel), mat("Wood", (0.45, 0.28, 0.14), roughness=0.8))

ANIMATION (only when the user asks for movement: opening, walking, idle, attacks, spinning...)
Use the Rig helper. Moving parts must be separate objects. Build the model in its rest pose first, then:
  rig = Rig()
  rig.bone("Body", head=(0, 0, 0.9), tail=(0, 0, 1.4))                 # tail defaults to 0.25 m straight up
  rig.bone("Leg.L", head=(0.12, 0, 0.9), tail=(0.12, 0, 0.1), parent="Body")   # put head at the joint (hip, hinge, shoulder)
  rig.bone("Leg.R", head=(-0.12, 0, 0.9), tail=(-0.12, 0, 0.1), parent="Body")
  rig.attach(torso, "Body")         # rigid: the part follows the bone exactly (best for blocky/low-poly parts)
  rig.attach(left_leg, "Leg.L")
  # rig.attach(mesh) with no bone makes one continuous mesh bend with every bone (tails, worms, cloth)
  with rig.clip("Walk", seconds=0.8):                       # loop=True by default: the end returns to the start
      rig.pose("Leg.L", at=0.0, rotate=(-25, 0, 0))
      rig.pose("Leg.R", at=0.0, rotate=(25, 0, 0))
      rig.pose("Leg.L", at=0.4, rotate=(25, 0, 0))
      rig.pose("Leg.R", at=0.4, rotate=(-25, 0, 0))
      rig.pose("Body", at=0.2, move=(0, 0, 0.03))
  with rig.clip("Open", seconds=1.0, loop=False):           # one-shot clips hold their last pose
      rig.pose("Lid", at=0.6, rotate=(-100, 0, 0))
Rules:
- Add every bone before attaching parts or making clips. Each clip starts from the rest pose.
- rotate is degrees around the WORLD axes at the bone's head: X tips forward/back, Y tilts sideways, Z turns.
  The model faces -Y, so for a part hanging down from its joint, rotate=(-30, 0, 0) swings it FORWARD and (30, 0, 0) back.
  A lid hinged at the back opens with a negative X rotation. move is meters along world axes. scale is a number.
- Times are in seconds; keep loops short (0.6 to 1.2 s for walk cycles). Use clear names games can use: Idle, Walk, Run, Jump, Attack, Die, Open, Close, Spin.
- After build_model, check the clip list in the result.

PEOPLE AND RECORDED MOTIONS
For any person-shaped character (knight, hero, villager, robot with arms and legs), use the standard skeleton,
which recorded motions need:
  rig = Rig.humanoid(height=1.8)   # bones: Hips, Spine, Chest, Neck, Head, UpperArm/LowerArm/Hand.L/.R, UpperLeg/LowerLeg/Foot.L/.R
  rig.limb("UpperArm.L", width=0.12, material=steel)        # a box from the bone's head to its tail, attached to it
  rig.limb("LowerLeg.R", width=0.11, material=dark, shape="cylinder", extend=0.02)
  head_pos, tail_pos = rig.joints["Head"]                    # place other parts (helmet, sword...) and rig.attach(part, "Hand.R")
.L is the character's left (+X). It stands on z = 0 facing -Y with arms down. Build every body part this way, then add clips.
${motionList()}

Work in small steps: change the script, call build_model, read the numbers (is the size right? is min_z 0?), then improve.
When done, briefly tell the user what you made in plain words (one or two sentences). Don't paste the script.

The current model.py:
\`\`\`python
${script}
\`\`\``
}

export const MODEL_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_script',
      description: 'Read the current model.py.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_script',
      description: 'Replace model.py with a complete new script.',
      parameters: { type: 'object', properties: { content: { type: 'string', description: 'The whole script' } }, required: ['content'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_script',
      description: 'Change part of model.py by exact search and replace.',
      parameters: {
        type: 'object',
        properties: {
          old_text: { type: 'string', description: 'Exact text currently in the script' },
          new_text: { type: 'string', description: 'Replacement text' },
          replace_all: { type: 'boolean' }
        },
        required: ['old_text', 'new_text']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'build_model',
      description: 'Run model.py in Blender. Returns measurements (size in meters, triangles, materials) or the error with its line.',
      parameters: { type: 'object', properties: {} }
    }
  }
]

export function formatBuild(r) {
  if (!r.ok) {
    return [`Build FAILED: ${r.error}`, r.where && `At: ${r.where}`, r.traceback && `Traceback (end):\n${String(r.traceback).slice(-1500)}`].filter(Boolean).join('\n')
  }
  const s = r.stats
  const notes = []
  if (Math.abs(s.min_z) > 0.01) notes.push(`The lowest point is at z = ${s.min_z}, not 0: move it so it stands on the ground.`)
  if (Math.abs(s.center[0]) > 0.05 || Math.abs(s.center[1]) > 0.05) notes.push(`It is off-center (center x=${s.center[0]}, y=${s.center[1]}): center it on x = 0, y = 0.`)
  if (s.triangles > 20000) notes.push(`${s.triangles} triangles is heavy for a web game: reduce segments or subdivisions.`)
  return [
    'Build OK.',
    `Size: ${s.size_m.width} m wide (X), ${s.size_m.depth} m deep (Y), ${s.size_m.height} m tall (Z).`,
    `${s.objects} object(s), ${s.triangles} triangles. Materials: ${s.materials.join(', ') || 'none'}.`,
    s.clips?.length ? `Animations: ${s.clips.map((c) => `${c.name} (${c.seconds} s${c.loop ? ', loops' : ', plays once'})`).join(', ')}.` : 'No animations.',
    ...notes
  ].join('\n')
}

/**
 * Run one modeling request. deps: { id, ai, build: () => Promise<buildResult>, history, userText, emit, signal }
 * Returns { reply, changed, build }.
 */
export async function runModelAgent({ id, ai, build, history = [], userText, emit = () => {}, signal }) {
  if (!ai.model) throw new Error('No model selected. Open Settings and pick a model.')
  const meta = library.readMeta(id)
  const messages = [{ role: 'system', content: systemPrompt(meta, library.readScript(id)) }]
  for (const turn of history.slice(-HISTORY_TURNS)) {
    if (turn.role === 'user' || turn.role === 'assistant') messages.push({ role: turn.role, content: turn.content })
  }
  messages.push({ role: 'user', content: userText })

  let changed = false
  let builtSinceChange = false
  let lastBuild = null
  let fixRounds = 0
  let reply = ''
  let textMode = false

  const doBuild = async () => {
    emit({ type: 'status', text: 'Building in Blender…' })
    lastBuild = await build()
    builtSinceChange = true
    emit({ type: 'build', result: lastBuild })
    return lastBuild
  }

  const runTool = async (name, args) => {
    switch (name) {
      case 'read_script':
        return library.readScript(id)
      case 'write_script':
        if (typeof args.content !== 'string' || !args.content.trim()) throw new Error('content is required')
        library.writeScript(id, args.content)
        changed = true
        builtSinceChange = false
        return `Wrote model.py (${args.content.split('\n').length} lines). Call build_model to try it.`
      case 'edit_script': {
        if (typeof args.old_text !== 'string' || typeof args.new_text !== 'string') throw new Error('old_text and new_text are required strings')
        const { content, count } = applyEdit(library.readScript(id), args.old_text, args.new_text, !!args.replace_all)
        library.writeScript(id, content)
        changed = true
        builtSinceChange = false
        return `Edited model.py (${count} replacement${count > 1 ? 's' : ''}).`
      }
      case 'build_model':
        return formatBuild(await doBuild())
      default:
        throw new Error(`Unknown tool "${name}". Available: ${MODEL_TOOLS.map((t) => t.function.name).join(', ')}`)
    }
  }

  for (let step = 0; step < (ai.maxSteps || 30); step++) {
    if (signal?.aborted) throw new Error('Stopped.')
    emit({ type: 'status', text: step === 0 ? 'Thinking…' : 'Working…' })
    emit({ type: 'turn_start' })
    const res = await chat(ai, { messages, tools: MODEL_TOOLS, signal, onDelta: (d) => emit({ type: 'delta', ...d }) })

    let toolCalls = res.toolCalls
    if (!toolCalls.length) {
      const fromText = extractTextToolCalls(res.content)
      if (fromText.length) {
        toolCalls = fromText
        textMode = true
      }
    }
    const { visible } = splitThinking(res.content)

    if (toolCalls.length) {
      if (textMode) messages.push({ role: 'assistant', content: res.content })
      else {
        messages.push({
          role: 'assistant',
          content: visible || '',
          tool_calls: toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments || '{}' } }))
        })
      }
      const textResults = []
      for (const call of toolCalls) {
        if (signal?.aborted) throw new Error('Stopped.')
        let args = {}
        let result
        let ok = true
        try {
          args = parseArgs(call.arguments)
          emit({ type: 'tool_start', id: call.id, name: call.name, args: previewArgs(args) })
          result = await runTool(call.name, args)
          if (call.name === 'build_model' && !lastBuild?.ok) ok = false
        } catch (e) {
          ok = false
          result = `ERROR: ${e.message}`
          if (!args || !Object.keys(args).length) emit({ type: 'tool_start', id: call.id, name: call.name, args: {} })
        }
        emit({ type: 'tool_end', id: call.id, name: call.name, ok, result: String(result).slice(0, 1500) })
        if (textMode) textResults.push(`Result of ${call.name}:\n${result}`)
        else messages.push({ role: 'tool', tool_call_id: call.id, name: call.name, content: String(result) })
      }
      if (textMode) messages.push({ role: 'user', content: textResults.join('\n\n') })
      continue
    }

    // The model thinks it's done: make sure the current script builds.
    reply = visible || reply
    if (changed && fixRounds < (ai.autoFixRounds ?? 3)) {
      const r = builtSinceChange ? lastBuild : await doBuild()
      if (!r.ok) {
        fixRounds++
        emit({ type: 'status', text: `Blender reported an error, fixing (attempt ${fixRounds})…` })
        messages.push({ role: 'assistant', content: visible || 'Done.' })
        messages.push({ role: 'user', content: `I built the model and it failed:\n${formatBuild(r)}\n\nFix the script.` })
        continue
      }
    }
    break
  }

  return { reply: reply || 'Done.', changed, build: lastBuild }
}

function previewArgs(args) {
  const out = {}
  for (const [k, v] of Object.entries(args || {})) out[k] = typeof v === 'string' && v.length > 400 ? `${v.slice(0, 400)}… (${v.length} chars)` : v
  return out
}
