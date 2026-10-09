"""粘贴到 Python 脚本指令；先捕获并保存搜索框、查询按钮和结果。"""
from rpa_sdk import rpa

input_element = rpa.call("windows.find", {"selector": "@搜索框"})
rpa.call("windows.fill", {"element": input_element["element"], "value": "订单编号"})
rpa.call("windows.click", {"selector": "@查询按钮"})
rpa.call("windows.wait", {"selector": "@结果", "state": "visible"})
rpa.output(rpa.call("windows.text", {"selector": "@结果"}))
