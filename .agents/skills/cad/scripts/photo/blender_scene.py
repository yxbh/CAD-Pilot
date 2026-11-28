"""Runs inside Blender (``blender --background --python blender_scene.py -- scene.json``): builds a
small photo studio round the staged parts and path traces it. ``cli.stage`` writes scene.json and
the part meshes it names; lengths there are millimetres, and metres here."""

import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

MM = 0.001
LENS_MM, SENSOR_MM = 70.0, 36.0
# A bead's side is an arc of this radius, as a share of the layer height, cut off at ARC of the way to
# the groove (at 1 the side would end vertical): the bead stands about 0.165 of a layer out of its grooves.
GROOVE_SHARE, ARC = 0.25, 0.94
MINIMUM_BLENDER = (4, 2)
# The f-stop at this camera distance; it scales with the distance, so a small part is as sharp front to back as a large set.
F_STOP, F_STOP_DISTANCE = 11.0, 2.5
# Satin: PETG and PLA prints photograph with a soft, wide highlight, not a mirror-like one.
ROUGHNESS, ROUGHNESS_SPREAD = 0.42, 0.08
# The darkest a layer's colour comes out against the lightest.
SHADE_LOW = 0.93
SMOOTH_ANGLE = math.radians(28)


def linear(hex_colour):
    """An #RRGGBB colour as the linear RGB a shader works in."""
    values = [int(hex_colour[i : i + 2], 16) / 255 for i in (1, 3, 5)]
    return [v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4 for v in values]


def printed_material(name, colour, direction, layer):
    """Plastic whose surface is the stack of extruded beads an FDM print is: every ``layer`` metres
    along ``direction`` (a unit vector in the scene) the surface bulges out as a rounded bead and dips
    into the groove before the next one.

    The bead's slope is worked out exactly at each point a camera ray lands on and the surface normal
    is tilted by it, so the many rays through one pixel each see the right part of a bead: close up
    that draws the single lines, and where a layer is finer than a pixel the rays average into the
    stretched sheen a print has. A bump map cannot do this: it measures the slope across a pixel's
    width and turns lines finer than that into false, coarser patterns."""
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes, links = material.node_tree.nodes, material.node_tree.links
    surface = nodes["Principled BSDF"]

    def feed(socket, value):
        if isinstance(value, (int, float, tuple, list)):
            socket.default_value = value
        else:
            links.new(value, socket)

    def maths(operation, first, second=None):
        node = nodes.new("ShaderNodeMath")
        node.operation = operation
        for socket, value in zip(node.inputs, (first, second)):
            if value is not None:
                feed(socket, value)
        return node.outputs[0]

    def vector(operation, first, second=None, scale=None):
        node = nodes.new("ShaderNodeVectorMath")
        node.operation = operation
        feed(node.inputs[0], first)
        if second is not None:
            feed(node.inputs[1], second)
        if scale is not None:
            feed(node.inputs["Scale"], scale)
        return node.outputs["Value" if operation == "DOT_PRODUCT" else "Vector"]

    geometry = nodes.new("ShaderNodeNewGeometry")
    normal = geometry.outputs["Normal"]
    layers = maths("MULTIPLY", vector("DOT_PRODUCT", geometry.outputs["Position"], tuple(direction)), 1.0 / layer)  # height in layers
    per_layer = nodes.new("ShaderNodeTexWhiteNoise")
    per_layer.noise_dimensions = "1D"
    links.new(maths("FLOOR", layers), per_layer.inputs["W"])
    varies = per_layer.outputs["Value"]
    # Across one bead: -1 at the groove below it, 0 at its widest, 1 at the groove above. Its side is an
    # arc, depth * sqrt(1 - u^2) with u = ARC * across, and the slope along ``direction`` is its derivative.
    # No two layers come out alike, so each bead is a little fuller or flatter.
    u = maths("MULTIPLY", maths("SUBTRACT", maths("MULTIPLY", maths("FRACT", layers), 2.0), 1.0), ARC)
    steepness = maths("DIVIDE", maths("MULTIPLY", u, -1.0), maths("SQRT", maths("SUBTRACT", 1.0, maths("MULTIPLY", u, u))))
    fullness = maths("ADD", 0.8, maths("MULTIPLY", varies, 0.4))
    slope = maths("MULTIPLY", maths("MULTIPLY", steepness, fullness), GROOVE_SHARE * ARC * 2.0)
    # Tilt the normal against the part of that slope that lies in the surface.
    gradient = vector("SCALE", tuple(direction), scale=slope)
    across_surface = vector("SUBTRACT", gradient, vector("SCALE", normal, scale=vector("DOT_PRODUCT", gradient, normal)))
    links.new(vector("NORMALIZE", vector("SUBTRACT", normal, across_surface)), surface.inputs["Normal"])
    # Each layer is also a touch glossier or duller and lighter or darker than its neighbours.
    links.new(maths("ADD", ROUGHNESS, maths("MULTIPLY", varies, ROUGHNESS_SPREAD)), surface.inputs["Roughness"])
    shade = maths("ADD", SHADE_LOW, maths("MULTIPLY", varies, 1.0 - SHADE_LOW))
    links.new(vector("SCALE", tuple(linear(colour)), scale=shade), surface.inputs["Base Color"])
    surface.inputs["IOR"].default_value = 1.57
    return material


