# Gamesmith Blender harness.
#
# Runs one asset script (written by the user or the AI) in a clean scene, then:
#   1. exports every mesh as a single .glb (glTF binary, Y-up, transforms applied)
#   2. measures the result (size in meters, triangles, materials, objects)
#   3. renders a small preview image (Cycles on the CPU, so no GPU is needed)
#
# Usage (Blender CLI):
#   blender -b --factory-startup --python-exit-code 3 --python runner.py -- <script.py> <out.glb> <out.png> [size]
# The result is printed on one line starting with GAMESMITH_RESULT so the app can read it.
import bpy
import bmesh
import json
import math
import os
import sys
import traceback
from mathutils import Euler, Matrix, Quaternion, Vector

RESULT_TAG = "GAMESMITH_RESULT "


def args_after_dashes():
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


# ---------- helpers available to asset scripts ----------
def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def mat(name, color=(0.8, 0.8, 0.8), roughness=0.6, metallic=0.0, emission=None):
    """Create (or reuse) a simple PBR material. color is RGB 0..1 as seen on screen
    (like a color picker); it's converted to the linear values Blender and glTF use."""
    color = tuple(srgb_to_linear(c) for c in color[:3])
    if emission is not None:
        emission = tuple(srgb_to_linear(c) for c in emission[:3])
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (*color[:3], 1.0)
        bsdf.inputs["Roughness"].default_value = roughness
        bsdf.inputs["Metallic"].default_value = metallic
        if emission is not None:
            bsdf.inputs["Emission Color"].default_value = (*emission[:3], 1.0)
            bsdf.inputs["Emission Strength"].default_value = 2.0
    m.diffuse_color = (*color[:3], 1.0)  # what the viewport shows
    return m


def assign(obj, material):
    """Give an object a material (replacing any it had)."""
    obj.data.materials.clear()
    obj.data.materials.append(material)
    return obj


def shade_smooth(obj, angle_deg=40):
    """Smooth shading, keeping edges sharper than angle_deg crisp."""
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    try:
        bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle_deg))
    except Exception:
        for p in obj.data.polygons:
            p.use_smooth = True
    return obj


# ---------- animation ----------
FPS = 24


