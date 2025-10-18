# 共享记事本

## 概述
共享记事本是一款基于 Go 与 WebSocket 的实时协作笔记应用。用户通过房间 ID 与密码创建或加入房间，在中文界面中共同编辑一份文本，并可选择倒计时模式，让内容在设定时间后自动销毁。

## 功能
- 通过 WebSocket 实现即时同步，输入会快速广播给所有成员。
- 房间在首次进入时创建，之后使用统一密码重复加入。
- 倒计时房间到期后自动关闭，广播关闭原因并移除所有连接。
- `static/` 目录提供完整前端资源，可由任何 Go HTTP 服务直接托管。

## 快速开始
1. 安装 Go 1.24 或更高版本。
2. 在仓库根目录执行：
   ```sh
   go run .
   ```
   如需修改端口，可使用 `PORT=9090 go run .`。
3. 打开浏览器访问 `http://localhost:8080`（或自定义端口），输入房间 ID 与密码后即可协作编辑。

生成可部署二进制：
```sh
go build -o sharednotebook
```

## API
`POST /api/join` 接收如下 JSON：
```json
{
  "roomId": "notes-2024",
  "password": "secret",
  "mode": "countdown",
  "durationSeconds": 900
}
```
`mode` 默认值为 `"permanent"`。当选择倒计时模式时，`durationSeconds` 必须大于 0。成功响应会返回房间内容、模式、可选的 ISO8601 `expiresAt` 以及 `created` 标记。实时同步通过 `GET /ws?roomId=...&password=...` 建立 WebSocket 连接，消息类型包括 `"content"` 与 `"room_state"`。

## 项目结构
- `main.go` 负责启动 HTTP 服务、注册 REST 接口并托管静态文件。
- `rooms.go`、`client.go`、`ws.go` 实现房间生命周期、客户端收发循环与 WebSocket 升级。
- `static/` 包含前端界面（`index.html`、`app.js`、`styles.css`）。
- `server.log` 示范运行时日志输出。

## 开发说明
- 使用 `go fmt ./...` 对 Go 代码进行格式化与基础检查。
- 执行 `go test ./...` 运行单元测试；修改并发相关逻辑时建议加上 `-race`。
- 更多贡献流程、提交规范与安全注意事项详见 `AGENTS.md`。
