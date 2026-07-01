import { describe, expect, it } from 'vitest'
import { extractText } from './scraper'

describe('extractText', () => {
  it('extracts visible prose and strips scripts, nav and footer boilerplate', () => {
    const html = `<html><head><style>.x{color:red}</style></head><body>
      <nav>trang chủ | liên hệ</nav>
      <article><h1>Trồng dâu</h1><p>Dâu ưa khí hậu mát.</p><script>track()</script></article>
      <footer>bản quyền</footer>
    </body></html>`
    const text = extractText(html)
    expect(text).toContain('Trồng dâu')
    expect(text).toContain('Dâu ưa khí hậu mát')
    expect(text).not.toContain('track')
    expect(text).not.toContain('liên hệ')
    expect(text).not.toContain('bản quyền')
  })

  it('separates adjacent block elements with whitespace', () => {
    expect(extractText('<body><h1>Tiêu đề</h1><p>Nội dung</p></body>')).toBe('Tiêu đề Nội dung')
  })

  it('honors a content selector, excluding ads outside it', () => {
    const html = '<body><div class="ad">quảng cáo</div><main>Nội dung chính</main></body>'
    const text = extractText(html, 'main')
    expect(text).toBe('Nội dung chính')
    expect(text).not.toContain('quảng cáo')
  })
})
