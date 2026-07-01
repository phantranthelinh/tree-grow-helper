import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

const Range = z.tuple([z.number(), z.number()])

/**
 * Per-plant knowledge profile. Numeric ranges drive control thresholds and are
 * injected into the prompt; the long text fields are chunked + embedded for RAG.
 */
export const PlantProfileSchema = z.object({
  plant: z.string(),
  scientific_name: z.string().nullable().default(null),
  aliases: z.array(z.string()).default([]),

  // numeric optimal ranges
  temperature_range: Range.nullable().default(null),
  humidity_range: Range.nullable().default(null),
  soil_moisture_range: Range.nullable().default(null),
  light_range: Range.nullable().default(null),
  soil_ph_range: Range.nullable().default(null),
  daily_light_hours: Range.nullable().default(null),
  ec_range: Range.nullable().default(null),

  // text knowledge
  light_description: z.string().nullable().default(null),
  toxicity: z.string().nullable().default(null),
  care_notes: z.string().nullable().default(null),
  fertilizer: z.string().nullable().default(null),
  watering: z.string().nullable().default(null),
  pests: z.string().nullable().default(null),
  diseases: z.string().nullable().default(null),
  growth_stages: z.string().nullable().default(null),
  planting: z.string().nullable().default(null),
  harvest: z.string().nullable().default(null),
  propagation: z.string().nullable().default(null),
  varieties: z.array(z.string()).default([]),

  // metadata
  sources: z.array(z.string()).default([]),
  notes: z.string().nullable().default(null),
})

export type PlantProfile = z.infer<typeof PlantProfileSchema>

const here = dirname(fileURLToPath(import.meta.url))
const knowledgeDir = join(here, 'knowledge')

/** Load + validate a plant profile JSON from src/domain/knowledge/<plant>.json. */
export function loadProfile(plant: string): PlantProfile {
  const path = join(knowledgeDir, `${plant}.json`)
  const raw = readFileSync(path, 'utf8')
  return PlantProfileSchema.parse(JSON.parse(raw))
}

export interface ControlThresholds {
  /** % soil moisture below which we should water (lower bound of optimal range). */
  moistureThreshold: number | null
  /** lux below which we should turn on the grow light (lower bound of optimal range). */
  lightThreshold: number | null
}

/**
 * Derive device-control thresholds from the profile ranges. This is the key
 * reason RAG matters: a strawberry needs 75-80% soil moisture, NOT the MCP
 * default of 30%.
 */
export function deriveControlThresholds(p: PlantProfile): ControlThresholds {
  return {
    moistureThreshold: p.soil_moisture_range ? p.soil_moisture_range[0] : null,
    lightThreshold: p.light_range ? p.light_range[0] : null,
  }
}

/** Compact Vietnamese summary of optimal ranges for the system prompt. */
export function summarizeRanges(p: PlantProfile): string {
  const parts: string[] = []
  const add = (label: string, r: readonly [number, number] | null, unit: string) => {
    if (r) parts.push(`${label} ${r[0]}-${r[1]}${unit}`)
  }
  add('nhiệt độ', p.temperature_range, '°C')
  add('độ ẩm không khí', p.humidity_range, '%')
  add('độ ẩm đất', p.soil_moisture_range, '%')
  add('ánh sáng', p.light_range, ' lux')
  add('pH đất', p.soil_ph_range, '')
  add('giờ chiếu sáng/ngày', p.daily_light_hours, 'h')
  add('EC', p.ec_range, ' mS/cm')
  return parts.join('; ')
}
