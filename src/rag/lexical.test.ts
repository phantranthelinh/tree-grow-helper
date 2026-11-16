import { describe, expect, it } from 'vitest'
import { Bm25Index, tokenize } from './lexical'

describe('tokenize', () => {
  it('lowercases, keeps Vietnamese diacritics and splits on punctuation', () => {
    expect(tokenize('Bệnh MỐC XÁM, thối quả!')).toEqual(['bệnh', 'mốc', 'xám', 'thối', 'quả'])
  })

  it('treats NFD and NFC spellings of the same word as one token', () => {
    expect(tokenize('mốc'.normalize('NFD'))).toEqual(tokenize('mốc'.normalize('NFC')))
  })

  it('keeps numbers as tokens', () => {
    expect(tokenize('độ ẩm 75-80%')).toEqual(['độ', 'ẩm', '75', '80'])
  })
})

describe('Bm25Index', () => {
  const docs = [
    'dâu tây cần tưới nước đều, giữ độ ẩm đất ổn định',
    'bệnh mốc xám botrytis gây thối quả dâu tây',
    'dâu tây ưa khí hậu mát, nhiệt độ ban ngày 20 độ',
  ]

  it('scores 0 for every document that shares no query term', () => {
    expect(new Bm25Index(docs).scores('phân bón kali')).toEqual([0, 0, 0])
  })

  it('ranks the document holding the rare query term first', () => {
    const scores = new Bm25Index(docs).scores('dâu tây bị botrytis')
    const best = scores.indexOf(Math.max(...scores))
    expect(best).toBe(1)
  })

  it('weights a rare term above a term present in every document', () => {
    const idx = new Bm25Index(docs)
    const [common] = idx.scores('dâu')
    const [rare] = idx.scores('tưới')
    expect(rare).toBeGreaterThan(common as number)
  })

  it('handles an empty corpus', () => {
    expect(new Bm25Index([]).scores('dâu')).toEqual([])
  })
})
