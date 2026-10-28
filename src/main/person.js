// The Blender script for "Make a character that looks like me". It's an ordinary model.py, so
// the user (or the modeling AI) can change anything afterwards.
const py = (v) => (Array.isArray(v) ? `(${v.map((x) => +(+x).toFixed(3)).join(', ')})` : typeof v === 'string' ? JSON.stringify(v) : String(+(+v).toFixed(3)))

/**
 * p: { name, from (motion name), body: { height, shoulders, hips, upper_arm, forearm, thigh, shin, head_width },
 *      colors: { skin, hair, shirt, pants, shoes }, sleeves: long|short|none, legs: long|shorts,
 *      face: bool, hairStyle: short|long|none, motion: name to add as a clip, or '' }
 */
export function personScript(p) {
  const b = p.body
  const c = p.colors
  const H = b.height
  const t = (k) => +(k * H).toFixed(3) // a thickness as a fraction of height
  const arms = { long: ['shirt', 'shirt'], short: ['shirt', 'skin'], none: ['skin', 'skin'] }[p.sleeves] || ['shirt', 'shirt']
  const legs = p.legs === 'shorts' ? ['pants', 'skin'] : ['pants', 'pants']
  const lines = [
    `# ${p.name}: a character made from the recording "${p.from}".`,
    '# Measurements and colors came from the video. Change anything below and click Build.',
    '',
    `HEIGHT = ${py(H)}  # meters`,
    `skin = mat("Skin", ${py(c.skin)}, roughness=0.7)`,
    `hair = mat("Hair", ${py(c.hair)}, roughness=0.85)`,
    `shirt = mat("Shirt", ${py(c.shirt)}, roughness=0.85)`,
    `pants = mat("Pants", ${py(c.pants)}, roughness=0.85)`,
    `shoes = mat("Shoes", ${py(c.shoes)}, roughness=0.6)`,
    '',
    '# The skeleton, with your proportions (recorded motions play on it)',
    `rig = Rig.humanoid(height=HEIGHT, shoulders=${py(b.shoulders)}, hips=${py(b.hips)}, upper_arm=${py(b.upper_arm)}, forearm=${py(b.forearm)}, thigh=${py(b.thigh)}, shin=${py(b.shin)})`,
    'j = rig.joints',
    '',
    '# Body',
    `rig.limb("Hips", width=${py(b.hips + t(0.09))}, depth=${py(t(0.1))}, material=pants, extend=${py(t(0.02))})`,
    `rig.limb("Spine", width=${py(b.shoulders * 0.82)}, depth=${py(t(0.105))}, material=shirt, extend=${py(t(0.01))})`,
    `rig.limb("Chest", width=${py(b.shoulders + t(0.03))}, depth=${py(t(0.115))}, material=shirt, extend=${py(t(0.01))})`,
    `rig.limb("Neck", width=${py(t(0.045))}, material=skin, extend=${py(t(0.01))})`,
    '',
    '# Head',
    'head_bottom, head_top = j["Head"]',
    `head_size = (${py(b.head_width)}, ${py(b.head_width * 1.05)}, (head_top - head_bottom).z)`,
    'bpy.ops.mesh.primitive_cube_add(size=1, location=(head_bottom + head_top) / 2)',
    'head = bpy.context.object',
    'head.name = "Head"',
    'head.scale = head_size',
    'bpy.ops.object.transform_apply(scale=True)',
    'bevel = head.modifiers.new("Bevel", "BEVEL")',
    'bevel.width = head_size[0] * 0.08',
    'bevel.segments = 2',
    'assign(head, skin)',
    'rig.attach(head, "Head")'
  ]
  if (p.hairStyle !== 'none') {
    const long = p.hairStyle === 'long'
    lines.push(
      '',
      `# Hair (${long ? 'long' : 'short'})`,
      'bpy.ops.mesh.primitive_cube_add(size=1)',
      'cap = bpy.context.object',
      'cap.name = "Hair"',
      long
        ? 'cap.scale = (head_size[0] * 1.08, head_size[1] * 1.08, head_size[2] * 0.85)'
        : 'cap.scale = (head_size[0] * 1.06, head_size[1] * 1.06, head_size[2] * 0.32)',
      long
        ? 'cap.location = (head_bottom.x, head_bottom.y + head_size[1] * 0.06, head_top.z - head_size[2] * 0.42)'
        : 'cap.location = (head_bottom.x, head_bottom.y + head_size[1] * 0.03, head_top.z - head_size[2] * 0.14)',
      'bpy.ops.object.transform_apply(scale=True)',
      'assign(cap, hair)',
      'rig.attach(cap, "Head")'
    )
  }
  if (p.face) {
    lines.push(
      '',
      '# Your face, from the video, on the front of the head',
      'bpy.ops.mesh.primitive_plane_add(size=1, rotation=(math.radians(90), 0, 0))',
      'face = bpy.context.object',
      'face.name = "Face"',
      'face.scale = (head_size[0] * 0.92, head_size[2] * 0.9, 1)  # the plane is stood up, so its own Y is up',
      'face.location = (head_bottom.x, head_bottom.y - head_size[1] / 2 - 0.004, head_bottom.z + head_size[2] * 0.47)',
      'bpy.ops.object.transform_apply(scale=True)',
      'assign(face, photo("Face photo", asset_file("face.png")))',
      'rig.attach(face, "Head")'
    )
  }
  lines.push(
    '',
    '# Arms and legs',
    'for s in ("L", "R"):',
    `    rig.limb(f"UpperArm.{s}", width=${py(t(0.055))}, material=${arms[0]}, extend=${py(t(0.012))})`,
    `    rig.limb(f"LowerArm.{s}", width=${py(t(0.048))}, material=${arms[1]}, extend=${py(t(0.008))})`,
    `    rig.limb(f"Hand.{s}", width=${py(t(0.045))}, depth=${py(t(0.025))}, material=skin)`,
    `    rig.limb(f"UpperLeg.{s}", width=${py(t(0.075))}, material=pants, extend=${py(t(0.012))})`,
    `    rig.limb(f"LowerLeg.{s}", width=${py(t(0.062))}, material=${legs[1]}, extend=${py(t(0.008))})`,
    // shoes sit flat on the ground, from just behind the ankle to past the toes
    '    ankle, toe = j[f"Foot.{s}"]',
    `    bpy.ops.mesh.primitive_cube_add(size=1, location=(ankle.x, ${py(-0.03 * H)}, ${py(0.029 * H)}))`,
    '    shoe = bpy.context.object',
    '    shoe.name = f"Shoe.{s}"',
    `    shoe.scale = (${py(t(0.062))}, ${py(t(0.13))}, ${py(t(0.058))})`,
    '    bpy.ops.object.transform_apply(scale=True)',
    '    assign(shoe, shoes)',
    '    rig.attach(shoe, f"Foot.{s}")'
  )
  if (p.motion) lines.push('', '# The motion this character was made from', `rig.apply_motion(${py(p.motion)})`)
  return lines.join('\n') + '\n'
}
