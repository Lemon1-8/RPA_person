# 流程 JSON

使用 `rpa-agent schema` 查看 JSON v1 结构，`actions <类型>` 查看参数。基本字段为 schemaVersion、workflowId、name、revision、variables、elements、steps、settings；见 [示例](../assets/workflow.json)。根文件可直接执行，不必先保存到桌面流程库，不修改原文件或增加其 revision。

每个步骤指定 stepId、name、actionType、params，可用 output 保存结果。顶层 outputs 是结果变量名列表。输入文件必须是 JSON 对象，按顶层浅合并覆盖 variables；inputs 是名称声明，不是参数对象，声明的每个输入必须在合并后存在。

读取 XLSX 的输出是 `{sheetName, rows}` 对象；若保存到 book 变量，遍历列表使用 `{{book.rows}}`，不能把整个 book 当作数组。保存 XLSX 返回产物对象并登记到运行记录。

完整 `{{变量}}` 保留 JSON 类型，支持 `{{obj.key}}`、`{{rows}}[0]`；混合文本转换为字符串，不求值 JavaScript 表达式。脚本源码和 filePath 不做模板替换。

`control.if`、`control.forEach`、`control.forEachXlsx`、`control.tryCatch` 通过 children／elseSteps 保存子步骤。输出或条件分支可能尚未产生的值会在 check 中警告。仅 safeToRetry 动作允许自动重试。

脚本步骤可使用 `{language:'javascript',code:'...'}` 或 `{language:'typescript',filePath:'./task.ts'}`，必须二选一。JSON 中 filePath 按所属流程文件目录解析，其他业务动作继续遵循绝对路径要求。

固定修订子流程使用 workflow.call，并重复传入 `--dependency child.json`。只按精确 workflowId@revision 解析；重复键、缺失、循环、深度超限会报错。子流程输入必须与 inputs 声明匹配，返回 outputs 声明的变量。运行会保存根流程与依赖快照，不读取桌面流程库、不猜测相邻文件。