class Rig:
    """A skeleton for animating a model.

    rig = Rig()
    rig.bone("Body", head=(0, 0, 0.4), tail=(0, 0, 0.9))
    rig.bone("Lid", head=(0, 0.25, 0.5), parent="Body")      # tail defaults to 0.25 m straight up
    rig.attach(lid_obj, "Lid")       # the part follows the bone rigidly
    rig.attach(body_obj)             # no bone: the mesh bends with all bones (automatic weights)
    with rig.clip("Open", seconds=1.0, loop=False):
        rig.pose("Lid", at=0.0, rotate=(0, 0, 0))
        rig.pose("Lid", at=0.6, rotate=(-110, 0, 0))   # degrees around the world X, Y, Z axes
    """

    def __init__(self, name="Rig"):
        self.data = bpy.data.armatures.new(name)
        self.obj = bpy.data.objects.new(name, self.data)
        bpy.context.scene.collection.objects.link(self.obj)
        self._bones = {}
        self._made = set()
        self._clip = None
        self.is_humanoid = False

    # --- a standard person-shaped skeleton (needed for recorded motions) ---
    @classmethod
    def humanoid(cls, height=1.8, name="Rig"):
        """A person-shaped skeleton standing on the ground, facing -Y, arms down at the sides.
        Bones: Hips, Spine, Chest, Neck, Head, UpperArm/LowerArm/Hand .L/.R, UpperLeg/LowerLeg/Foot .L/.R
        (.L is the character's left, at +X). rig.joints["LowerArm.L"] gives (head, tail) positions."""
        rig = cls(name)
        k = height / 1.8
        v = lambda x, y, z: (x * k, y * k, z * k)
        rig.bone("Hips", v(0, 0, 0.95), v(0, 0, 1.05))
        rig.bone("Spine", v(0, 0, 1.05), v(0, 0, 1.25), parent="Hips")
        rig.bone("Chest", v(0, 0, 1.25), v(0, 0, 1.45), parent="Spine")
        rig.bone("Neck", v(0, 0, 1.45), v(0, 0, 1.55), parent="Chest")
        rig.bone("Head", v(0, 0, 1.55), v(0, 0, 1.8), parent="Neck")
        for side, sx in (("L", 1), ("R", -1)):
            rig.bone(f"UpperArm.{side}", v(0.19 * sx, 0, 1.42), v(0.2 * sx, 0, 1.13), parent="Chest")
            rig.bone(f"LowerArm.{side}", v(0.2 * sx, 0, 1.13), v(0.21 * sx, 0, 0.88), parent=f"UpperArm.{side}")
            rig.bone(f"Hand.{side}", v(0.21 * sx, 0, 0.88), v(0.21 * sx, 0, 0.78), parent=f"LowerArm.{side}")
            rig.bone(f"UpperLeg.{side}", v(0.1 * sx, 0, 0.95), v(0.1 * sx, 0, 0.52), parent="Hips")
            rig.bone(f"LowerLeg.{side}", v(0.1 * sx, 0, 0.52), v(0.1 * sx, 0.02, 0.09), parent=f"UpperLeg.{side}")
            rig.bone(f"Foot.{side}", v(0.1 * sx, 0.02, 0.09), v(0.1 * sx, -0.12, 0.02), parent=f"LowerLeg.{side}")
        rig.is_humanoid = True
        return rig

    @property
    def joints(self):
        """{bone name: (head, tail)} as Vectors, to place parts on the skeleton."""
        return {n: (h.copy(), t.copy()) for n, (h, t, _) in self._bones.items()}

    def limb(self, bone, width=0.1, depth=None, material=None, shape="box", extend=0.0, name=None):
        """Make a part that spans a bone from head to tail (an upper arm, a shin...) and attach it.
        shape: "box" or "cylinder". extend: extra length in meters at both ends (to hide gaps at joints)."""
        if bone not in self._bones:
            raise ValueError(f'rig.limb: no bone named "{bone}". Bones: {", ".join(self._bones)}')
        head, tail, _ = self._bones[bone]
        axis = tail - head
        length = axis.length + 2 * extend
        depth = width if depth is None else depth
        if shape == "cylinder":
            bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=width / 2, depth=1)
            obj = bpy.context.object
            obj.scale = (1, depth / width, length)
        else:
            bpy.ops.mesh.primitive_cube_add(size=1)
            obj = bpy.context.object
            obj.scale = (width, depth, length)
        obj.name = name or bone
        obj.rotation_mode = "QUATERNION"
        obj.rotation_quaternion = axis.to_track_quat("Z", "Y")
        obj.location = (head + tail) / 2
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        if material is not None:
            assign(obj, material)
        return self.attach(obj, bone)

    def apply_motion(self, motion, clip=None, loop=None, start=None, end=None, speed=1.0):
        """Turn a motion recorded in Gamesmith (a video of a person) into a clip on this humanoid rig.
        motion: its name in the library. clip: the clip name (default: the motion's name).
        start/end: seconds within the recording. speed: 2.0 plays twice as fast."""
        if not self.is_humanoid:
            raise RuntimeError("Recorded motions need a person-shaped skeleton: make the rig with Rig.humanoid().")
        data = load_motion(motion)
        frames = data["frames"]
        fps = float(data.get("fps", FPS)) * float(speed)
        lo = int(round((start or 0) * fps))
        hi = len(frames) if end is None else min(len(frames), int(round(end * fps)) + 1)
        frames = frames[lo:hi]
        if len(frames) < 2:
            raise ValueError(f'Motion "{motion}" has no frames in that range.')
        seconds = (len(frames) - 1) / fps
        looping = bool(data.get("loop", False)) if loop is None else bool(loop)
        self._build()
        rests = {b.name: b.matrix_local.to_quaternion() for b in self.data.bones}
        rest_dirs = {b.name: (b.tail_local - b.head_local).normalized() for b in self.data.bones}
        legs = (self._bones["UpperLeg.L"][1] - self._bones["UpperLeg.L"][0]).length + (self._bones["LowerLeg.L"][1] - self._bones["LowerLeg.L"][0]).length
        scale = legs / max(float(data.get("legLength", 0.85)), 0.2)
        previous = {}
        with self.clip(clip or data.get("name", motion), seconds=seconds, loop=looping):
            for i, frame in enumerate(frames):
                if not frame:
                    continue
                world = _humanoid_world_rotations(frame["w"], rest_dirs, previous, i)
                at = round(i / fps * FPS)
                for bone, w in world.items():
                    parent = self.data.bones[bone].parent
                    rel = (world[parent.name].inverted() @ w) if parent else w
                    q = rests[bone].inverted() @ rel @ rests[bone]
                    pb = self.obj.pose.bones[bone]
                    last = previous.get("q:" + bone)
                    if last is not None and last.dot(q) < 0:
                        q.negate()  # keep the shortest path between keys
                    previous["q:" + bone] = q.copy()
                    pb.rotation_quaternion = q
                    pb.keyframe_insert("rotation_quaternion", frame=at)
                lift = float(frame.get("lift", 0.0)) * scale
                self.obj.pose.bones["Hips"].location = rests["Hips"].inverted() @ Vector((0, 0, lift))
                self.obj.pose.bones["Hips"].keyframe_insert("location", frame=at)
        return clip or data.get("name", motion)

    # --- skeleton ---
    def bone(self, name, head, tail=None, parent=None):
        if parent is not None and parent not in self._bones:
            raise ValueError(f'rig.bone("{name}"): parent bone "{parent}" does not exist yet. Add the parent bone first.')
        if self._made:
            raise RuntimeError(f'rig.bone("{name}"): add every bone before attaching parts or making clips.')
        head = Vector(head)
        tail = Vector(tail) if tail is not None else head + Vector((0, 0, 0.25))
        if (tail - head).length < 1e-4:
            raise ValueError(f'rig.bone("{name}"): head and tail are in the same place.')
        self._bones[name] = (head, tail, parent)
        return name

    def _build(self):
        if self._made or not self._bones:
            if not self._bones:
                raise RuntimeError("The rig has no bones. Call rig.bone(...) first.")
            return
        bpy.ops.object.mode_set(mode="OBJECT") if bpy.context.object and bpy.context.object.mode != "OBJECT" else None
        bpy.ops.object.select_all(action="DESELECT")
        bpy.context.view_layer.objects.active = self.obj
        self.obj.select_set(True)
        bpy.ops.object.mode_set(mode="EDIT")
        for name, (head, tail, parent) in self._bones.items():
            eb = self.data.edit_bones.new(name)
            eb.head, eb.tail = head, tail
            if parent:
                eb.parent = self.data.edit_bones[parent]
        bpy.ops.object.mode_set(mode="OBJECT")
        self._made = set(self._bones)
        for pb in self.obj.pose.bones:
            pb.rotation_mode = "QUATERNION"

    def attach(self, obj, bone=None):
        """Make a part follow a bone (rigid), or with no bone, bend with the whole skeleton."""
        self._build()
        if bone is not None:
            if bone not in self._bones:
                raise ValueError(f'rig.attach: no bone named "{bone}". Bones: {", ".join(self._bones)}')
            world = obj.matrix_world.copy()
            obj.parent = self.obj
            obj.parent_type = "BONE"
            obj.parent_bone = bone
            obj.matrix_world = world
        else:
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            self.obj.select_set(True)
            bpy.context.view_layer.objects.active = self.obj
            bpy.ops.object.parent_set(type="ARMATURE_AUTO")
        return obj

    # --- clips ---
    def clip(self, name, seconds=1.0, loop=True):
        """One named animation (e.g. "Idle", "Walk", "Open"). Use with `with`."""
        rig = self

        class _Clip:
            def __enter__(self_):
                rig._build()
                if rig._clip is not None:
                    raise RuntimeError("Clips can't be nested.")
                if bpy.data.actions.get(name):
                    raise ValueError(f'There is already a clip named "{name}".')
                act = bpy.data.actions.new(name)
                act.use_fake_user = True
                act["gs_loop"] = bool(loop)
                act["gs_seconds"] = float(seconds)
                rig.obj.animation_data_create()
                rig.obj.animation_data.action = act
                rig._clip = (act, max(1, round(seconds * FPS)), loop)
                # Every bone starts at rest, so clips don't leak poses into each other.
                for pb in rig.obj.pose.bones:
                    pb.rotation_quaternion = (1, 0, 0, 0)
                    pb.location = (0, 0, 0)
                    pb.scale = (1, 1, 1)
                    for prop in ("rotation_quaternion", "location", "scale"):
                        pb.keyframe_insert(prop, frame=0)
                return self_

            def __exit__(self_, exc_type, exc, tb):
                act, end, looping = rig._clip
                rig._clip = None
                if exc_type is None:
                    for fc in _fcurves(act, rig.obj):
                        value = fc.evaluate(0) if looping else fc.evaluate(end)
                        fc.keyframe_points.insert(end, value, options={"REPLACE"})
                    act.use_frame_range = True
                    act.frame_start, act.frame_end = 0, end
                rig.obj.animation_data.action = None
                for pb in rig.obj.pose.bones:
                    pb.rotation_quaternion = (1, 0, 0, 0)
                    pb.location = (0, 0, 0)
                    pb.scale = (1, 1, 1)
                return False

        return _Clip()

    def pose(self, bone, at, rotate=None, move=None, scale=None):
        """Key a bone at a time (seconds) inside a clip.
        rotate: degrees around the world X, Y, Z axes (X tips forward/back, Y tilts sideways, Z turns).
        move: meters along the world X, Y, Z axes.  scale: a number, 1 = normal size."""
        if self._clip is None:
            raise RuntimeError("rig.pose(...) must be inside `with rig.clip(...):`")
        if bone not in self._bones:
            raise ValueError(f'rig.pose: no bone named "{bone}". Bones: {", ".join(self._bones)}')
        act, end, _ = self._clip
        frame = round(float(at) * FPS)
        if frame < 0 or frame > end:
            raise ValueError(f'rig.pose("{bone}", at={at}): time is outside the clip (0 to {end / FPS:g} seconds).')
        pb = self.obj.pose.bones[bone]
        rest = self.data.bones[bone].matrix_local.to_quaternion()
        if rotate is not None:
            rx, ry, rz = (math.radians(a) for a in rotate)
            world = Euler((rx, ry, rz), "XYZ").to_quaternion()
            pb.rotation_quaternion = rest.inverted() @ world @ rest
            pb.keyframe_insert("rotation_quaternion", frame=frame)
        if move is not None:
            pb.location = rest.inverted() @ Vector(move)
            pb.keyframe_insert("location", frame=frame)
        if scale is not None:
            pb.scale = (scale, scale, scale) if isinstance(scale, (int, float)) else tuple(scale)
            pb.keyframe_insert("scale", frame=frame)


