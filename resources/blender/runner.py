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
from mathutils import Vector

RESULT_TAG = "GAMESMITH_RESULT "


def args_after_dashes():
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


# ---------- helpers available to asset scripts ----------
def mat(name, color=(0.8, 0.8, 0.8), roughness=0.6, metallic=0.0, emission=None):
    """Create (or reuse) a simple PBR material. color is RGB 0..1."""
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


HELPERS = {"bpy": bpy, "bmesh": bmesh, "math": math, "Vector": Vector, "mat": mat, "assign": assign, "shade_smooth": shade_smooth}


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
    sun_data.energy = 3.5
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
        bg.inputs[0].default_value = (0.42, 0.46, 0.55, 1)
        bg.inputs[1].default_value = 1.0
    scene.world = world

    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 24
    scene.cycles.use_denoising = False
    scene.render.resolution_x = px
    scene.render.resolution_y = px
    scene.render.film_transparent = False
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
        with open(script, "r", encoding="utf-8") as f:
            code = f.read()
        ns = dict(HELPERS)
        exec(compile(code, "model.py", "exec"), ns)

        objs = mesh_objects()
        if not objs:
            raise RuntimeError("The script ran but created no mesh objects. Add geometry, e.g. bpy.ops.mesh.primitive_cube_add().")
        stats = measure(objs)

        bpy.ops.object.select_all(action="DESELECT")
        for o in objs:
            o.select_set(True)
        bpy.ops.export_scene.gltf(
            filepath=out_glb,
            export_format="GLB",
            use_selection=True,
            export_apply=True,  # apply modifiers
            export_yup=True,
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
