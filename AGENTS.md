# Repository Guidelines

## Project Structure & Module Organization
The Go backend entry point is `main.go`; request handling logic is split across `client.go`, `rooms.go`, and `ws.go` for WebSocket orchestration. Derived helpers and shared types stay colocated with their feature to keep imports flat. Static assets that drive the browser UI live in `static/` (`index.html`, `app.js`, `styles.css`), and new assets should follow that structure. Runtime artifacts such as `server.log` are ignored by Go tooling; keep large captures out of version control.

## Build, Test, and Development Commands
- `go run .` starts the HTTP/WebSocket server in development, serving `static/` at `/`.
- `go build -o sharednotebook` produces the deployable binary; the output name matches the existing release asset.
- `go test ./...` executes all unit tests once they exist; gate merges on a passing run.
- `GOLOG=debug go run .` enables verbose logging via the standard library when diagnosing rooms.

## Coding Style & Naming Conventions
Format code with `gofmt` (`go fmt ./...`) before committing; the project assumes tab indentation and default Go imports. Prefer descriptive, CamelCase identifiers for exported types and methods, and lowerCamelCase for locals. Keep HTTP endpoints, room modes, and JSON field names in lower-case dashed or camel names that match current handlers. Document tricky concurrency blocks with short comments so future agents understand locking expectations.

## Testing Guidelines
Add `_test.go` files next to the code under test, using `TestXxx` functions from Go’s `testing` package. Focus on room lifecycle scenarios, password validation, and countdown expiry edge cases. New WebSocket behavior should include integration-style tests guarded by build tags if external brokers are required. Target at least basic coverage for new modules and attach `go test ./... -race` output when investigating data races.

## Commit & Pull Request Guidelines
Follow the existing history by writing concise, imperative commit subjects (e.g., `Add collaborative shared notebook app`). Squash fix-ups locally before opening a pull request. PR descriptions should outline scope, mention related issues, and list manual verification steps (`go test ./...`, browser smoke-check). Attach screenshots or console transcripts when the front-end changes, and call out any configuration updates such as new env vars.

## Security & Configuration Tips
Respect the `PORT` environment variable; default fallback is `8080`. Never log room passwords; sanitize debug output before sharing logs. Review third-party script additions under `static/` for licensing and CSP impact prior to merge.
