"""Import a model pack (Kenney, Quaternius, ...) for Gamesmith's kits, in one Blender run.

    blender -b --factory-startup --python kit_import.py -- jobs.json

jobs.json: {"parts": [{"src": ".../tower.fbx", "out": ".../parts/tower.glb", "thumb": ".../thumbs/tower.png"}, ...]}

Each part is imported, measured, saved as a .glb and given a small thumbnail. Prints
GAMESMITH_PROGRESS <done> <total> as it goes and GAMESMITH_RESULT <json> at the end.
"""
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector


def args_after_dashes():
    argv = sys.argv
    return argv[argv.index("--") + 1:] if "--" in argv else []


def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.actions, bpy.data.armatures, bpy.data.cameras, bpy.data.lights):
        for item in list(coll):
            if item.users == 0:
                coll.remove(item)


def import_file(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise ValueError(f"Can't import {ext} files")


def _drop_bone_shapes(objs):
    """The glTF importer adds a display shape (an "Icosphere" mesh) for bones; it isn't part of the model."""
    shapes = set()
    for o in objs:
        if o.type == "ARMATURE" and o.pose:
            for pb in o.pose.bones:
                if pb.custom_shape is not None:
                    shapes.add(pb.custom_shape)
                    pb.custom_shape = None
    names = [s.name for s in shapes]
    for n in names:
        if n in bpy.data.objects:
            bpy.data.objects.remove(bpy.data.objects[n], do_unlink=True)
    return names


def measure():
    bpy.context.view_layer.update()
    depsgraph = bpy.context.evaluated_depsgraph_get()
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        return None
    lo = Vector((1e9, 1e9, 1e9))
    hi = Vector((-1e9, -1e9, -1e9))
    tris = 0
    for o in meshes:
        ev = o.evaluated_get(depsgraph)
        me = ev.to_mesh()
        mw = o.matrix_world
        for v in me.vertices:
            p = mw @ v.co
            lo = Vector(map(min, lo, p))
            hi = Vector(map(max, hi, p))
        me.calc_loop_triangles()
        tris += len(me.loop_triangles)
        ev.to_mesh_clear()
    size = hi - lo
    return {
        "size": [round(size.x, 3), round(size.y, 3), round(size.z, 3)],
        "min": [round(lo.x, 3), round(lo.y, 3), round(lo.z, 3)],
        "triangles": tris,
        "rigged": any(o.type == "ARMATURE" for o in bpy.context.scene.objects),
        "animations": sorted(a.name for a in bpy.data.actions),
        "bounds": (lo, hi),
    }


def thumbnail(path, bounds, px=128):
    lo, hi = bounds
    center = (lo + hi) / 2
    radius = max((hi - lo).length / 2, 0.01)
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.new("Thumb")
    cam_data.lens = 50
    cam = bpy.data.objects.new("Thumb", cam_data)
    scene.collection.objects.link(cam)
    scene.camera = cam
    d = Vector((1.0, -1.3, 0.85)).normalized()
    dist = radius / math.sin(cam_data.angle / 2) * 1.08
    cam.location = center + d * dist
    cam.rotation_euler = (center - cam.location).to_track_quat("-Z", "Y").to_euler()
    cam_data.clip_end = dist * 10
    scene.render.engine = "BLENDER_WORKBENCH"
    sh = scene.display.shading
    sh.light = "STUDIO"
    sh.color_type = "TEXTURE"
    sh.show_cavity = True
    scene.render.resolution_x = scene.render.resolution_y = px
    scene.render.film_transparent = True
    scene.view_settings.view_transform = "Standard"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam, do_unlink=True)


def main():
    jobs = json.load(open(args_after_dashes()[0], encoding="utf-8"))["parts"]
    bpy.ops.wm.read_factory_settings(use_empty=True)
    results = []
    for i, job in enumerate(jobs):
        r = {"src": job["src"]}
        try:
            clear_scene()
            import_file(job["src"])
            _drop_bone_shapes(list(bpy.context.scene.objects))
            # lights and cameras some packs include aren't part of the model
            for o in list(bpy.context.scene.objects):
                if o.type in ("LIGHT", "CAMERA"):
                    bpy.data.objects.remove(o, do_unlink=True)
            m = measure()
            if not m:
                raise ValueError("no meshes in this file")
            os.makedirs(os.path.dirname(job["out"]), exist_ok=True)
            bpy.ops.object.select_all(action="SELECT")
            bpy.ops.export_scene.gltf(
                filepath=job["out"],
                export_format="GLB",
                use_selection=False,
                export_apply=True,
                export_yup=True,
                export_animations=bool(m["animations"]),
                export_animation_mode="ACTIONS",
            )
            if job.get("thumb"):
                os.makedirs(os.path.dirname(job["thumb"]), exist_ok=True)
                thumbnail(job["thumb"], m.pop("bounds"))
            else:
                m.pop("bounds")
            r.update(ok=True, **m)
        except Exception as e:
            r.update(ok=False, error=f"{type(e).__name__}: {e}", trace=traceback.format_exc()[-600:])
        results.append(r)
        print(f"GAMESMITH_PROGRESS {i + 1} {len(jobs)}", flush=True)
    print("GAMESMITH_RESULT " + json.dumps({"ok": True, "parts": results}), flush=True)


try:
    main()
except Exception as e:
    print("GAMESMITH_RESULT " + json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}), flush=True)