# ---------- recorded motions (MediaPipe Pose landmarks) ----------
LM = dict(nose=0, ear_l=7, ear_r=8, sh_l=11, sh_r=12, el_l=13, el_r=14, wr_l=15, wr_r=16, idx_l=19, idx_r=20,
          hip_l=23, hip_r=24, kn_l=25, kn_r=26, an_l=27, an_r=28, heel_l=29, heel_r=30, toe_l=31, toe_r=32)


def motions_dir():
    return os.environ.get("GAMESMITH_MOTIONS", "")


def load_motion(name):
    base = motions_dir()
    if not base or not os.path.isdir(base):
        raise RuntimeError("No recorded motions yet. Record one in the Blender tab (Motions).")
    wanted = str(name).strip().lower()
    names = []
    for entry in sorted(os.listdir(base)):
        path = os.path.join(base, entry, "motion.json")
        if not os.path.isfile(path):
            continue
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        names.append(data.get("name", entry))
        if wanted in (entry.lower(), str(data.get("name", "")).lower()):
            return data
    raise ValueError(f'No recorded motion named "{name}". Recorded motions: {", ".join(names) or "none"}')


def _mp(p):
    """MediaPipe world landmark (x right, y down, z away from camera) -> Blender (X left of a -Y-facing person, Z up)."""
    return Vector((p[0], p[2], -p[1]))


