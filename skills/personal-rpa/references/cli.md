# CLI 与结果

所有命令 stdout 只返回一个 `{apiVersion:1,ok,data?,error?}` JSON；业务日志进入 stderr。不要通过 `npm run` 包装后把 npm 提示当作协议内容，安装后直接调用 `rpa-agent`。

退出码：0 为成功（可能有警告），1 为运行失败、人工处理、超时、取消或清理失败，2 为参数、文件、预检、环境或数据目录占用错误。`error.code` 是机器判断依据，`error.message` 用于解释。

```powershell
rpa-agent doctor
rpa-agent actions browser.open
rpa-agent schema
rpa-agent check .\task.ts --variables .\inputs.json
rpa-agent run .\task.ts --variables .\inputs.json --output .\downloads
rpa-agent runs
rpa-agent runs <runId>
rpa-agent logs <runId> --limit 100
rpa-agent logs <runId> --before <返回的before> --limit 100
rpa-agent result <runId>
rpa-agent result <runId> --result-id <日志中的resultId>
```

`run/check` 支持 `--cwd`、`--data`、`--output`、`--headless`、`--python`、`--timeout-ms` 和可重复的 `--dependency`。位置文件及这些路径参数都按调用命令时的 cwd 解析；`--cwd` 只设置业务工作目录和默认数据目录。Python 可执行文件路径建议使用绝对路径。

默认数据目录 `<工作目录>/.rpa/agent`；`--data` 优先于 `RPA_DATA_DIR`。代码入口默认下载到数据目录的 downloads；JSON 保留原下载设置，`--output` 覆盖流程默认下载目录。显式步骤目录及动作路径仍以流程参数为准。

默认总超时 1800000 ms。代码文件同时受单步骤最多 3600000 ms 限制；JSON 各步骤保留各自超时。资源等待也受到调用总超时限制。JSON 保留原有 headless，代码默认有头，`--headless` 选择无头。结束时浏览器统一关闭。

`run` 的 `data` 包含 `run`（最终快照）、`result`（业务结果）、`reason`（人工处理等原始原因）和 `paths`（记录位置）。JSON 结果仅取 outputs 声明且实际产生的变量，代码结果取 `rpa.output()`，未输出则为 null。`result` 可再次读取这些内容，完整变量在 `run.variables`。

`MANUAL_REQUIRED` 表示需要人工处理；`TIMEOUT`、`CANCELLED`、`EXECUTION_FAILED`、`CLEANUP_FAILED` 分别表示总超时、取消、执行失败和收尾失败。`DATA_DIR_BUSY` 时等待原运行器退出或选用独立数据目录，不能启动第二个写入者。目录锁只协调本机进程，不支持多台电脑共用网络数据目录。
