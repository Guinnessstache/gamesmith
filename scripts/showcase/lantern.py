# Hanging-style lantern on a stand: iron frame, glowing core.
iron = mat("Iron", (0.12, 0.12, 0.13), roughness=0.5, metallic=0.9)
glass = mat("Glow", (1.0, 0.75, 0.35), roughness=0.2, emission=(1.0, 0.6, 0.2))
bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.16, depth=0.04, location=(0, 0, 0.02))
assign(bpy.context.object, iron)
bpy.ops.mesh.primitive_cylinder_add(vertices=8, radius=0.11, depth=0.28, location=(0, 0, 0.18))
assign(shade_smooth(bpy.context.object), glass)
for a in range(4):
    ang = a * math.pi / 2 + math.pi / 4
    bpy.ops.mesh.primitive_cube_add(size=1, location=(math.cos(ang) * 0.12, math.sin(ang) * 0.12, 0.18))
    p = bpy.context.object; p.scale = (0.02, 0.02, 0.32); assign(p, iron)
bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=0.17, radius2=0.04, depth=0.12, location=(0, 0, 0.38))
assign(bpy.context.object, iron)
bpy.ops.mesh.primitive_torus_add(major_radius=0.05, minor_radius=0.012, location=(0, 0, 0.47), rotation=(math.radians(90), 0, 0))
assign(bpy.context.object, iron)
