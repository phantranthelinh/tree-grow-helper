import { describe, expect, it } from 'vitest'
import { deriveControlThresholds, loadProfile, summarizeRanges } from '../src/domain/profiles'

describe('plant profiles', () => {
  it('loads and validates the strawberry profile', () => {
    const p = loadProfile('strawberry')
    expect(p.plant).toBe('strawberry')
    expect(p.soil_moisture_range).toEqual([75, 80])
    expect(p.light_range).toEqual([200, 800])
    expect(p.pests).toContain('nhện đỏ')
  })

  it('derives control thresholds from the optimal ranges (not MCP defaults)', () => {
    const p = loadProfile('strawberry')
    const t = deriveControlThresholds(p)
    // strawberry needs ~75% soil moisture, far from the MCP default of 30%
    expect(t.moistureThreshold).toBe(75)
    expect(t.lightThreshold).toBe(200)
  })

  it('summarizes ranges in Vietnamese', () => {
    const p = loadProfile('strawberry')
    const s = summarizeRanges(p)
    expect(s).toContain('độ ẩm đất 75-80%')
    expect(s).toContain('ánh sáng 200-800 lux')
  })
})
