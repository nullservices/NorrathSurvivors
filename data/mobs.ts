// Mob roster. Served from /gamedata/mobs.json — see composables/useGameData.ts.

import type { Mob } from '~/types/game'

type GeneratedMob = Mob & {
  bodyType?: number
  rareSpawn?: boolean
  resists?: { mr: number; cr: number; dr: number; fr: number; pr: number; corrup: number }
}

export const MOBS: Mob[] = []
export const MOB_BY_ID: Record<string, Mob> = Object.create(null)

export function setMobs(raw: GeneratedMob[]): void {
  MOBS.length = 0
  MOBS.push(...raw)
  for (const k of Object.keys(MOB_BY_ID)) delete MOB_BY_ID[k]
  for (const mob of MOBS) MOB_BY_ID[mob.id] = mob
}
