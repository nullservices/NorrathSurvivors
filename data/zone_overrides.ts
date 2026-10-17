// Runtime patches and additions for the projected zone data.
//
// Some EQEmu rows ship with sketchy `min_level` values (Felwithe at 36,
// Oggok at 27, etc.) that filter starter cities out of the travel list
// for low-level players. We zero those out so anyone can walk into them.
//
// Other classic starter cities are missing entirely (Kaladim, Kelethin,
// Cabilis, Freeport) — likely filtered by the projector. Stub them in
// here as empty city zones so the travel UI can list them and the player
// can at least visit a vendor. No combat camps; isCombatZone: false.

import type { Camp, Zone } from '~/types/game'

/** zoneId → partial Zone to merge in at load time. */
export const ZONE_PATCHES: Record<string, Partial<Zone>> = {
  // Wrong-level-requirement starter cities.
  oggok:     { levelRequirement: 0 },
  grobb:     { levelRequirement: 0 },
  halas:     { levelRequirement: 0 },
  rivervale: { levelRequirement: 0 },
  felwithea: { levelRequirement: 0 },
  felwitheb: { levelRequirement: 0 },
  qeynos:    { levelRequirement: 0 },
  qeynos2:   { levelRequirement: 0 },
  akanon:    { levelRequirement: 0 },
  erudnext:  { levelRequirement: 0 },
  erudnint:  { levelRequirement: 0 },
  neriaka:   { levelRequirement: 0 },
  neriakb:   { levelRequirement: 0 },
  neriakc:   { levelRequirement: 0 },
}

/** Stubs for starter cities the projector dropped. */
export const ZONE_ADDITIONS: Zone[] = [
  {
    id: 'kaladim',
    name: 'Kaladim',
    continent: 'Faydwer',
    levelRange: [0, 0],
    zem: 1,
    levelRequirement: 0,
    description: 'The mountainside dwarven city, carved deep into the cliffs of Butcherblock.',
    isCombatZone: false,
    camps: [],
  },
  {
    id: 'kelethin',
    name: 'Kelethin',
    continent: 'Faydwer',
    levelRange: [0, 0],
    zem: 1,
    levelRequirement: 0,
    description: 'The wood elf treetop city above the Greater Faydark.',
    isCombatZone: false,
    camps: [],
  },
  {
    id: 'cabilis',
    name: 'Cabilis',
    continent: 'Kunark',
    levelRange: [0, 0],
    zem: 1,
    levelRequirement: 0,
    description: 'The ancient iksar capital in the southern wastes of Kunark.',
    isCombatZone: false,
    camps: [],
  },
  {
    id: 'freeporte',
    name: 'East Freeport',
    continent: 'Antonica',
    levelRange: [0, 0],
    zem: 1,
    levelRequirement: 0,
    description: 'The trade-and-thieves quarter of Freeport.',
    isCombatZone: false,
    camps: [],
  },
  {
    id: 'freeportw',
    name: 'West Freeport',
    continent: 'Antonica',
    levelRange: [0, 0],
    zem: 1,
    levelRequirement: 0,
    description: 'The merchant district and Academy of Arcane Sciences.',
    isCombatZone: false,
    camps: [],
  },
  {
    id: 'freeportn',
    name: 'North Freeport',
    continent: 'Antonica',
    levelRange: [0, 0],
    zem: 1,
    levelRequirement: 0,
    description: 'Freeport’s residential district, home to its temples and militia hall.',
    isCombatZone: false,
    camps: [],
  },
]

/**
 * Endgame named-mob "lair" camps appended to existing zones. The EQEmu
 * projector grouped trash mobs into camps but didn't carve out dedicated
 * spots for the iconic raid targets (Lady Vox, Lord Nagafen, Trakanon,
 * etc.). Several epic-quest steps reference these specific mobs, so the
 * player needs a camp slot to travel to and farm them at.
 *
 * Each lair is a single-mob camp with the named on a 100% spawn chance
 * and a long respawn (30 min for raid bosses, 10 min for the lesser
 * names). `difficultyModifier` of 1.5 scales HP up to make them feel
 * like the encounter they should be — these aren't trash.
 */
function lairCamp(opts: {
  id: string
  name: string
  mobId: string
  respawnSec?: number
  difficulty?: number
}): Camp {
  const mobs = [{ mobId: opts.mobId, weight: 1 }]
  return {
    id: opts.id,
    name: opts.name,
    spawnTimerSec: opts.respawnSec ?? 1800,
    difficultyModifier: opts.difficulty ?? 1.5,
    mobs,
    namedMob: [{ mobId: opts.mobId, spawnChance: 1.0 }],
    isRaidLair: true,
  }
}

export const ZONE_CAMP_ADDITIONS: Record<string, Camp[]> = {
  permafrost: [
    lairCamp({ id: 'permafrost__vox', name: "Lady Vox's Lair", mobId: '73057' }),
  ],
  soldungb: [
    lairCamp({ id: 'soldungb__naggy', name: "Lord Nagafen's Lair", mobId: '32040' }),
    lairCamp({ id: 'soldungb__tranix', name: "King Tranix's Chamber", mobId: '32022', respawnSec: 600, difficulty: 1.3 }),
  ],
  blackburrow: [
    lairCamp({ id: 'blackburrow__bergurgle', name: "Lord Bergurgle's Court", mobId: '51143', respawnSec: 600, difficulty: 1.3 }),
  ],
  steamfont: [
    lairCamp({ id: 'steamfont__pyzjn', name: "Pyzjn's Roost", mobId: '4147', respawnSec: 600, difficulty: 1.2 }),
  ],
  sebilis: [
    lairCamp({ id: 'sebilis__trakanon', name: "Trakanon's Sanctum", mobId: '89154', difficulty: 2.0 }),
  ],
  charasis: [
    lairCamp({ id: 'charsis__drusella', name: "Drusella Sathir's Chamber", mobId: '105153' }),
  ],
  dreadlands: [
    lairCamp({ id: 'dreadlands__gorenaire', name: "Gorenaire's Flight", mobId: '86014' }),
  ],
  emeraldjungle: [
    lairCamp({ id: 'emeraldjungle__severilous', name: "Severilous's Grove", mobId: '94009' }),
  ],
  skyfire: [
    lairCamp({ id: 'skyfire__talendor', name: "Talendor's Peak", mobId: '91093' }),
  ],
  timorous: [
    lairCamp({ id: 'timorous__faydedar', name: "Faydedar's Cove", mobId: '96089' }),
  ],
  wakening: [
    lairCamp({ id: 'wakening__wuoshi', name: "Wuoshi's Glade", mobId: '119112' }),
  ],
  kael: [
    lairCamp({ id: 'kael__rallos', name: "The Statue of Rallos Zek", mobId: '113071' }),
  ],
}

/**
 * Stub vendors for the six city zones the projector dropped (Freeport ×3,
 * Kaladim, Kelethin, Cabilis). Each reuses the merchant_id of an existing
 * sibling-city merchant so their wares are populated from real data; the
 * stub names are deliberately generic ("Shopkeeper", "Merchant") so they
 * also pick up the bag inventory injection in data/vendors.ts.
 *
 * The npc id field is namespaced into the 900000+ range to avoid colliding
 * with real EQEmu npc_types ids.
 */
