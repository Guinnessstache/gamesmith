# Realistic people for Gamesmith: human(...).
#
# The body, skeleton, skin, hair and clothes come from MPFB (the MakeHuman add-on for Blender, GPL)
# and the MakeHuman system assets (CC0). Gamesmith downloads both the first time a model calls
# human() and keeps them in its own folder; nothing is installed into the user's own Blender.
# The result stands on Gamesmith's standard skeleton (Hips, Spine, Chest, ... Hand.R), so recorded
# motions, clips and rig.attach work exactly as they do with character().
import os
import traceback

import bpy
from mathutils import Matrix, Vector

R = None  # runner.py fills this in: Rig, mat, state (see the bottom of runner.py)

ADDON = "bl_ext.user_default.mpfb"
NOT_INSTALLED = ("human() needs the realistic people pack, and Gamesmith couldn't download it (about 330 MB, "
                 "first time only; check the internet connection). Use character() for now, or build again later.")

# MakeHuman game skeleton -> Gamesmith's standard bone names (.L is the character's left, +X).
BONES = {"pelvis": "Hips", "spine_01": "Spine", "spine_02": "Spine2", "spine_03": "Chest", "neck_01": "Neck", "head": "Head"}
for _s, _S in (("l", "L"), ("r", "R")):
    BONES.update({f"clavicle_{_s}": f"Shoulder.{_S}", f"upperarm_{_s}": f"UpperArm.{_S}", f"lowerarm_{_s}": f"LowerArm.{_S}",
                  f"hand_{_s}": f"Hand.{_S}", f"thigh_{_s}": f"UpperLeg.{_S}", f"calf_{_s}": f"LowerLeg.{_S}",
                  f"foot_{_s}": f"Foot.{_S}", f"ball_{_s}": f"Toe.{_S}"})
    for _f in ("thumb", "index", "middle", "ring", "pinky"):
        for _i in (1, 2, 3):
            BONES[f"{_f}_0{_i}_{_s}"] = f"{_f.capitalize()}{_i}.{_S}"

AGES = {"child": 0.19, "teen": 0.37, "young": 0.5, "adult": 0.56, "middleage": 0.69, "old": 0.92}
SKIN_AGE = {"child": "young", "teen": "young", "young": "young", "adult": "young", "middleage": "middleage", "old": "old"}
# (muscle, weight) on MakeHuman's 0..1 sliders
BUILDS = {"average": (0.5, 0.5), "slim": (0.4, 0.28), "athletic": (0.72, 0.45), "strong": (0.9, 0.58), "heavy": (0.4, 0.9)}
ETHNICITIES = ("african", "asian", "caucasian")
OUTFITS = {
    "male": {"casual": "male_casualsuit01", "tshirt_jeans": "male_casualsuit04", "suit": "male_elegantsuit01", "work": "male_worksuit01"},
    "female": {"casual": "female_casualsuit01", "tshirt_jeans": "female_casualsuit01", "suit": "female_elegantsuit01", "sport": "female_sportsuit01"},
}
DEFAULT_HAIR = {"male": "short02", "female": "ponytail01"}
DEFAULT_SHOES = {"male": "shoes04", "female": "shoes02"}
MAX_TEXTURE = 2048


def _data_dir():
    return os.path.join(bpy.utils.user_resource("EXTENSIONS"), ".user", "user_default", "mpfb", "data")


def installed():
    ext = bpy.utils.user_resource("EXTENSIONS")
    return os.path.isfile(os.path.join(ext, "user_default", "mpfb", "__init__.py")) and os.path.isdir(os.path.join(_data_dir(), "skins"))


def _choices(kind):
    """Names of the installed hair / clothes / eye colors, for error messages."""
    d = os.path.join(_data_dir(), kind)
    if not os.path.isdir(d):
        return []
    if kind == "eyes/materials":
        return sorted(f[:-6] for f in os.listdir(d) if f.endswith(".mhmat"))
    return sorted(n for n in os.listdir(d) if os.path.isfile(os.path.join(d, n, n + ".mhclo")))


def _mpfb():
    """Turn the add-on on (the runner starts Blender with factory settings) and return its services."""
    if not installed():
        raise RuntimeError(NOT_INSTALLED)
    import addon_utils
    import importlib

    problems = []
    addon_utils.enable(ADDON, default_set=True, persistent=False, handle_error=lambda e: problems.append(traceback.format_exc()))
    try:
        hs = importlib.import_module(ADDON + ".services.humanservice").HumanService
        ts = importlib.import_module(ADDON + ".services.targetservice").TargetService
        props = importlib.import_module(ADDON + ".entities.objectproperties").HumanObjectProperties
    except Exception as e:
        raise RuntimeError(f"The realistic people pack couldn't start in this Blender ({type(e).__name__}: {e}). "
                           "Use character() for a stylized person instead." + ("\n" + problems[-1][-600:] if problems else ""))
    return hs, ts, props


def _pick(value, table, what):
    if value in table:
        return value
    raise ValueError(f'human: {what} must be one of {", ".join(str(k) for k in table)} (got {value!r})')


