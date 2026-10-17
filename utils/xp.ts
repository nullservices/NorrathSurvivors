// XP curve helpers. GDD §10 calls out "hell levels" at 30/35/40/45/51-60;
// they're parameterised here even though Phase 1 doesn't reach them.

const HELL_LEVELS = new Set([30, 35, 40, 45, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60])

/**
 * XP required to advance from `level` to `level + 1`. Tuned upward from
 * the original curve (80 · L^1.6) — players were finishing a level in a
 * handful of kills. 120 · L^1.85 puts blue-con kills at ~3–5% of a level
 * once the kill-side multiplier (see combat store) is also factored in.
 */
export function xpRequired(level: number): number {
  if (level < 1) return 0
  const base = 120 * Math.pow(level, 1.85)
  const hell = HELL_LEVELS.has(level) ? 2.2 : 1
  return Math.floor(base * hell)
}

export type ConColor = 'green' | 'light_blue' | 'blue' | 'white' | 'yellow' | 'red'

/**
 * Per-player-level thresholds that decide where the green/light-blue cutoffs
 * land. Values are the maximum `mobLevel - playerLevel` diff (negative) that
 * still falls into each band. Light-blue is intentionally absent below L8 —
 * EQEmu only introduces it at L8+.
 *
 * Mirrors mob.cpp `GetLevelCon` from EQEmu / Project1999.
 */
function greenThreshold(L: number): number {
  if (L <= 7) return -4
  if (L <= 8) return -5
  if (L <= 11) return -6
  if (L <= 14) return -7
  if (L <= 16) return -8
  if (L <= 20) return -9
  if (L <= 24) return -11
  if (L <= 28) return -12
  if (L <= 30) return -13
  if (L <= 34) return -14
  if (L <= 38) return -16
  if (L <= 44) return -17
  if (L <= 50) return -18
  return -21
}

function lightBlueThreshold(L: number): number | null {
  if (L <= 7) return null
  if (L <= 8) return -4
  if (L <= 11) return -4
  if (L <= 14) return -5
  if (L <= 16) return -6
  if (L <= 20) return -6
  if (L <= 24) return -7
  if (L <= 28) return -8
  if (L <= 30) return -9
  if (L <= 34) return -10
  if (L <= 38) return -11
  if (L <= 44) return -12
  if (L <= 50) return -13
  return -14
}

/** P99/EQEmu-accurate CON color for a mob given the player's level. */
export function conColor(playerLevel: number, mobLevel: number): ConColor {
  if (!playerLevel || !mobLevel) return 'red'
  const diff = mobLevel - playerLevel
  if (diff === 0) return 'white'
  if (diff === 1 || diff === 2) return 'yellow'
  if (diff >= 3) return 'red'
  // diff <= -1
  const greenT = greenThreshold(playerLevel)
  if (diff <= greenT) return 'green'
  const lbT = lightBlueThreshold(playerLevel)
  if (lbT !== null && diff <= lbT) return 'light_blue'
  return 'blue'
}

/**
 * XP multiplier per CON color. Classic EQ: green gives nothing, light-blue
 * is reduced, even/blue is full, yellow & red carry the upside that incents
 * fighting up. Tunable separately from the color thresholds.
 */
export function conMultiplier(color: ConColor): number {
  switch (color) {
    case 'green':      return 0
    case 'light_blue': return 0.5
    case 'blue':       return 1.0
    case 'white':      return 1.0
    case 'yellow':     return 1.25
    case 'red':        return 1.5
  }
}

/** Back-compat shim used by combat store. Returns both color and multiplier. */
export function conColorMultiplier(playerLevel: number, mobLevel: number): {
  color: ConColor
  mult: number
} {
  const color = conColor(playerLevel, mobLevel)
  return { color, mult: conMultiplier(color) }
}

/** Player level cap. AA earning + over-cap-mob guards both key off this. */
export const MAX_PLAYER_LEVEL = 60

/**
 * Mobs that are too far above the player's level cap shouldn't reward XP.
 * 585 mobs in the catalog are L61–L65 (post-classic content), and red-con
 * (×1.5) on top of mastery + ZEM made L65 mobs the absolute best AA farm
 * for a capped L60 — including AFK via the offline path. We treat any mob
 * more than 3 levels above the *cap* (i.e. > L63 against L60) as outside
 * the intended progression curve and zero out the XP. Players can still
 * fight them; they just don't farm AAs off of them.
 */
export function isOverCapMob(playerLevel: number, mobLevel: number): boolean {
  return playerLevel >= MAX_PLAYER_LEVEL && mobLevel > MAX_PLAYER_LEVEL + 3
}

/** UI helpers — Tailwind classes + display labels keyed by CON color. */
export const CON_DISPLAY: Record<ConColor, { text: string; color: string }> = {
  green:      { text: 'Green',      color: 'text-rune-life' },
  light_blue: { text: 'Light Blue', color: 'text-rune-frost/70' },
  blue:       { text: 'Blue',       color: 'text-rune-frost' },
  white:      { text: 'Even',       color: 'text-parchment-100' },
  yellow:     { text: 'Yellow',     color: 'text-rune-gold' },
  red:        { text: 'Red',        color: 'text-rune-blood' },
}
