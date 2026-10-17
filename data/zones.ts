// Zone catalog. Served from /gamedata/zones.json — see composables/useGameData.ts.

import type { Zone } from '~/types/game'
import { MOB_BY_ID } from '~/data/mobs'
import { ZONE_ADDITIONS, ZONE_CAMP_ADDITIONS, ZONE_PATCHES } from '~/data/zone_overrides'

/** Generated zones carry the same shape as Zone plus a `zoneIdNumber`. */
type GeneratedZone = Zone & { zoneIdNumber: number }

export const ZONES: Zone[] = []
export const ZONE_BY_ID: Record<string, Zone> = Object.create(null)
/** Reverse lookup: EQ's numeric zoneidnumber (used by start_zones, etc.) → our string id. */
export const ZONE_ID_BY_NUMBER: Record<number, string> = Object.create(null)

/**
 * EQEmu has a couple of internal-only npc_types rows literally named "Timer"
 * that drive scripting hooks; the spawn projector picked them up as named
 * mobs and turned them into single-mob camps. Filter them out so the
 * travel UI doesn't show ghost camps.
 */
function isFakeTimerCamp(camp: Zone['camps'][number]): boolean {
  if (camp.mobs.length === 0) return false
  return camp.mobs.every((m) => MOB_BY_ID[m.mobId]?.name === 'Timer')
}

/**
 * Backwards-compat: Camp.namedMob used to be a single optional object.
 * It's now an optional array (NamedSpawn[]) so a camp can host multiple
 * possible rare spawns. Legacy 1-object form, hand-authored
 * zone_overrides single-object form, and pre-migration zones.json files
 * all flow through this normaliser.
 */
function normaliseNamedMob(camp: Zone['camps'][number]): Zone['camps'][number] {
  const raw = camp.namedMob as unknown
  if (raw == null) return camp
  if (Array.isArray(raw)) return camp
  // Single object — wrap in a one-element array.
  return { ...camp, namedMob: [raw as { mobId: string; spawnChance: number }] }
}

export function setZones(raw: GeneratedZone[]): void {
  ZONES.length = 0
  for (const z of raw) {
    const { zoneIdNumber: _z, ...zone } = z
    // Drop the EQEmu "Timer" hook camps, then append any extra camps we
    // hand-authored for endgame named mobs (Vox, Nagafen, Trakanon, …).
    // The projector's per-zone groupings don't include dedicated raid
    // lairs, so we splice them in here.
    const baseCamps = zone.camps.filter((c) => !isFakeTimerCamp(c)).map(normaliseNamedMob)
    const extraCamps = (ZONE_CAMP_ADDITIONS[zone.id] ?? []).map(normaliseNamedMob)
    const filtered = { ...zone, camps: [...baseCamps, ...extraCamps] }
    // Apply any per-zone patches (level requirement overrides, etc.).
    const patch = ZONE_PATCHES[filtered.id]
    ZONES.push(patch ? { ...filtered, ...patch } : filtered)
  }
  // Splice in the city zones that the projector dropped.
  for (const extra of ZONE_ADDITIONS) {
    if (!ZONES.some((z) => z.id === extra.id)) ZONES.push(extra)
  }
  for (const k of Object.keys(ZONE_BY_ID)) delete ZONE_BY_ID[k]
  for (const z of ZONES) ZONE_BY_ID[z.id] = z
  for (const k of Object.keys(ZONE_ID_BY_NUMBER)) delete ZONE_ID_BY_NUMBER[Number(k)]
  for (const z of raw) ZONE_ID_BY_NUMBER[z.zoneIdNumber] = z.id
}

/**
 * Pick the camp a new visitor should default to. Sorts by the *minimum* mob
 * level in the camp (low end of the bracket) so travelers don't get dropped
 * into a high-level camp by accident. Returns the camp id or null when the
 * zone has no camps.
 */
export function pickEntryCamp(zone: Zone): string | null {
  if (zone.camps.length === 0) return null
  const ranked = zone.camps.map((c) => {
    let lo = Infinity
    let sum = 0
    let n = 0
    for (const m of c.mobs) {
      const mob = MOB_BY_ID[m.mobId]
      if (!mob) continue
      if (mob.level < lo) lo = mob.level
      sum += mob.level
      n++
    }
    return {
      camp: c,
      lo: lo === Infinity ? 999 : lo,
      avg: n > 0 ? sum / n : 999,
    }
  }).sort((a, b) => a.lo - b.lo || a.avg - b.avg)
  return ranked[0]?.camp.id ?? zone.camps[0]?.id ?? null
}