def _basis(x_hint, up):
    z = up.normalized()
    x = x_hint - z * x_hint.dot(z)
    if x.length < 1e-6:
        x = Vector((1, 0, 0))
    x.normalize()
    y = z.cross(x)
    return Matrix((x, y, z)).transposed().to_quaternion()


def _humanoid_world_rotations(landmarks, rest_dirs, previous, index=0):
    """World-space rotation (from rest) of every humanoid bone for one frame of landmarks."""
    P = {k: _mp(landmarks[i]) for k, i in LM.items()}
    vis = {k: (landmarks[i][3] if len(landmarks[i]) > 3 else 1.0) for k, i in LM.items()}
    mid = lambda a, b: (P[a] + P[b]) / 2
    hip_mid, sh_mid, ear_mid = mid("hip_l", "hip_r"), mid("sh_l", "sh_r"), mid("ear_l", "ear_r")
    W = {}
    if min(vis["hip_l"], vis["hip_r"]) >= 0.5:
        W["Hips"] = _basis(P["hip_l"] - P["hip_r"], sh_mid - hip_mid)
    else:
        # Hips out of view (a waist-up video): stand upright, facing where the shoulders face.
        W["Hips"] = _basis(P["sh_l"] - P["sh_r"], Vector((0, 0, 1)))
    W["Chest"] = _basis(P["sh_l"] - P["sh_r"], sh_mid - hip_mid)
    W["Spine"] = W["Hips"].slerp(W["Chest"], 0.5)
    W["Head"] = _basis(P["ear_l"] - P["ear_r"], ear_mid - sh_mid) if min(vis["ear_l"], vis["ear_r"]) > 0.2 else W["Chest"]
    W["Neck"] = W["Chest"].slerp(W["Head"], 0.5)

    def chain(bone, parent, a, b, rest_dir=None):
        cur = W[parent] @ (rest_dir or rest_dirs[bone])
        if min(vis[a], vis[b]) < 0.5:
            # Can't see this part: hold its last good pose for a moment (a brief dropout),
            # then let it go back to rest instead of freezing a stale guess.
            recent = index - previous.get("seen:" + bone, -999) <= 12
            rel = previous.get("rel:" + bone, Quaternion()) if recent else Quaternion()
            W[bone] = W[parent] @ rel
            return
        target = (P[b] - P[a]).normalized()
        W[bone] = cur.rotation_difference(target) @ W[parent]
        previous["rel:" + bone] = W[parent].inverted() @ W[bone]
        previous["seen:" + bone] = index

    for s in ("l", "r"):
        S = s.upper()
        chain(f"UpperArm.{S}", "Chest", f"sh_{s}", f"el_{s}")
        chain(f"LowerArm.{S}", f"UpperArm.{S}", f"el_{s}", f"wr_{s}")
        chain(f"Hand.{S}", f"LowerArm.{S}", f"wr_{s}", f"idx_{s}")
        chain(f"UpperLeg.{S}", "Hips", f"hip_{s}", f"kn_{s}")
        chain(f"LowerLeg.{S}", f"UpperLeg.{S}", f"kn_{s}", f"an_{s}")
        # heel -> toe is flat and forward when standing, whatever angle the foot bone itself has
        chain(f"Foot.{S}", f"LowerLeg.{S}", f"heel_{s}", f"toe_{s}", rest_dir=Vector((0, -1, 0)))
    return W


