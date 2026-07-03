import { exec } from 'node:child_process'
import { config } from './config'
import { buildServer } from './http/server'
import { applyLlmConfig } from './setup/init'
import { loadLlmConfig } from './setup/llmConfig'
import { AppState } from './setup/state'

/** Best-effort open the setup page in the local browser. No-op/ignored in Docker. */
function openBrowser(url: string): void {
  const cmd =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`
  exec(cmd, () => {
    /* headless environments have no browser — swallow the error */
  })
}

async function main(): Promise<void> {
  const state = new AppState()
  const app = buildServer({ state, config })
  await app.listen({ port: config.port, host: '0.0.0.0' })

  const setupUrl = `http://localhost:${config.port}/setup`
  console.log(`[http] AI server listening on http://localhost:${config.port}`)
  console.log(`[setup] mở ${setupUrl} để cấu hình LLM`)

  if (config.setup.openBrowser) openBrowser(setupUrl)

  // Auto-reconnect from a previously saved config; fall back to the UI on failure.
  const saved = loadLlmConfig(config.setup.configPath)
  if (saved) {
    console.log('[setup] tìm thấy cấu hình đã lưu — đang tự kết nối…')
    const res = await applyLlmConfig(saved, state, config)
    if (!res.ok) {
      console.warn(`[setup] cấu hình đã lưu thất bại (${res.code}: ${res.message}) — chờ cấu hình lại tại ${setupUrl}`)
    }
  } else {
    console.log('[setup] chưa có cấu hình — vui lòng cấu hình qua UI.')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
