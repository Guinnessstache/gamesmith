# Low-poly pine tree, about 4 m tall.
bark = mat("Bark", (0.30, 0.18, 0.10), roughness=0.9)
leaf = mat("Needles", (0.16, 0.40, 0.20), roughness=0.85)
leaf2 = mat("Needles light", (0.22, 0.50, 0.24), roughness=0.85)
bpy.ops.mesh.primitive_cylinder_add(vertices=7, radius=0.16, depth=1.2, location=(0, 0, 0.6))
assign(bpy.context.object, bark)
for i, (r, z, h) in enumerate([(1.3, 1.5, 1.4), (1.05, 2.3, 1.25), (0.8, 3.0, 1.1), (0.5, 3.6, 0.9)]):
    bpy.ops.mesh.primitive_cone_add(vertices=8, radius1=r, depth=h, location=(0, 0, z), rotation=(0, 0, i * 0.4))
    assign(bpy.context.object, leaf if i % 2 == 0 else leaf2)