def add_parts(description, folder):
    """The parts with their materials, and a sample of their points for framing the camera."""
    points = []
    for part in description["parts"]:
        bpy.ops.wm.stl_import(filepath=str(folder / part["mesh"]), global_scale=MM)
        part_object = bpy.context.selected_objects[0]
        part_object.name = part["name"]
        bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
        bpy.ops.object.shade_auto_smooth(angle=SMOOTH_ANGLE)
        part_object.data.materials.append(printed_material(part["name"], part["colour"], part["print_direction"], description["layer_height"] * MM))
        coordinates = np.empty(len(part_object.data.vertices) * 3)
        part_object.data.vertices.foreach_get("co", coordinates)
        points.append(coordinates.reshape(-1, 3))
    return np.concatenate(points)


def add_backdrop(scene, centre, span, away, colour):
    """A matt sheet under the parts that curves up behind them, so the picture has no horizon."""
    across = Vector((away.y, -away.x, 0.0))
    reach, wide, steps = span * 5.0, span * 14.0, 24
    profile = [(-reach * 2.5, 0.0)]
    profile += [(reach + math.sin(a) * reach * 0.6, (1 - math.cos(a)) * reach * 0.6) for a in (i / (steps - 1) * math.pi / 2 for i in range(steps))]
    profile.append((reach * 1.6, reach * 8))
    vertices = [tuple(Vector((centre.x, centre.y, 0.0)) + away * along + across * side + Vector((0, 0, up))) for along, up in profile for side in (-wide, wide)]
    faces = [(2 * i, 2 * i + 1, 2 * i + 3, 2 * i + 2) for i in range(len(profile) - 1)]
    sheet = bpy.data.meshes.new("backdrop")
    sheet.from_pydata(vertices, [], faces)
    for polygon in sheet.polygons:
        polygon.use_smooth = True
    if sum(polygon.normal.z for polygon in sheet.polygons) < 0:
        sheet.flip_normals()
    paper = bpy.data.materials.new("backdrop")
    paper.use_nodes = True
    surface = paper.node_tree.nodes["Principled BSDF"]
    surface.inputs["Base Color"].default_value = (*linear(colour), 1.0)
    surface.inputs["Roughness"].default_value = 0.85
    sheet.materials.append(paper)
    scene.collection.objects.link(bpy.data.objects.new("backdrop", sheet))


def add_camera(scene, points, target, toward_camera, fill, width, height):
    """A camera looking at ``target`` from ``toward_camera``, backed off until the parts take ``fill``
    of the picture's height (and no more than its width allows). Returns the camera's sideways and
    upward directions."""
    lens = bpy.data.cameras.new("camera")
    lens.lens, lens.sensor_width = LENS_MM, SENSOR_MM
    half_width = math.atan(SENSOR_MM / 2 / LENS_MM)
    half_height = math.atan(SENSOR_MM * height / width / 2 / LENS_MM)
    right = Vector((0, 0, 1)).cross(toward_camera).normalized()
    upward = toward_camera.cross(right).normalized()
    offsets = points - np.array(target)
    nearer = offsets @ np.array(toward_camera)
    distance = float(
        max(
            (np.abs(offsets @ np.array(right)) / math.tan(half_width) / min(0.92, fill * 1.12) + nearer).max(),
            (np.abs(offsets @ np.array(upward)) / math.tan(half_height) / fill + nearer).max(),
        )
    )
    camera = bpy.data.objects.new("camera", lens)
    camera.location = target + toward_camera * distance
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    lens.clip_start, lens.clip_end = 0.01, 100
    lens.dof.use_dof, lens.dof.focus_distance, lens.dof.aperture_fstop = True, distance, F_STOP * F_STOP_DISTANCE / distance
    scene.collection.objects.link(camera)
    scene.camera = camera
    return right, upward


