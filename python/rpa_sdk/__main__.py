"""Private subprocess entrypoint; invoked by the RPA script bridge."""

import runpy
import sys
import traceback

from . import _send, rpa

try:
    runpy.run_path(sys.argv[1], run_name="__main__")
    _send(dict(kind="result", result=rpa._result))
except BaseException:
    _send(dict(kind="error", error=traceback.format_exc()))
    sys.exit(1)
