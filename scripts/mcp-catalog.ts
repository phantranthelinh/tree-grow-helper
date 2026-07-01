/**
 * Helper: connect to the plant-tree MCP and print its tool catalog with safety
 * classification. Run: npm run mcp:catalog
 * Requires the MCP running in streamable-http mode at MCP_URL.
 */
import { config } from '../src/config'
import { PlantMcpClient } from '../src/mcp/client'
import { classifyTool } from '../src/mcp/policy'

async function main(): Promise<void> {
  const mcp = new PlantMcpClient(config.mcp.url)
  console.log(`Connecting to MCP at ${config.mcp.url} ...`)
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
