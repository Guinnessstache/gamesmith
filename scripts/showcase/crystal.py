# Cluster of glowing crystals on a rock.
rock = mat("Rock", (0.32, 0.30, 0.33), roughness=0.95)
gem = mat("Crystal", (0.35, 0.75, 1.0), roughness=0.1, emission=(0.2, 0.6, 1.0))
bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=1, radius=0.5, location=(0, 0, 0.18))
r = bpy.context.object; r.scale = (1.2, 1.0, 0.45); assign(r, rock)
for (x, y, tilt, h) in [(0, 0, 0, 1.0), (0.22, 0.1, 20, 0.7), (-0.2, 0.05, -18, 0.75), (0.05, -0.2, -12, 0.6), (-0.08, 0.22, 14, 0.55)]:
    bpy.ops.mesh.primitive_cone_add(vertices=6, radius1=0.11, radius2=0.0, depth=h, location=(x, y, 0.25 + h / 2), rotation=(math.radians(tilt), math.radians(tilt * 0.6), 0))
    assign(bpy.context.object, gem)
