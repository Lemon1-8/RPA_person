# 浏览器公开边界的红绿记录

日期：2026-09-15，Windows 本地，Playwright 1.63.0 / Chromium 1243，Vitest 5.0.0。

已阅读项目 `tdd/SKILL.md`、`tests.md`、`mocking.md`。测试边界使用方案授权的真实受控网页、BrowserSession 公共接口和最终下载文件；不检查内部 Map、租约字段或 Playwright 调用次数。

命令：`node node_modules/vitest/vitest.mjs run tests/browser.test.ts`。

| 切片 | 红灯证据 | 绿灯证据 |
| --- | --- | --- |
| 订单查询及表格采集 | 16:47:27：BrowserSession 模块不存在 | 16:49:35：1/1 通过，页面实际产生 Alice 的两条固定订单 |
| 双浏览器隔离和跨进程配置租约 | 16:50:06：同配置目录的第二次 start 意外成功，断言 `promise resolved instead of rejecting` | 16:50:32：2/2 通过；不同浏览器查询结果分离，重复租约拒绝，失败实例 close 不破坏活跃租约，跨 Node 进程返回 PROFILE_IN_USE，释放后重启成功 |
| 跨域嵌套 iframe 与脚本共享页面 | 16:50:59：element 引用缺失支持，报 selector 必须为非空文本 | 16:51:23：3/3 通过；两层 frame、歧义拒绝、evaluate 传值、原生下拉、等待与表格结果通过 |
| 响应关联 | 16:51:52：未实现 browser.response | 16:52:12：4/4 通过；旧请求已在途且先返回，仍采集本次触发的 requestId=2 |
| 并发同名文件下载 | 16:52:31：未实现 browser.download | 16:52:57：5/5 通过；两个浏览器同时保存 report.csv，文件名分配无覆盖，关闭上下文后内容和实际字节数有效 |
| 有界面窗口后台与恢复 | 16:53:16：browser.show 不受支持 | 16:53:34：6/6 通过；CDP 读回 normal/minimized，同会话输入保持，最小化后查询成功 |
| evaluate 超时禁止晚到副作用 | 16:53:55：超时后的文本读取仍成功，证明会话被错误复用 | 16:54:11：7/7 通过；超时会关闭整会话，后续调用明确拒绝 |

首次实现后曾因为 Chromium 新版本未安装失败；这是环境依赖问题，不作为业务红灯。安装完成后继续逐个切片执行。

最后还执行 `node node_modules/typescript/bin/tsc --noEmit --pretty false`，退出码 0。

未把此测试结果外推为真实拼多多站点兼容性、Windows 前台焦点仲裁、锁屏运行或断电后 DOM 恢复能力。