def _fcurves(action, obj):
    """F-curves of an action (Blender 4.4+ keeps them in layers/strips/channelbags)."""
    if hasattr(action, "fcurves") and len(getattr(action, "fcurves", [])):
        return list(action.fcurves)
    out = []
    for layer in getattr(action, "layers", []):
        for strip in layer.strips:
            for bag in getattr(strip, "channelbags", []):
                out.extend(bag.fcurves)
    return out


def clips_info():
    return [
        {"name": a.name, "seconds": round(float(a.get("gs_seconds", (a.frame_range[1] - a.frame_range[0]) / FPS)), 3), "loop": bool(a.get("gs_loop", True))}
        for a in bpy.data.actions
        if a.use_fake_user and "gs_loop" in a
    ]


HELPERS = {"bpy": bpy, "bmesh": bmesh, "math": math, "Vector": Vector, "mat": mat, "assign": assign, "shade_smooth": shade_smooth, "Rig": Rig, "FPS": FPS, "Matrix": Matrix, "Quaternion": Quaternion, "Euler": Euler, "LM": LM, "motions_dir": motions_dir}


# ---------- measuring ----------
def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def measure(objs):
    depsgraph = bpy.context.evaluated_depsgraph_get()
    tris = 0
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    materials = set()
    for o in objs:
        ev = o.evaluated_get(depsgraph)
        me = ev.to_mesh()
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        for v in me.vertices:
            w = ev.matrix_world @ v.co
            lo = Vector(map(min, lo, w))
            hi = Vector(map(max, hi, w))
        for slot in o.material_slots:
            if slot.material:
                materials.add(slot.material.name)
        ev.to_mesh_clear()
    if not objs or lo.x == math.inf:
        return None
    size = hi - lo
    return {
        "objects": len(objs),
        "triangles": tris,
        # Blender is Z-up; report as width (X), depth (Y), height (Z) in meters
        "size_m": {"width": round(size.x, 3), "depth": round(size.y, 3), "height": round(size.z, 3)},
        "min_z": round(lo.z, 3),
        "center": [round(c, 3) for c in (lo + hi) / 2],
        "materials": sorted(materials),
        "bounds": [list(lo), list(hi)],
    }


