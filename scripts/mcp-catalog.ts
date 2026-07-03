/**
 * Helper: connect to the plant-tree MCP and print its tool catalog with safety
 * classification. Run: npm run mcp:catalog
 * Requires the MCP running in streamable-http mode at MCP_URL.
 */
import { config } from '../src/config'
import { PlantMcpClient } from '../src/mcp/client'
import { classifyTool } from '../src/mcp/policy'
import { loadMcpConfig } from '../src/setup/mcpConfig'

async function main(): Promise<void> {
  const url = loadMcpConfig(config.mcp.configPath)?.url ?? config.mcp.url
  const mcp = new PlantMcpClient(url)
  console.log(`Connecting to MCP at ${url} ...`)
  await mcp.connect()
  const tools = await mcp.listTools()
  console.log(`\n${tools.length} tools:\n`)
  for (const t of tools) {
    console.log(`- [${classifyTool(t.name)}] ${t.name}: ${t.description ?? ''}`)
  }
  await mcp.close()
}

main().catch((err) => {
  console.error('Failed:', err)
  process.exit(1)
})
