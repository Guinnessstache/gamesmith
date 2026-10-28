# Blocky knight with Idle, Walk and Attack animations (rigid parts on a rig).
steel = mat("Steel", (0.62, 0.66, 0.72), roughness=0.35, metallic=0.9)
dark = mat("Dark steel", (0.25, 0.27, 0.31), roughness=0.4, metallic=0.9)
cloth = mat("Tabard", (0.62, 0.12, 0.14), roughness=0.85)
gold = mat("Gold", (0.95, 0.72, 0.25), roughness=0.3, metallic=1.0)
wood = mat("Wood", (0.40, 0.24, 0.12), roughness=0.8)


def box(name, size, at, material, bevel=0.015):
    bpy.ops.mesh.primitive_cube_add(size=1, location=at)
    o = bpy.context.object
    o.name = name
    o.scale = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        m = o.modifiers.new("Bevel", "BEVEL")
        m.width = bevel
        m.segments = 2
    return assign(o, material)


# Rest pose: standing, facing -Y. Hips at 0.9 m, shoulders at 1.45 m.
torso = box("Torso", (0.42, 0.26, 0.55), (0, 0, 1.18), steel)
tabard = box("Tabard", (0.44, 0.28, 0.3), (0, 0, 0.98), cloth, 0.01)
belt = box("Belt", (0.45, 0.29, 0.06), (0, 0, 1.06), dark, 0.005)
head = box("Helmet", (0.26, 0.26, 0.3), (0, 0, 1.63), steel, 0.04)
visor = box("Visor", (0.2, 0.02, 0.04), (0, -0.135, 1.66), dark, 0)
bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.04, depth=0.18, location=(0, 0, 1.86))
plume = assign(bpy.context.object, cloth)
leg_l = box("Leg.L", (0.15, 0.17, 0.82), (0.11, 0, 0.41), dark)
leg_r = box("Leg.R", (0.15, 0.17, 0.82), (-0.11, 0, 0.41), dark)
arm_l = box("Arm.L", (0.12, 0.13, 0.55), (0.29, 0, 1.18), steel)
arm_r = box("Arm.R", (0.12, 0.13, 0.55), (-0.29, 0, 1.18), steel)
shield = box("Shield", (0.05, 0.38, 0.46), (0.38, -0.02, 1.08), cloth, 0.02)
boss = box("Boss", (0.03, 0.12, 0.12), (0.41, -0.02, 1.08), gold, 0.01)
blade = box("Blade", (0.05, 0.02, 0.75), (-0.29, -0.16, 1.3), steel, 0.005)
guard = box("Guard", (0.2, 0.05, 0.04), (-0.29, -0.16, 0.93), gold, 0.005)
grip = box("Grip", (0.04, 0.04, 0.14), (-0.29, -0.16, 0.85), wood, 0)

rig = Rig()
rig.bone("Hips", head=(0, 0, 0.9), tail=(0, 0, 1.1))
rig.bone("Chest", head=(0, 0, 1.1), tail=(0, 0, 1.45), parent="Hips")
rig.bone("Head", head=(0, 0, 1.48), tail=(0, 0, 1.8), parent="Chest")
rig.bone("Leg.L", head=(0.11, 0, 0.88), tail=(0.11, 0, 0.1), parent="Hips")
rig.bone("Leg.R", head=(-0.11, 0, 0.88), tail=(-0.11, 0, 0.1), parent="Hips")
rig.bone("Arm.L", head=(0.29, 0, 1.43), tail=(0.29, 0, 0.95), parent="Chest")
rig.bone("Arm.R", head=(-0.29, 0, 1.43), tail=(-0.29, 0, 0.95), parent="Chest")

for part in (torso, tabard, belt):
    rig.attach(part, "Chest" if part is torso else "Hips")
for part in (head, visor, plume):
    rig.attach(part, "Head")
rig.attach(leg_l, "Leg.L")
rig.attach(leg_r, "Leg.R")
for part in (arm_l, shield, boss):
    rig.attach(part, "Arm.L")
for part in (arm_r, blade, guard, grip):
    rig.attach(part, "Arm.R")

with rig.clip("Idle", seconds=2.0):
    rig.pose("Chest", at=1.0, rotate=(3, 0, 0), move=(0, 0, -0.015))
    rig.pose("Head", at=1.0, rotate=(0, 0, 6))
    rig.pose("Arm.R", at=1.0, rotate=(-6, 0, 0))

with rig.clip("Walk", seconds=0.9):
    for t, s in ((0.0, 1), (0.45, -1)):
        rig.pose("Leg.L", at=t, rotate=(-28 * s, 0, 0))
        rig.pose("Leg.R", at=t, rotate=(28 * s, 0, 0))
        rig.pose("Arm.L", at=t, rotate=(18 * s, 0, 0))
        rig.pose("Arm.R", at=t, rotate=(-18 * s, 0, 0))
    for t in (0.225, 0.675):
        rig.pose("Hips", at=t, move=(0, 0, 0.04))

with rig.clip("Attack", seconds=0.8, loop=False):
    rig.pose("Arm.R", at=0.25, rotate=(-150, 0, 0))
    rig.pose("Chest", at=0.25, rotate=(0, 0, -15))
    rig.pose("Arm.R", at=0.45, rotate=(-40, 0, 0))
    rig.pose("Chest", at=0.45, rotate=(8, 0, 20))
    rig.pose("Arm.R", at=0.8, rotate=(0, 0, 0))
    rig.pose("Chest", at=0.8, rotate=(0, 0, 0))
