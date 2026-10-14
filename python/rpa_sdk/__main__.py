"""Private subprocess entrypoint; invoked by the RPA script bridge."""

import runpy
import sys
import traceback
import os

from . import _send, rpa

try:
    script_path = sys.argv[1]
    if "--file-mode" in sys.argv[2:]:
        sys.path.insert(0, os.path.dirname(os.path.abspath(script_path)))
        sys.argv = [script_path]
    runpy.run_path(script_path, run_name="__main__")
    _send(dict(kind="result", result=rpa._result))
except BaseException:
    _send(dict(kind="error", error=traceback.format_exc()))
    sys.exit(1)