def add_lights(scene, target, span, toward_camera, right, upward):
    """A large soft key from the upper left, a weak fill from the right and a light from behind, with
    a dim grey room for the shadows."""

    def softbox(name, offset, watts, size, colour=(1.0, 1.0, 1.0)):
        light = bpy.data.lights.new(name, "AREA")
        light.energy, light.size, light.color = watts * span * span, size, colour
        holder = bpy.data.objects.new(name, light)
        holder.location = target + offset
        holder.rotation_euler = (target - holder.location).to_track_quat("-Z", "Y").to_euler()
        scene.collection.objects.link(holder)

    above = Vector((0, 0, 1))
    softbox("key", (right * -0.9 + upward * 0.2 + toward_camera * 0.5 + above) * span * 1.4, 120, span * 1.3, (1.0, 0.97, 0.93))
    softbox("fill", (right * 1.1 + toward_camera * 0.7 + above * 0.45) * span * 1.4, 14, span * 1.6, (0.93, 0.96, 1.0))
    softbox("behind", (toward_camera * -1.0 + right * 0.3 + above * 0.9) * span * 5.0, 330, span * 3.0)
    world = bpy.data.worlds.new("room")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.55, 0.57, 0.60, 1.0)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.12
    scene.world = world


def set_renderer(scene, description):
    scene.render.engine = "CYCLES"
    scene.render.resolution_x, scene.render.resolution_y = description["size"]
    scene.render.resolution_percentage = 100
    scene.cycles.samples = description["samples"]
    scene.cycles.use_adaptive_sampling = True
    scene.cycles.adaptive_threshold = 0.01
    scene.cycles.use_denoising = True
    scene.cycles.device = "CPU"
    preferences = bpy.context.preferences.addons["cycles"].preferences
    for kind in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
        try:
            preferences.compute_device_type = kind
            preferences.get_devices()
        except (TypeError, RuntimeError):
            continue
        graphics = [device for device in preferences.devices if device.type == kind]
        if graphics:
            for device in preferences.devices:
                device.use = True
            scene.cycles.device = "GPU"
            break
    # Khronos PBR Neutral keeps a lit colour its own hue and saturation; Blender's default, AgX, rolls bright
    # colours off towards grey, and lit filament comes out washed.
    scene.view_settings.view_transform = "Khronos PBR Neutral"
    scene.view_settings.look = "None"
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = description["output"]


def main():
    if bpy.app.version < MINIMUM_BLENDER:
        raise SystemExit(f"Error: scripts/photo needs Blender {MINIMUM_BLENDER[0]}.{MINIMUM_BLENDER[1]} or later; this is {bpy.app.version_string}")
    staged = Path(sys.argv[sys.argv.index("--") + 1])
    description = json.loads(staged.read_text(encoding="utf-8"))
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    points = add_parts(description, staged.parent)
    low, high = Vector(points.min(axis=0)), Vector(points.max(axis=0))
    centre, size = (low + high) / 2, high - low
    span = max(size.x, size.y, size.z)
    azimuth, elevation = (math.radians(v) for v in description["view"])
    # Azimuth 0 looks from the front (-Y); the camera rises with the elevation.
    toward_camera = Vector((math.sin(azimuth) * math.cos(elevation), -math.cos(azimuth) * math.cos(elevation), math.sin(elevation)))
    target = Vector((centre.x, centre.y, low.z + size.z * 0.3))
    add_backdrop(scene, centre, span, Vector((-math.sin(azimuth), math.cos(azimuth), 0.0)), description["backdrop"])
    right, upward = add_camera(scene, points, target, toward_camera, description["fill"], *description["size"])
    add_lights(scene, target, span, toward_camera, right, upward)
    set_renderer(scene, description)
    bpy.ops.render.render(write_still=True)
    print("photo written", description["output"])


main()
