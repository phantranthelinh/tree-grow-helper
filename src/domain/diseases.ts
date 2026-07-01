import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'

/** Conditions that favour a disease; used to weight diagnosis against live sensors. */
const FavorableConditionsSchema = z
  .object({
    humidity: z.number().nullable().default(null),
    temperature: z.number().nullable().default(null),
    note: z.string().nullable().default(null),
  })
  .default({})

/**
 * One structured disease/pest entry. Unlike the profile's free-text `diseases`
 * field, this is symptom-indexed so the model can match a described symptom to a
 * candidate and cross-check `favorable_conditions` against sensor readings.
 */
export const DiseaseSchema = z.object({
  id: z.string(),
  name_vi: z.string(),
  name_sci: z.string().nullable().default(null),
  type: z.enum(['nấm', 'vi khuẩn', 'virus', 'sâu hại', 'sinh lý', 'khác']),
  symptoms: z.array(z.string()).min(1),
  affected_parts: z.array(z.string()).default([]),
  favorable_conditions: FavorableConditionsSchema,
  treatment: z.string(),
  prevention: z.string(),
  severity: z.enum(['thấp', 'trung bình', 'cao']),
  sources: z.array(z.string()).default([]),
})

export const DiseaseKbSchema = z.object({
  plant: z.string(),
  diseases: z.array(DiseaseSchema).default([]),
  notes: z.string().nullable().default(null),
})

export type Disease = z.infer<typeof DiseaseSchema>
export type DiseaseKb = z.infer<typeof DiseaseKbSchema>

const here = dirname(fileURLToPath(import.meta.url))
const knowledgeDir = join(here, 'knowledge')

/** Load + validate the disease KB from src/domain/knowledge/<plant>-diseases.json. */
export function loadDiseases(plant: string): Disease[] {
  const path = join(knowledgeDir, `${plant}-diseases.json`)
  const raw = readFileSync(path, 'utf8')
  return DiseaseKbSchema.parse(JSON.parse(raw)).diseases
}

/** Render a disease as a symptom-first text blob for embedding + retrieval. */
export function diseaseToText(d: Disease): string {
  const parts = [
    `[bệnh] ${d.name_vi}${d.name_sci ? ` (${d.name_sci})` : ''} — loại: ${d.type}; mức độ: ${d.severity}.`,
    `Triệu chứng: ${d.symptoms.join('; ')}.`,
  ]
  if (d.affected_parts.length > 0) parts.push(`Bộ phận ảnh hưởng: ${d.affected_parts.join(', ')}.`)
  if (d.favorable_conditions.note) parts.push(`Điều kiện phát sinh: ${d.favorable_conditions.note}.`)
  parts.push(`Xử lý: ${d.treatment}`)
  parts.push(`Phòng ngừa: ${d.prevention}`)
  return parts.join(' ')
}
