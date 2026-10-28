#!/usr/bin/env python3
# Test stand-in for the `blender` command, built on the bpy module from PyPI
# (pip install bpy). Accepts the same arguments Gamesmith passes:
#   -b --factory-startup --python-exit-code N --python runner.py -- args...
import runpy, sys
argv = sys.argv[1:]
if "--version" in argv:
    import bpy
    print(f"Blender {bpy.app.version_string}")
    sys.exit(0)
script = argv[argv.index("--python") + 1]
rest = argv[argv.index("--"):] if "--" in argv else []
sys.argv = ["blender"] + rest
runpy.run_path(script, run_name="__main__")