# ---------- preview render ----------
def render_preview(path, bounds, px=384):
    lo, hi = Vector(bounds[0]), Vector(bounds[1])
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.05)
    scene = bpy.context.scene

    cam_data = bpy.data.cameras.new("GS_Preview_Cam")
    cam_data.lens = 50
    cam = bpy.data.objects.new("GS_Preview_Cam", cam_data)
    scene.collection.objects.link(cam)
    direction = Vector((1.0, -1.25, 0.8)).normalized()
    dist = radius / math.sin(math.radians(cam_data.angle * 180 / math.pi / 2)) * 1.1
    cam.location = center + direction * dist
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.clip_end = dist * 10
    scene.camera = cam

    sun_data = bpy.data.lights.new("GS_Preview_Sun", "SUN")
    sun_data.energy = 4.0
    sun = bpy.data.objects.new("GS_Preview_Sun", sun_data)
    sun.rotation_euler = (math.radians(50), math.radians(10), math.radians(35))
    scene.collection.objects.link(sun)

    fill_data = bpy.data.lights.new("GS_Preview_Fill", "SUN")
    fill_data.energy = 1.2
    fill = bpy.data.objects.new("GS_Preview_Fill", fill_data)
    fill.rotation_euler = (math.radians(65), math.radians(-20), math.radians(215))
    scene.collection.objects.link(fill)

    world = bpy.data.worlds.get("GS_Preview_World") or bpy.data.worlds.new("GS_Preview_World")
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        # A soft grey-blue sky: it lights the model evenly and gives metals something to reflect.
        bg.inputs[0].default_value = (0.22, 0.25, 0.31, 1)
        bg.inputs[1].default_value = 0.7
    scene.world = world

    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.render.resolution_x = px
    scene.render.resolution_y = px
    scene.render.film_transparent = False
    # "Standard" keeps the model's colors as chosen (Blender's default view transform washes them out).
    scene.view_settings.view_transform = "Standard"
    scene.view_settings.look = "None"
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


def main():
    args = args_after_dashes()
    # Blender treats relative paths differently from the shell; make them absolute.
    script, out_glb = os.path.abspath(args[0]), os.path.abspath(args[1])
    out_png = args[2] if args[2] == "-" else os.path.abspath(args[2])
    px = int(args[3]) if len(args) > 3 else 384
    result = {"ok": False}
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.context.scene.render.fps = FPS
        with open(script, "r", encoding="utf-8") as f:
            code = f.read()
        ns = dict(HELPERS)
        exec(compile(code, "model.py", "exec"), ns)

        objs = mesh_objects()
        if not objs:
            raise RuntimeError("The script ran but created no mesh objects. Add geometry, e.g. bpy.ops.mesh.primitive_cube_add().")
        stats = measure(objs)

        clips = clips_info()
        if clips:
            stats["clips"] = clips
        if any(o.type == "ARMATURE" and all(b in o.data.bones for b in ("Hips", "UpperArm.L", "LowerLeg.R")) for o in bpy.context.scene.objects):
            stats["humanoid"] = True
        if bpy.context.object and bpy.context.object.mode != "OBJECT":
            bpy.ops.object.mode_set(mode="OBJECT")
        bpy.ops.object.select_all(action="DESELECT")
        for o in objs + [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]:
            o.select_set(True)
        bpy.ops.export_scene.gltf(
            filepath=out_glb,
            export_format="GLB",
            use_selection=True,
            export_apply=True,  # apply modifiers
            export_yup=True,
            export_animations=bool(clips),
            export_animation_mode="ACTIONS",  # every clip becomes one named animation
        )
        if out_png != "-":
            render_preview(out_png, stats["bounds"], px)
        stats.pop("bounds", None)
        result = {"ok": True, "stats": stats, "blender": bpy.app.version_string}
    except Exception as e:
        tb = traceback.format_exc()
        # Point at the line in model.py, which is what the author needs.
        model_lines = [l for l in tb.splitlines() if 'File "model.py"' in l]
        result = {"ok": False, "error": f"{type(e).__name__}: {e}", "where": model_lines[-1].strip() if model_lines else None, "traceback": tb[-3000:]}
    print(RESULT_TAG + json.dumps(result), flush=True)
    sys.exit(0 if result["ok"] else 3)


main()
