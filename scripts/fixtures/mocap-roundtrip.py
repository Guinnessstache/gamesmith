# Accuracy test for recorded motions (run through runner.py by test-blender.mjs).
# 1. Pose a "source" humanoid with known rotations.
# 2. Turn its joints into MediaPipe-style landmarks and save them as a motion.
# 3. Apply that motion to a fresh humanoid and compare every bone's direction.
import os, json

src = Rig.humanoid(name="Source")
src._build()


def set_world(rig, bone, deg):
    pb = rig.obj.pose.bones[bone]
    rest = rig.data.bones[bone].matrix_local.to_quaternion()
    world = Euler(tuple(math.radians(a) for a in deg), "XYZ").to_quaternion()
    pb.rotation_quaternion = rest.inverted() @ world @ rest


def landmarks(rig):
    bpy.context.view_layer.update()
    pb = rig.obj.pose.bones
    def at(bone, point):  # a rest-pose point carried along by a posed bone
        b = rig.data.bones[bone]
        return rig.obj.matrix_world @ pb[bone].matrix @ b.matrix_local.inverted() @ Vector(point)
    j = rig.joints
    pts = {}
    for s, sx in (("l", 1), ("r", -1)):
        S = s.upper()
        pts[f"sh_{s}"] = at(f"UpperArm.{S}", j[f"UpperArm.{S}"][0])
        pts[f"el_{s}"] = at(f"LowerArm.{S}", j[f"LowerArm.{S}"][0])
        pts[f"wr_{s}"] = at(f"Hand.{S}", j[f"Hand.{S}"][0])
        pts[f"idx_{s}"] = at(f"Hand.{S}", j[f"Hand.{S}"][1])
        pts[f"hip_{s}"] = at(f"UpperLeg.{S}", j[f"UpperLeg.{S}"][0])
        pts[f"kn_{s}"] = at(f"LowerLeg.{S}", j[f"LowerLeg.{S}"][0])
        pts[f"an_{s}"] = at(f"Foot.{S}", j[f"Foot.{S}"][0])
        pts[f"heel_{s}"] = at(f"Foot.{S}", (0.1 * sx, 0.06, 0.02))
        pts[f"toe_{s}"] = at(f"Foot.{S}", (0.1 * sx, -0.12, 0.02))
        pts[f"ear_{s}"] = at("Head", (0.08 * sx, 0, 1.68))
    pts["nose"] = at("Head", (0, -0.1, 1.66))
    hip = (pts["hip_l"] + pts["hip_r"]) / 2
    out = [[0.0, 0.0, 0.0, 0.0] for _ in range(33)]
    for k, v in pts.items():
        d = v - hip
        out[LM[k]] = [d.x, -d.z, d.y, 1.0]  # Blender -> MediaPipe (x right, y down, z away)
    return out


POSE = {
    "UpperArm.R": (-90, 0, 0),   # right arm straight forward
    "LowerArm.R": (-40, 0, 0),   # elbow bent a bit more
    "UpperArm.L": (0, -70, 0),   # left arm out to the side
    "UpperLeg.L": (-40, 0, 0),   # left knee up
    "LowerLeg.L": (70, 0, 0),    # shin back
    "Chest": (0, 0, 20),         # torso turned
    "Head": (0, 0, 30),          # head turned more
}
frames = [{"w": landmarks(src), "lift": 0.0}]
for bone, deg in POSE.items():
    set_world(src, bone, deg)
frames.append({"w": landmarks(src), "lift": 0.1})
expected = {}
bpy.context.view_layer.update()
for pb in src.obj.pose.bones:
    expected[pb.name] = ((pb.tail - pb.head).normalized(), (pb.matrix.to_quaternion() @ Vector((1, 0, 0))))

folder = os.path.join(motions_dir(), "roundtrip")
os.makedirs(folder, exist_ok=True)
with open(os.path.join(folder, "motion.json"), "w") as f:
    json.dump({"name": "Roundtrip", "fps": 24, "loop": False, "legLength": 0.86, "frames": frames}, f)
bpy.data.objects.remove(src.obj)

# The character that receives the motion
rig = Rig.humanoid()
for bone in ("Hips", "Spine", "Chest", "Head", "UpperArm.L", "LowerArm.L", "UpperArm.R", "LowerArm.R", "UpperLeg.L", "LowerLeg.L", "UpperLeg.R", "LowerLeg.R", "Foot.L", "Foot.R"):
    rig.limb(bone, width=0.1)
rig.apply_motion("Roundtrip", clip="Check")

rig.obj.animation_data.action = bpy.data.actions["Check"]
bpy.context.scene.frame_set(round(1 / 24 * FPS))
bpy.context.view_layer.update()
worst = 0.0
report = []
for pb in rig.obj.pose.bones:
    want_dir, want_side = expected[pb.name]
    got_dir = (pb.tail - pb.head).normalized()
    err = math.degrees(got_dir.angle(want_dir))
    if pb.name in ("Chest", "Head", "Hips"):
        err = max(err, math.degrees((pb.matrix.to_quaternion() @ Vector((1, 0, 0))).angle(want_side)))
    worst = max(worst, err)
    report.append(f"{pb.name} {err:.1f}")
lift = rig.obj.pose.bones["Hips"].matrix.translation.z - rig.joints["Hips"][0].z
rig.obj.animation_data.action = None
bpy.context.scene.frame_set(0)
result = {"worst_deg": round(worst, 2), "lift": round(lift, 3), "bones": report}
print("MOCAP_ROUNDTRIP", json.dumps(result))
with open(os.path.join(motions_dir(), "roundtrip-result.json"), "w") as f:
    json.dump(result, f)
if worst > 3.0:
    raise AssertionError(f"Retargeting is off by {worst:.1f} degrees: {', '.join(report)}")
