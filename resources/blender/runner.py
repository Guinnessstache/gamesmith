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
from mathutils import Euler, Vector

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


HELPERS = {"bpy": bpy, "bmesh": bmesh, "math": math, "Vector": Vector, "mat": mat, "assign": assign, "shade_smooth": shade_smooth, "Rig": Rig, "FPS": FPS}


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
