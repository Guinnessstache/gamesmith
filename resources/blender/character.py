"""Stylized characters for Gamesmith: smooth, rounded, game-style people (think Fortnite or Overwatch,
not photoreal). One fused body with clothes painted on and slightly raised, a face, hair, an optional
hat, all on the standard person skeleton (Rig.humanoid), so recorded motions and clips play on it.

    rig = character(height=1.8, build="hero", hair="short", shirt=(0.85, 0.82, 0.75), vest=(0.45, 0.3, 0.18),
                    pants=texture("denim_fabric", tile=0.5), boots=True, belt=(0.3, 0.18, 0.1), hat="cowboy")

runner.py fills in R (mat, assign, Rig, box_uv) before model scripts run.
"""
import math

import bmesh
import bpy
from mathutils import Vector

R = None  # set by runner.py: an object with mat, assign, Rig, box_uv

BUILDS = {
    # girth multipliers; "head" is head size
    "average": dict(shoulders=1.0, chest=1.0, waist=1.0, hips=1.0, arms=1.0, legs=1.0, head=1.05, hands=1.0, feet=1.0),
    "hero": dict(shoulders=1.12, chest=1.1, waist=0.92, hips=1.0, arms=1.12, legs=1.06, head=1.1, hands=1.15, feet=1.1),
    "slim": dict(shoulders=0.95, chest=0.88, waist=0.86, hips=0.94, arms=0.86, legs=0.9, head=1.06, hands=1.0, feet=1.0),
    "heavy": dict(shoulders=1.12, chest=1.28, waist=1.5, hips=1.28, arms=1.25, legs=1.2, head=1.08, hands=1.2, feet=1.15),
    "strong": dict(shoulders=1.25, chest=1.3, waist=1.05, hips=1.05, arms=1.4, legs=1.2, head=1.0, hands=1.3, feet=1.15),
    "kid": dict(shoulders=0.95, chest=0.95, waist=1.0, hips=0.95, arms=0.95, legs=0.95, head=1.35, hands=1.1, feet=1.1),
}

HATS = ("cowboy", "cap", "beanie", "top", None)
HAIRS = ("short", "long", "buzz", "ponytail", "bun", "spiky", "bald", None)


# ---------------------------------------------------------------- small helpers
def _mat(name, value, roughness=0.6):
    if isinstance(value, bpy.types.Material):
        return value
    return R.mat(name, tuple(value), roughness=roughness)


def _tris(obj):
    return sum(len(p.vertices) - 2 for p in obj.data.polygons)


def _apply(obj, mod):
    with bpy.context.temp_override(object=obj, active_object=obj, selected_objects=[obj], selected_editable_objects=[obj]):
        bpy.ops.object.modifier_apply(modifier=mod.name)


class _Parts:
    """Collects simple shapes, then fuses them into one smooth surface."""

    def __init__(self):
        self.objs = []

    def ball(self, c, size, segments=24):
        if isinstance(size, (int, float)):
            size = (size, size, size)
        bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=segments // 2, radius=1, location=c)
        o = bpy.context.object
        o.scale = size
        self.objs.append(o)
        return o

    def tube(self, a, b, r1, r2, caps=True):
        a, b = Vector(a), Vector(b)
        d = b - a
        if d.length < 1e-5:
            return self.ball(a, r1)
        bpy.ops.mesh.primitive_cone_add(vertices=24, radius1=r1, radius2=r2, depth=d.length, location=(a + b) / 2)
        o = bpy.context.object
        o.rotation_mode = "QUATERNION"
        o.rotation_quaternion = Vector((0, 0, 1)).rotation_difference(d.normalized())
        self.objs.append(o)
        if caps:
            self.ball(a, r1)
            self.ball(b, r2)
        return o

    def fuse(self, name, voxel=0.008, smooth=10, max_tris=14000):
        objs = self.objs
        for o in objs:
            o.select_set(True)
        with bpy.context.temp_override(active_object=objs[0], object=objs[0], selected_objects=objs, selected_editable_objects=objs):
            bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
            bpy.ops.object.join()
        obj = objs[0]
        obj.name = name
        obj.data.name = name
        m = obj.modifiers.new("Fuse", "REMESH")
        m.mode = "VOXEL"
        m.voxel_size = voxel
        _apply(obj, m)
        if smooth:
            m = obj.modifiers.new("Soften", "SMOOTH")
            m.factor = 0.8
            m.iterations = smooth
            _apply(obj, m)
        if max_tris and _tris(obj) > max_tris:
            m = obj.modifiers.new("Trim", "DECIMATE")
            m.ratio = max_tris / _tris(obj)
            _apply(obj, m)
        for p in obj.data.polygons:
            p.use_smooth = True
        self.objs = []
        return obj