def _asset(kind, name, what):
    path = os.path.join(_data_dir(), kind, name, name + ".mhclo")
    if os.path.isfile(path):
        return path
    raise ValueError(f'human: there is no {what} "{name}". Choose one of: {", ".join(_choices(kind)) or "(none installed)"}')


def _principled(material):
    if not material or not material.node_tree:
        return None, None
    nt = material.node_tree
    return nt, next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None)


def _alpha(obj, cutout):
    """glTF has no soft hair: skin is solid, hair/lashes/clothes are cut out where their texture is clear.
    (Left as blended, the face stops hiding the eyes and teeth behind it in game engines.)"""
    for slot in obj.material_slots:
        nt, bsdf = _principled(slot.material)
        if not bsdf:
            continue
        a = bsdf.inputs["Alpha"]
        if a.is_linked:
            src = a.links[0].from_socket
            nt.links.remove(a.links[0])
            if cutout:
                gt = nt.nodes.new("ShaderNodeMath")
                gt.operation = "GREATER_THAN"
                gt.inputs[1].default_value = 0.3
                nt.links.new(src, gt.inputs[0])
                nt.links.new(gt.outputs[0], a)
                R.state["alpha"] = True
        if not cutout:
            a.default_value = 1.0
        slot.material.use_backface_culling = not cutout


def _base_image_node(obj):
    for slot in obj.material_slots:
        nt, bsdf = _principled(slot.material)
        if bsdf and bsdf.inputs["Base Color"].is_linked:
            n = bsdf.inputs["Base Color"].links[0].from_node
            if n.type == "TEX_IMAGE" and n.image:
                return n
    return None


def _recolor(obj, color, label):
    """Repaint a textured part (hair) in one color, keeping the strands' light and dark."""
    import numpy as np

    node = _base_image_node(obj)
    if node is None:
        return
    src = node.image
    w, h = src.size
    px = np.empty(w * h * 4, dtype=np.float32)
    src.pixels.foreach_get(px)
    px = px.reshape(-1, 4)
    lum = px[:, :3] @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    solid = px[:, 3] > 0.3
    mean = float(lum[solid].mean()) if solid.any() else 0.5
    shade = np.clip(lum / max(mean, 1e-3), 0.0, 2.2)[:, None]
    rgb = np.clip(shade * np.array(color[:3], dtype=np.float32), 0.0, 1.0)
    out = np.concatenate([rgb, px[:, 3:4]], axis=1).astype(np.float32)
    img = bpy.data.images.new(f"{label} color", w, h, alpha=True)
    img.pixels.foreach_set(out.ravel())
    img.pack()
    node.image = img


def _shrink_textures():
    for img in bpy.data.images:
        if img.source == "FILE" and max(img.size) > MAX_TEXTURE:
            k = MAX_TEXTURE / max(img.size)
            img.scale(max(1, round(img.size[0] * k)), max(1, round(img.size[1] * k)))


def _arms_down(arm, meshes):
    """MakeHuman bodies stand with the arms held out at 45 degrees. Gamesmith's people stand with
    their arms down, so that becomes the rest pose: pose the arms, freeze the meshes, re-bind."""
    for side, sx in (("L", 1), ("R", -1)):
        b = arm.data.bones[f"UpperArm.{side}"]
        turn = (b.tail_local - b.head_local).normalized().rotation_difference(Vector((0.16 * sx, 0, -1)).normalized())
        rest = b.matrix_local.to_quaternion()
        arm.pose.bones[b.name].rotation_quaternion = rest.inverted() @ turn @ rest
    bpy.context.view_layer.update()
    for o in meshes:
        mod = next((m for m in o.modifiers if m.type == "ARMATURE"), None)
        if mod is None:
            continue
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)
        again = o.modifiers.new("Armature", "ARMATURE")
        again.object = arm
        bpy.ops.object.modifier_move_to_index(modifier=again.name, index=0)
    bpy.ops.object.select_all(action="DESELECT")
    arm.select_set(True)
    bpy.context.view_layer.objects.active = arm
    bpy.ops.object.mode_set(mode="POSE")
    bpy.ops.pose.armature_apply(selected=False)
    bpy.ops.object.mode_set(mode="OBJECT")


