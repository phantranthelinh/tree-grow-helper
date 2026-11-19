interface Block {
  contentStart: number
  contentEnd: number
}

function findBlock(html: string, id: string): Block {
  const idAttr = new RegExp(`\\bid="${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`)
  const found: Block[] = []
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
    if (!idAttr.test(m[1] ?? '')) continue
    const contentStart = (m.index ?? 0) + m[0].length - (m[2] ?? '').length - '</script>'.length
    found.push({ contentStart, contentEnd: contentStart + (m[2] ?? '').length })
  }
  if (found.length !== 1) throw new Error(`expected one <script id="${id}">, found ${found.length}`)
  return found[0] as Block
}

export function extractScriptBlock(html: string, id: string): string {
  const b = findBlock(html, id)
  return html.slice(b.contentStart, b.contentEnd)
}

export function replaceScriptBlock(html: string, id: string, content: string): string {
  const b = findBlock(html, id)
  return html.slice(0, b.contentStart) + content + html.slice(b.contentEnd)
}

/** JSON for an inline `<script type="application/json">`: every `<` is escaped so no value can close the tag. */
export function toJsonBlock(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/</g, '\\u003c')
}