def _attach(rig, obj, bone):
    bpy.context.view_layer.update()
    return rig.attach(obj, bone)


def _segment(p, a, b):
    """Distance from p to segment a-b, and how far along it (0..1)."""
    ab = b - a
    L2 = ab.length_squared or 1e-9
    t = max(0.0, min(1.0, (p - a).dot(ab) / L2))
    return (p - (a + ab * t)).length, t


def _bisect(obj, co, no):
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=co, plane_no=no)
    bm.to_mesh(obj.data)
    bm.free()


def _cut_below(obj, co, no):
    """Remove everything on the -no side of a plane (keeps the rest)."""
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    geom = bm.verts[:] + bm.edges[:] + bm.faces[:]
    bmesh.ops.bisect_plane(bm, geom=geom, dist=1e-5, plane_co=co, plane_no=no, clear_inner=True)
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()


# ---------------------------------------------------------------- the character
def character(height=1.8, build="hero", body="male", skin=(0.94, 0.72, 0.58), hair="short", hair_color=(0.28, 0.17, 0.09),
              beard=None, eye_color=(0.3, 0.45, 0.65), shirt=(0.88, 0.86, 0.8), sleeves="long", pants=(0.25, 0.35, 0.6),
              legs="long", shoes=(0.3, 0.2, 0.13), boots=False, belt=None, gloves=None, vest=None, hat=None,
              hat_color=(0.55, 0.4, 0.25), name="Character", detail=1.0):
    """A stylized game character on the standard person skeleton. Returns the rig; rig.parts has the
    pieces ("body", "head", "eyes", "hair", "beard", "hat", "buckle"). Colors are (r, g, b) 0..1 or a
    material (mat(...) or texture(...)). Accessories: make them and rig.attach(obj, "Head" / "Hand.R" / ...).
    build: hero, average, slim, strong, heavy, kid. body: male or female.
    hair: short, long, buzz, ponytail, bun, spiky, bald. beard: None, stubble, full, mustache.
    sleeves: long, short, none. legs: long, shorts. hat: cowboy, cap, beanie, top, None.
    detail: 0.5 (lighter) to 2 (smoother); about 18k triangles at 1."""
    if build not in BUILDS:
        raise ValueError(f'character: build must be one of {", ".join(BUILDS)}')
    if hair not in HAIRS:
        raise ValueError(f'character: hair must be one of {", ".join(str(h) for h in HAIRS)}')
    if hat not in HATS:
        raise ValueError(f'character: hat must be one of {", ".join(str(h) for h in HATS)}')
    b = dict(BUILDS[build])
    tag = "" if name == "Character" else f"{name} "

    def cmat(label, value, roughness=0.6, **kw):
        if isinstance(value, bpy.types.Material):
            return value
        return R.mat(tag + label, tuple(value), roughness=roughness, **kw)

    female = str(body).lower().startswith("f")
    if female:
        b.update(shoulders=b["shoulders"] * 0.9, chest=b["chest"] * 0.92, waist=b["waist"] * 0.88, hips=b["hips"] * 1.12,
                 arms=b["arms"] * 0.85, legs=b["legs"] * 0.97, hands=b["hands"] * 0.88, feet=b["feet"] * 0.9)
    H = float(height)
    k = H / 1.8  # everything below is designed at 1.8 m and scaled
    rig = R.Rig.humanoid(height=H, name=name, shoulders=0.222 * H * b["shoulders"], hips=0.111 * H * b["hips"] ** 0.5)
    J = rig.joints
    V = Vector

    mats = {
        "skin": cmat("Skin", skin, 0.55),
        "shirt": cmat("Shirt", shirt, 0.75),
        "pants": cmat("Pants", pants, 0.8),
        "shoes": cmat("Shoes" if not boots else "Boots", shoes, 0.55),
        "sole": cmat("Soles", tuple(c * 0.35 for c in (shoes if not isinstance(shoes, bpy.types.Material) else (0.2, 0.2, 0.2))), 0.7),
    }
    if belt is not None:
        mats["belt"] = cmat("Belt", belt, 0.45)
    if gloves is not None:
        mats["gloves"] = cmat("Gloves", gloves, 0.6)
    if vest is not None:
        mats["vest"] = cmat("Vest", vest, 0.7)

    # ---- body: simple shapes fused into one surface
    P = _Parts()
    hip_h = J["Hips"][0]
    sp_t = J["Spine"][1]
    ch_h = J["Chest"][0]
    nk_h, nk_t = J["Neck"]
    sh = J["UpperArm.L"][0]
    P.ball(hip_h + V((0, 0.005 * k, 0.04 * k)), (0.13 * k * b["hips"], 0.1 * k * b["hips"], 0.11 * k))
    P.ball(sp_t + V((0, 0, -0.02 * k)), (0.125 * k * b["waist"], 0.088 * k * b["waist"], 0.13 * k))
    chest_c = ch_h + V((0, 0, 0.1 * k))
    P.ball(chest_c, (0.165 * k * b["chest"], 0.105 * k * b["chest"], 0.15 * k))
    if female:
        for sx in (1, -1):
            P.ball(chest_c + V((0.06 * k * sx, -0.07 * k * b["chest"], -0.02 * k)), (0.06 * k, 0.055 * k, 0.055 * k))
    for sx in (1, -1):  # trapezius: neck to shoulder, so arms join the torso smoothly
        P.tube(nk_h + V((0.02 * k * sx, 0, -0.01 * k)), V((sh.x * sx * 0.92, 0, sh.z + 0.005 * k)), 0.06 * k * b["shoulders"], 0.055 * k * b["arms"])
    P.tube(nk_h - V((0, 0, 0.05 * k)), nk_t + V((0, 0, 0.02 * k)), 0.05 * k * b["shoulders"] ** 0.5, 0.046 * k)
    for s, sx in (("L", 1), ("R", -1)):
        ua, la, hd = J[f"UpperArm.{s}"], J[f"LowerArm.{s}"], J[f"Hand.{s}"]
        ul, ll, ft = J[f"UpperLeg.{s}"], J[f"LowerLeg.{s}"], J[f"Foot.{s}"]
        P.ball(ua[0] + V((0, 0, -0.005 * k)), 0.062 * k * b["arms"])
        P.tube(ua[0], ua[1], 0.054 * k * b["arms"], 0.042 * k * b["arms"])
        P.tube(la[0], la[1], 0.043 * k * b["arms"], 0.032 * k * b["arms"] ** 0.7)
        hs = b["hands"] * k
        palm = hd[0] + (hd[1] - hd[0]) * 0.42
        P.ball(palm, (0.024 * hs, 0.045 * hs, 0.052 * hs))
        P.tube(palm + V((0, -0.01 * hs, -0.03 * hs)), hd[1] + V((0, -0.008 * hs, -0.012 * hs)), 0.02 * hs, 0.016 * hs)  # fingers
        P.tube(hd[0] + V((0.004 * sx * hs, -0.03 * hs, -0.012 * hs)), hd[0] + V((0.008 * sx * hs, -0.058 * hs, -0.05 * hs)), 0.014 * hs, 0.012 * hs)  # thumb
        P.tube(ul[0] + V((0, 0, 0.02 * k)), ul[1], 0.082 * k * b["legs"], 0.058 * k * b["legs"])
        P.tube(ll[0], ll[1], 0.058 * k * b["legs"], 0.04 * k * b["legs"] ** 0.7)
        f = b["feet"] * k * (1.12 if boots else 1.0)
        P.ball(ft[0] + (ft[1] - ft[0]) * 0.45 + V((0, -0.005 * k, -0.005 * k)), (0.05 * f, 0.115 * f, 0.048 * f))
        P.ball(ll[1] + V((0, 0.012 * k, -0.01 * k)), (0.045 * f, 0.05 * f, 0.05 * f))  # heel
    body_obj = P.fuse("Body", voxel=0.008 * k, smooth=10, max_tris=int(14000 * detail))
    # flat soles standing on the ground
    for v in body_obj.data.vertices:
        if v.co.z < 0.0:
            v.co.z = 0.0

    # ---- clothes: crisp hem lines, then paint each face and raise cloth slightly
    waist_z = hip_h.z + 0.085 * k
    belt_h = 0.035 * k if belt is not None else 0.0
    bones = {n: (h, t) for n, (h, t) in J.items() if n != "Head"}

    def at(bone, t):
        h, tl = bones[bone]
        return h + (tl - h) * t

    cuts = [((0, 0, waist_z), (0, 0, 1)), ((0, 0, 0.018 * k), (0, 0, 1))]
    if belt is not None:
        cuts.append(((0, 0, waist_z - belt_h), (0, 0, 1)))
    sleeve_t = {"long": None, "short": 0.55, "none": 0.0}.get(sleeves, None)
    open_w = 0.035 * k
    armhole = 0.155 * k * b["chest"]
    neck_z = J["Neck"][0].z
    if vest is not None:
        cuts.append(((0, 0, neck_z - 0.01 * k), (0, 0, 1)))
        for sx in (1, -1):
            cuts.append(((open_w * sx, 0, 0), (1, 0, 0)))
            cuts.append(((armhole * sx, 0, 0), (1, 0, 0)))
    for s in ("L", "R"):
        if sleeve_t:
            ua = bones[f"UpperArm.{s}"]
            cuts.append((at(f"UpperArm.{s}", sleeve_t), ua[1] - ua[0]))
        la = bones[f"LowerArm.{s}"]
        cuts.append((at(f"LowerArm.{s}", 0.93), la[1] - la[0]))
    ll0, ll1 = bones["LowerLeg.L"]
    if legs == "shorts":
        cuts.append(((0, 0, at("UpperLeg.L", 0.55).z), (0, 0, 1)))
    shoe_top = at("LowerLeg.L", 0.5 if boots else 0.93).z
    cuts.append(((0, 0, shoe_top), (0, 0, 1)))
    for co, no in cuts:
        _bisect(body_obj, Vector(co), Vector(no).normalized())

    def nearest(p):
        best = None
        for n, (h, tl) in bones.items():
            d, t = _segment(p, h, tl)
            if best is None or d < best[0]:
                best = (d, n, t)
        return best[1], best[2]

    def torso(p):
        z = p.z
        if z < waist_z - belt_h:
            return "pants"
        if belt is not None and z < waist_z:
            return "belt"
        if vest is not None and not (abs(p.x) < open_w and p.y < 0) and z < neck_z - 0.01 * k:
            return "vest"
        return "shirt"

    def region(p):
        z = p.z
        if waist_z - belt_h - 0.06 * k <= z < neck_z and abs(p.x) < armhole:
            return torso(p)
        bone, t = nearest(p)
        if z < 0.018 * k and (bone.startswith("Foot") or bone.startswith("LowerLeg")):
            return "sole"
        if bone.startswith("Foot"):
            return "shoes"
        if bone.startswith("LowerLeg"):
            if z <= shoe_top + 1e-4:
                return "shoes"
            return "skin" if legs == "shorts" else "pants"
        if bone.startswith("UpperLeg"):
            if legs == "shorts" and z < at("UpperLeg.L", 0.55).z:
                return "skin"
            return "pants"
        if bone.startswith("Hand"):
            return "gloves" if gloves is not None else "skin"
        if bone.startswith("LowerArm"):
            if gloves is not None and t > 0.75:
                return "gloves"
            if sleeves == "long":
                h, tl = bones[bone]
                if (p - at(bone, 0.93)).dot(tl - h) < 0:
                    return "shirt"
            return "skin"
        if bone.startswith("UpperArm"):
            if sleeves == "long":
                return "shirt"
            if sleeves == "none":
                return "skin"
            h, tl = bones[bone]
            return "shirt" if (p - at(bone, sleeve_t)).dot(tl - h) < 0 else "skin"
        if bone == "Neck":
            return "skin" if z > J["Neck"][0].z + 0.005 * k or sleeves != "long" else "shirt"
        if bone in ("Hips", "Spine", "Chest") and vest is not None and abs(p.x) >= armhole:
            return "shirt"
        return torso(p)

    raise_by = {"shirt": 0.004, "pants": 0.005, "vest": 0.011, "belt": 0.009, "shoes": 0.009, "sole": 0.009, "gloves": 0.004, "skin": 0.0}
    me = body_obj.data
    me.update()
    order = ["skin", "shirt", "pants", "shoes", "sole"] + [x for x in ("belt", "gloves", "vest") if x in mats]
    for key in order:
        me.materials.append(mats[key])
    slot = {key: i for i, key in enumerate(order)}
    vreg = [region(v.co) for v in me.vertices]
    for poly in me.polygons:
        reg = region(poly.center)
        poly.material_index = slot.get(reg, 0)
    normals = [v.normal.copy() for v in me.vertices]
    for v, reg, n in zip(me.vertices, vreg, normals):
        if v.co.z > 0.002 * k:
            v.co += n * raise_by.get(reg, 0.0) * k
    me.update()
    if any(m.get("gs_tile") for m in me.materials):
        R.box_uv(body_obj, 0.6 * k)

    # ---- skin weights: each vertex follows its nearest bone, blended across joints
    children = {}
    parents = {}
    for n, (_h, _t, parent) in rig._bones.items():
        parents[n] = parent
        children.setdefault(parent, []).append(n)
    groups = {n: body_obj.vertex_groups.new(name=n) for n in rig._bones}
    blend = 0.22
    for v in me.vertices:
        bone, t = nearest(v.co)
        w = {bone: 1.0}
        par = parents.get(bone)
        kids = [c for c in children.get(bone, []) if c in bones]
        if t < blend and par and par in bones:
            x = 0.5 * (1 - t / blend)
            w = {bone: 1 - x, par: x}
        elif t > 1 - blend and len(kids) == 1:
            x = 0.5 * (1 - (1 - t) / blend)
            w = {bone: 1 - x, kids[0]: x}
        for n, x in w.items():
            groups[n].add([v.index], x, "REPLACE")
    rig._build()
    body_obj.parent = rig.obj
    arm = body_obj.modifiers.new("Skeleton", "ARMATURE")
    arm.object = rig.obj

    # ---- head
    head_b, head_t = J["Head"]
    hs = b["head"] * k
    hc = head_b + (head_t - head_b) * 0.47 + V((0, 0.006 * k, 0))
    W, D, Hh = 0.082 * hs, 0.098 * hs, 0.118 * hs  # half sizes
    P.ball(hc + V((0, 0.006 * hs, 0.012 * hs)), (W, D, Hh * 0.92))                                  # cranium
    jaw_w = 0.8 if not female else 0.72
    P.ball(hc + V((0, -0.022 * hs, -0.055 * hs)), (W * jaw_w, D * 0.72, Hh * 0.55))                 # jaw
    P.ball(hc + V((0, -0.062 * hs, -0.085 * hs)), (0.03 * hs, 0.025 * hs, 0.022 * hs))             # chin
    for sx in (1, -1):
        P.ball(hc + V((0.04 * hs * sx, -0.05 * hs, -0.022 * hs)), (0.024 * hs, 0.02 * hs, 0.02 * hs))  # cheeks
        P.ball(hc + V((W * 0.97 * sx, 0.004 * hs, -0.004 * hs)), (0.012 * hs, 0.022 * hs, 0.03 * hs))    # ears
    nose_tip = hc + V((0, -D - 0.004 * hs, -0.024 * hs))
    P.tube(hc + V((0, -D + 0.008 * hs, 0.006 * hs)), nose_tip, 0.007 * hs, 0.011 * hs)                # nose
    P.ball(nose_tip + V((0, 0.006 * hs, -0.002 * hs)), (0.015 * hs, 0.01 * hs, 0.009 * hs))          # nostrils
    head_obj = P.fuse("Head", voxel=0.004 * k, smooth=8, max_tris=int(5000 * detail))
    R.assign(head_obj, mats["skin"])
    _attach(rig, head_obj, "Head")

    def surface(x, z):
        """The face surface at (x, z) seen from the front: (point, outward normal), in world space."""
        bpy.context.view_layer.update()
        mw = head_obj.matrix_world
        inv = mw.inverted()
        hit, loc, nrm, _i = head_obj.ray_cast(inv @ Vector((x, -2.0, z)), (inv.to_3x3() @ Vector((0, 1, 0))).normalized())
        if not hit:
            return Vector((x, hc.y - D, z)), Vector((0, -1, 0))
        return mw @ loc, (mw.to_3x3() @ nrm).normalized()

    def front_y(x, z):
        return surface(x, z)[0].y

    parts = {"body": body_obj, "head": head_obj}
    # eyes: white, iris, pupil
    eye_white = cmat("Eye white", (0.95, 0.95, 0.93), roughness=0.25)
    iris = cmat("Iris", eye_color, 0.3)
    pupil = cmat("Pupil", (0.02, 0.02, 0.025), roughness=0.2)
    eye_z = hc.z + 0.004 * hs
    eye_objs = []
    for sx in (1, -1):
        ex = 0.034 * hs * sx
        # eyes are lens shapes lying on the face (stylized, like painted-on game eyes), turned to the surface
        at_, n = surface(ex, eye_z)
        turn = Vector((0, -1, 0)).rotation_difference(n)
        er = 0.0165 * hs

        def lens(radius, flat, lift, material, segs=20):
            bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=segs // 2, radius=radius, location=at_ + n * lift)
            o = bpy.context.object
            o.scale = (1.0, flat, 1.1)
            o.rotation_mode = "QUATERNION"
            o.rotation_quaternion = turn
            R.assign(o, material)
            return o

        white = lens(er, 0.32, -er * 0.22, eye_white)
        # each one sits just in front of the one below (white front at +0.10 er)
        ir = lens(er * 0.6, 0.22, 0.10 * er + 0.02 * er - 0.6 * 0.22 * er, iris, 16)
        pu = lens(er * 0.3, 0.2, 0.12 * er + 0.02 * er - 0.3 * 0.2 * er, pupil, 12)
        for o in (white, ir, pu):
            for p in o.data.polygons:
                p.use_smooth = True
            _attach(rig, o, "Head")
            eye_objs.append(o)
        # eyebrow
        brow_mat = cmat("Brows", hair_color, 0.8)
        bz = eye_z + 0.03 * hs
        a = V((0.018 * hs * sx, front_y(0.018 * hs * sx, bz) + 0.004 * hs, bz))
        c = V((0.05 * hs * sx, front_y(0.05 * hs * sx, bz - 0.004 * hs) + 0.005 * hs, bz - 0.004 * hs))
        P.tube(a, c, 0.0065 * hs, 0.004 * hs)
        brow = P.fuse(f"Brow.{'L' if sx > 0 else 'R'}", voxel=0.0018 * k, smooth=2, max_tris=400)
        R.assign(brow, brow_mat)
        _attach(rig, brow, "Head")
        eye_objs.append(brow)
    parts["eyes"] = eye_objs
    # mouth: a soft darker line
    mz = hc.z - 0.052 * hs
    lip = cmat("Lips", tuple(c * 0.72 for c in (skin if not isinstance(skin, bpy.types.Material) else (0.8, 0.55, 0.45))), 0.5)
    pts = [V((x * hs, 0, mz + 0.004 * hs * (1 - (x / 0.024) ** 2) * -1)) for x in (-0.024, -0.012, 0, 0.012, 0.024)]
    for p_ in pts:
        p_.y = front_y(p_.x, p_.z) + 0.002 * hs
    for a, c in zip(pts, pts[1:]):
        P.tube(a, c, 0.0042 * hs, 0.0042 * hs)
    mouth = P.fuse("Mouth", voxel=0.0016 * k, smooth=2, max_tris=500)
    R.assign(mouth, lip)
    _attach(rig, mouth, "Head")
    parts["mouth"] = mouth

    # ---- hair
    hair_mat = cmat("Hair", hair_color, 0.85)
    top = hc + V((0, 0.006 * hs, 0.012 * hs))
    if hair in ("short", "long", "ponytail", "bun", "spiky"):
        P.ball(top + V((0, 0.004 * hs, 0.008 * hs)), (W * 1.05, D * 1.045, Hh * 0.96))
        P.ball(top + V((0, -0.03 * hs, 0.075 * hs)), (W * 0.8, D * 0.5, Hh * 0.32))  # volume at the front
        # clumps, swept to one side, so it reads as hair and not a helmet (not under a hat)
        for ax, ay, az in ([] if hat else [(-0.05, -0.075, 0.05), (-0.015, -0.085, 0.06), (0.025, -0.08, 0.06), (0.055, -0.06, 0.045),
                           (-0.06, -0.035, 0.065), (-0.02, -0.04, 0.085), (0.025, -0.035, 0.085), (0.06, -0.02, 0.065),
                           (-0.04, 0.02, 0.085), (0.01, 0.02, 0.092), (0.05, 0.03, 0.075)]):
            c = top + V((ax * hs, ay * hs, az * hs))
            P.tube(c, c + V((0.03 * hs, 0.012 * hs, -0.01 * hs)), 0.02 * hs, 0.011 * hs)
        if hair == "spiky" and not hat:
            for i in range(7):
                ang = math.radians(-60 + i * 20)
                base = top + V((math.sin(ang) * W * 0.6, -0.02 * hs + 0.02 * hs * (i % 2), Hh * 0.75))
                P.tube(base, base + V((math.sin(ang) * 0.03 * hs, 0.02 * hs, 0.06 * hs)), 0.024 * hs, 0.004 * hs)
        if hair == "long":
            P.ball(top + V((0, 0.05 * hs, -0.06 * hs)), (W * 1.02, D * 0.75, Hh * 1.05))
            for sx in (1, -1):
                P.ball(top + V((W * 0.85 * sx, 0.01 * hs, -0.07 * hs)), (W * 0.3, D * 0.6, Hh * 0.75))
        if hair == "ponytail":
            P.tube(top + V((0, D * 0.95, 0.0)), top + V((0, D * 1.35, -0.16 * hs)), 0.03 * hs, 0.018 * hs)
        if hair == "bun" and not hat:
            P.ball(top + V((0, D * 0.75, Hh * 0.55)), 0.045 * hs)
        cap = P.fuse("Hair", voxel=0.004 * k, smooth=3, max_tris=int(3500 * detail))
        # hairline: higher at the forehead, lower at the back and down the sides for long hair
        front_cut = hc.z + 0.072 * hs
        back_cut = hc.z - (0.15 if hair == "long" else 0.055) * hs
        no = V((0, (front_cut - back_cut), 2 * D)).normalized()
        _cut_below(cap, V((0, 0, (front_cut + back_cut) / 2)), no)
        if hair != "long":
            _cut_below(cap, V((0, 0, hc.z - 0.04 * hs)), V((0, 0, 1)))
        R.assign(cap, hair_mat)
        _attach(rig, cap, "Head")
        parts["hair"] = cap
    elif hair == "buzz":
        P.ball(top, (W * 1.025, D * 1.025, Hh * 0.95))
        cap = P.fuse("Hair", voxel=0.004 * k, smooth=4, max_tris=int(2000 * detail))
        _cut_below(cap, V((0, 0, hc.z + 0.01 * hs)), V((0, 0.35, 1)).normalized())
        R.assign(cap, hair_mat)
        _attach(rig, cap, "Head")
        parts["hair"] = cap

    # ---- beard
    if beard:
        if beard == "mustache":
            for sx in (1, -1):
                a = V((0.004 * hs * sx, 0, mz + 0.014 * hs))
                c = V((0.028 * hs * sx, 0, mz + 0.002 * hs))
                a.y = front_y(a.x, a.z) + 0.004 * hs
                c.y = front_y(c.x, c.z) + 0.004 * hs
                P.tube(a, c, 0.008 * hs, 0.004 * hs)
        else:
            full = beard == "full"
            g = 1.06 if full else 1.02
            P.ball(hc + V((0, -0.022 * hs, -0.056 * hs)), (W * jaw_w * g, D * 0.72 * g, Hh * 0.55 * g))
            P.ball(hc + V((0, -0.062 * hs, -0.087 * hs)), (0.031 * hs * g, 0.026 * hs * g, 0.023 * hs * g))
            if full:
                P.ball(hc + V((0, -0.06 * hs, -0.11 * hs)), (0.04 * hs, 0.03 * hs, 0.035 * hs))
        bd = P.fuse("Beard", voxel=0.003 * k, smooth=4, max_tris=int(2500 * detail))
        if beard != "mustache":
            _cut_below(bd, V((0, 0, mz + 0.008 * hs)), V((0, 0.0, -1)))
            _cut_below(bd, V((0, 0, hc.z - 0.13 * hs)), V((0, 0, 1)))
        tone = hair_color if beard != "stubble" or isinstance(skin, bpy.types.Material) else tuple(s * 0.84 + h * 0.16 for s, h in zip(skin, hair_color))
        R.assign(bd, cmat("Beard", tone, 0.9))
        _attach(rig, bd, "Head")
        parts["beard"] = bd

    # ---- hat
    if hat:
        hm = cmat("Hat", hat_color, 0.75)
        crown_z = hc.z + Hh * 0.5
        if hat == "cowboy":
            P.tube(V((0, 0.004 * hs, crown_z - 0.01 * hs)), V((0, 0.004 * hs, crown_z + 0.085 * hs)), W * 1.12, W * 0.97)
            P.ball(V((0, 0.004 * hs, crown_z + 0.085 * hs)), (W * 0.97, D * 0.92, 0.03 * hs))
            crown = P.fuse("Hat crown", voxel=0.004 * k, smooth=6, max_tris=2500)
            # dent on top, pinched front
            for v in crown.data.vertices:
                rel = v.co - V((0, 0.004 * hs, crown_z + 0.08 * hs))
                if rel.z > -0.01 * hs:
                    v.co.z -= 0.022 * hs * max(0.0, 1 - (abs(rel.x) / (W * 0.45)) ** 2)
            # brim: a disc of rings, sides curled up, front and back dipping a little
            rings, segs = 10, 64
            rx, ry = W * 2.3, D * 2.0
            inner = 0.45
            verts, faces = [], []
            for i in range(rings + 1):
                f = inner + (1 - inner) * i / rings
                for jn in range(segs):
                    a = 2 * math.pi * jn / segs
                    x, y = math.cos(a) * rx * f, math.sin(a) * ry * f
                    edge = max(0.0, (f - 0.62) / 0.38)
                    side = abs(math.cos(a))
                    z = 0.055 * hs * edge ** 2 * side ** 2 - 0.014 * hs * edge * (1 - side) ** 2
                    verts.append((x, y + 0.004 * hs, crown_z - 0.012 * hs + z))
            for i in range(rings):
                for jn in range(segs):
                    a0 = i * segs + jn
                    a1 = i * segs + (jn + 1) % segs
                    faces.append((a0, a1, a1 + segs, a0 + segs))
            bm_me = bpy.data.meshes.new("Hat brim")
            bm_me.from_pydata(verts, [], faces)
            bm_me.update()
            brim = bpy.data.objects.new("Hat brim", bm_me)
            bpy.context.scene.collection.objects.link(brim)
            for p in brim.data.polygons:
                p.use_smooth = True
            m = brim.modifiers.new("Thick", "SOLIDIFY")
            m.thickness = 0.006 * hs
            _apply(brim, m)
            for o in (crown, brim):
                R.assign(o, hm)
                _attach(rig, o, "Head")
            band = cmat("Hat band", tuple(c * 0.45 for c in (hat_color if not isinstance(hat_color, bpy.types.Material) else (0.4, 0.3, 0.2))), 0.6)
            bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=W * 1.125, depth=0.016 * hs, location=(0, 0.004 * hs, crown_z + 0.002 * hs))
            bd_ = bpy.context.object
            bd_.scale.y = D / W * 0.99
            R.assign(bd_, band)
            _attach(rig, bd_, "Head")
            parts["hat"] = [crown, brim, bd_]
        elif hat == "cap":
            P.ball(V((0, 0.006 * hs, crown_z - 0.012 * hs)), (W * 1.1, D * 1.08, Hh * 0.62))
            capo = P.fuse("Cap", voxel=0.004 * k, smooth=4, max_tris=2500)
            _cut_below(capo, V((0, 0, crown_z - 0.01 * hs)), V((0, 0.25, 1)).normalized())
            bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=1, depth=0.006 * hs, location=(0, -D * 1.05, crown_z - 0.03 * hs))
            vis = bpy.context.object
            vis.scale = (W * 0.95, D * 0.6, 1)
            vis.rotation_euler.x = math.radians(-8)
            for o in (capo, vis):
                R.assign(o, hm)
                _attach(rig, o, "Head")
            parts["hat"] = [capo, vis]
        elif hat == "beanie":
            P.ball(V((0, 0.006 * hs, crown_z - 0.0 * hs)), (W * 1.12, D * 1.1, Hh * 0.8))
            bea = P.fuse("Beanie", voxel=0.004 * k, smooth=4, max_tris=2500)
            _cut_below(bea, V((0, 0, crown_z - 0.035 * hs)), V((0, 0.2, 1)).normalized())
            R.assign(bea, hm)
            _attach(rig, bea, "Head")
            parts["hat"] = [bea]
        elif hat == "top":
            P.tube(V((0, 0.004 * hs, crown_z - 0.01 * hs)), V((0, 0.004 * hs, crown_z + 0.17 * hs)), W * 1.08, W * 1.12, caps=False)
            tophat = P.fuse("Top hat", voxel=0.004 * k, smooth=1, max_tris=2000)
            bpy.ops.mesh.primitive_cylinder_add(vertices=48, radius=W * 1.75, depth=0.008 * hs, location=(0, 0.004 * hs, crown_z - 0.01 * hs))
            brim = bpy.context.object
            brim.scale.y = D / W
            for o in (tophat, brim):
                R.assign(o, hm)
                _attach(rig, o, "Head")
            parts["hat"] = [tophat, brim]

    # ---- belt buckle
    if belt is not None:
        bz = waist_z - belt_h / 2
        by = None
        bpy.context.view_layer.update()
        inv = body_obj.matrix_world.inverted()
        hit, loc, _n, _i = body_obj.ray_cast(inv @ V((0, -2.0, bz)), (inv.to_3x3() @ V((0, 1, 0))).normalized())
        by = (body_obj.matrix_world @ loc).y if hit else -0.12 * k
        bpy.ops.mesh.primitive_cube_add(size=1, location=(0, by - 0.006 * k, bz))
        buckle = bpy.context.object
        buckle.name = "Buckle"
        buckle.scale = (0.05 * k, 0.012 * k, belt_h * 0.95)
        with bpy.context.temp_override(object=buckle, active_object=buckle, selected_editable_objects=[buckle]):
            bpy.ops.object.transform_apply(scale=True)
        m = buckle.modifiers.new("Round", "BEVEL")
        m.width = 0.004 * k
        m.segments = 2
        _apply(buckle, m)
        R.assign(buckle, cmat("Buckle", (0.85, 0.7, 0.35), roughness=0.3, metallic=0.9))
        _attach(rig, buckle, "Hips")
        parts["buckle"] = buckle

    rig.parts = parts
    return rig