def human(body="male", age="adult", build="average", ethnicity="caucasian", height=None, hair=None, hair_color=None,
          eyes="brown", outfit="casual", shoes=None, hat=None, name="Human"):
    """A realistic person (real anatomy, face, hands, skin, hair, clothes) on the standard skeleton.
    Returns the rig; rig.parts has "body", "eyes", "hair", "outfit", "shoes", "hat".
    body: male, female. age: child, teen, young, adult, middleage, old. build: average, slim, athletic, strong, heavy.
    ethnicity: african, asian, caucasian. height: meters (default: natural for the age and body).
    hair: a style name or "bald". hair_color: (r, g, b) or None for the style's own color.
    eyes: a color name. outfit: casual, tshirt_jeans, suit, work (male), sport (female), or a clothes name.
    shoes: a shoes name, or None for the outfit's usual pair. hat: fedora01, fedora_cocked or None."""
    body = "female" if str(body).lower().startswith("f") else "male"
    _pick(age, AGES, "age")
    _pick(build, BUILDS, "build")
    _pick(ethnicity, ETHNICITIES, "ethnicity")
    HumanService, TargetService, Props = _mpfb()
    hair = DEFAULT_HAIR[body] if hair is None else hair
    hair_file = None if hair in ("bald", "none", False) else _asset("hair", hair, "hair style")
    outfit_name = OUTFITS[body].get(outfit, outfit)
    if not outfit_name:
        raise ValueError(f'human: outfit must be one of {", ".join(OUTFITS[body])} or a clothes name.')
    outfit_file = _asset("clothes", outfit_name, "outfit")
    shoes_file = _asset("clothes", shoes or DEFAULT_SHOES[body], "shoes")
    hat_file = _asset("clothes", hat, "hat") if hat else None
    eye_tex = os.path.join(_data_dir(), "eyes", "materials", f"{eyes}_eye.png")
    if not os.path.isfile(eye_tex):
        raise ValueError(f'human: eyes must be one of {", ".join(_choices("eyes/materials"))} (got {eyes!r})')
    skin = os.path.join(_data_dir(), "skins", f"{SKIN_AGE[age]}_{ethnicity}_{body}", f"{SKIN_AGE[age]}_{ethnicity}_{body}.mhmat")
    if not os.path.isfile(skin):
        raise RuntimeError(f"The realistic people pack is missing the skin {os.path.basename(skin)}.")

    before = set(bpy.data.objects)
    base = HumanService.create_human()
    muscle, weight = BUILDS[build]
    values = {"gender": 0.0 if body == "female" else 1.0, "age": AGES[age], "muscle": muscle, "weight": weight,
              "proportions": 0.75, **{e: (1.0 if e == ethnicity else 0.0) for e in ETHNICITIES}}
    for key, value in values.items():
        Props.set_value(key, value, entity_reference=base)
    TargetService.reapply_macro_details(base)
    TargetService.bake_targets(base)  # a fixed shape, so the masks under the clothes can be applied on export
    arm = HumanService.add_builtin_rig(base, "game_engine")
    HumanService.set_character_skin(skin, base, skin_type="GAMEENGINE")

    parts = {"body": base}

    def add(key, path, kind):
        obj = HumanService.add_mhclo_asset(path, base, asset_type=kind, material_type="GAMEENGINE", subdiv_levels=0)
        for m in list(obj.modifiers):
            if m.type == "SUBSURF":
                obj.modifiers.remove(m)
        parts[key] = obj
        return obj

    eyes_obj = add("eyes", _asset("eyes", "low-poly", "eyes"), "Eyes")
    node = _base_image_node(eyes_obj)
    if node is not None:
        node.image = bpy.data.images.load(eye_tex, check_existing=True)
    add("eyebrows", _asset("eyebrows", "eyebrow001", "eyebrows"), "Eyebrows")
    add("eyelashes", _asset("eyelashes", "eyelashes01", "eyelashes"), "Eyelashes")
    if hair_file:
        add("hair", hair_file, "Hair")
        if hair_color is not None:
            _recolor(parts["hair"], hair_color, name + " hair")
    add("outfit", outfit_file, "Clothes")
    add("shoes", shoes_file, "Clothes")
    if hat_file:
        add("hat", hat_file, "Clothes")

    made = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in made if o.type == "MESH"]
    for o in meshes:
        _alpha(o, cutout=o is not base)
        for p in o.data.polygons:
            p.use_smooth = True
    _shrink_textures()

    # Stand on z = 0 at the requested height. Everything sits at the origin unrotated, so the
    # meshes and the skeleton can simply be scaled and moved together.
    bpy.context.view_layer.update()
    zs = [v.co.z for v in base.data.vertices if any(g.group == base.vertex_groups["body"].index for g in v.groups)]
    lo, hi = min(zs), max(zs)
    k = (float(height) / (hi - lo)) if height else 1.0
    fix = Matrix.Scale(k, 4) @ Matrix.Translation(Vector((0, 0, -lo)))
    for o in meshes:
        o.data.transform(fix)
        o.data.update()
    arm.data.transform(fix)

    # Gamesmith's bone names, and a Rig around the finished skeleton.
    for b in arm.data.bones:
        if b.name in BONES:
            b.name = BONES[b.name]
    arm.name = name
    arm.data.name = name
    for o in meshes:
        o.name = f"{name} {next((key for key, p in parts.items() if p is o), o.name)}"
        for slot in o.material_slots:
            if slot.material:
                slot.material.name = o.name
    for pb in arm.pose.bones:
        pb.rotation_mode = "QUATERNION"
    _arms_down(arm, meshes)
    rig = R.Rig.__new__(R.Rig)
    rig.data, rig.obj = arm.data, arm
    rig._bones = {b.name: (arm.matrix_world @ b.head_local, arm.matrix_world @ b.tail_local, b.parent.name if b.parent else None)
                  for b in arm.data.bones}
    rig._made = set(rig._bones)
    rig._clip = None
    rig.is_humanoid = True
    rig.height = (hi - lo) * k
    rig.parts = parts
    return rig
