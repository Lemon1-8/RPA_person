"""Synchronous JSON RPC SDK for trusted local RPA scripts."""

import json
import os
import sys
import threading

_protocol_output = sys.stdout
_protocol_input = sys.stdin
_token = os.environ.get("RPA_RPC_TOKEN", "")

# print() and library output go to the script log, independently of RPC messages.
sys.stdout = sys.stderr


def _send(message):
    payload = json.dumps(dict(token=_token, **message), ensure_ascii=False, allow_nan=False)
    _protocol_output.write(payload + "\n")
    _protocol_output.flush()


class RpaClient:
    def __init__(self):
        self._sequence = 0
        self._lock = threading.Lock()
        self._result = None

    def call(self, method, params=None):
        if not isinstance(method, str) or not method:
            raise TypeError("RPC method must be a non-empty string")
        if params is None:
            params = {}
        if not isinstance(params, dict):
            raise TypeError("RPC params must be a JSON object")
        with self._lock:
            self._sequence += 1
            request_id = self._sequence
            _send(dict(kind="request", id=request_id, method=method, params=params))
            while True:
                line = _protocol_input.readline()
                if not line:
                    raise RuntimeError("RPA engine disconnected")
                response = json.loads(line)
                if response.get("token") != _token or response.get("id") != request_id:
                    continue
                if "error" in response:
                    raise RuntimeError(response["error"])
                return response.get("result")

    def get(self, name):
        return self.call("variables.get", dict(name=name))

    def set(self, name, value):
        return self.call("variables.set", dict(name=name, value=value))

    def output(self, value):
        # Validate immediately so script authors receive a useful traceback.
        json.dumps(value, allow_nan=False)
        self._result = value


rpa = RpaClient()

__all__ = ["rpa", "RpaClient"]
