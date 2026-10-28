# Treasure chest: wooden body, curved lid, gold bands and lock.
wood = mat("Oak", (0.42, 0.24, 0.11), roughness=0.75)
dark = mat("Dark oak", (0.25, 0.13, 0.06), roughness=0.8)
gold = mat("Gold", (0.95, 0.72, 0.25), roughness=0.28, metallic=1.0)

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 0.25))
body = bpy.context.object; body.name = "Body"; body.scale = (0.9, 0.56, 0.5)
mod = body.modifiers.new("Bevel", "BEVEL"); mod.width = 0.02; mod.segments = 2
assign(body, wood)

def half_cylinder(name, radius, length, x=0.0):
    """Top half of a cylinder lying along X, closed at both ends (a curved lid)."""
    bpy.ops.mesh.primitive_cylinder_add(vertices=24, radius=radius, depth=length, location=(x, 0, 0.5), rotation=(0, math.radians(90), 0))
    obj = bpy.context.object
    obj.name = name
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=False)
    bm = bmesh.new(); bm.from_mesh(obj.data)
    cut = bmesh.ops.bisect_plane(bm, geom=bm.verts[:] + bm.edges[:] + bm.faces[:], plane_co=(0, 0, 0), plane_no=(0, 0, 1), clear_inner=True)
    bmesh.ops.holes_fill(bm, edges=bm.edges[:])
    bm.to_mesh(obj.data); bm.free()
    return obj

lid = half_cylinder("Lid", 0.28, 0.9)
assign(shade_smooth(lid), dark)

for x in (-0.33, 0.33):
    bpy.ops.mesh.primitive_cube_add(size=1, location=(x, 0, 0.25))
    band = bpy.context.object; band.name = "Band"; band.scale = (0.07, 0.58, 0.52)
    assign(band, gold)
    arc = half_cylinder("Lid band", 0.295, 0.07, x)
    assign(shade_smooth(arc), gold)

bpy.ops.mesh.primitive_cube_add(size=1, location=(0, -0.29, 0.47))
lock = bpy.context.object; lock.name = "Lock"; lock.scale = (0.12, 0.04, 0.16)
mod = lock.modifiers.new("Bevel", "BEVEL"); mod.width = 0.01
assign(lock, gold)
