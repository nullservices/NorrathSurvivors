import type { RaceId } from '~/types/game'

export type Gender = 'male' | 'female'

/** A renderable player rig: the model to load, plus (when the model's own
 *  GLB converted without animations) a donor rig whose clips are retargeted
 *  onto it at load time (utils/clipRetarget.ts). */
export interface PlayerRig {
  code: string
  /** Fully-animated rig with a bone-compatible skeleton. */
  donor?: string
}

/**
 * Player race + gender → legacy 1999 EQ model (public/eq-assets/<code>.glb).
 *
 * Policy (owner preference): always the classic models, never the Luclin
 * `_new` remakes. The classic Kunark iksar (ikm/ikf) is converted locally
 * from global4_chr.s3d — see scripts/wce-to-glb.mjs + tmp/patch-wld.mjs
 * (the Kunark wld needs its missing ff-terminator appended before quail
 * accepts it). ikf converted with a partial clip set, so ikm donates.
 *
 * Many legacy conversions carry zero or partial clips, but the skeletons
 * are bone-compatible across races (verified via tmp/compare-rigs.mjs), so
 * each bare rig names a donor:
 *   elm (43 clips) → all male humanoids · elf (42) → female humanoids
 *   dwm/dwf → gnome + halfling m/f · ogf (36) → troll m/f + male ogre
 * hum/bam keep their native walk clips and take everything else from elm
 * (their native p01 stand is broken — 9 of 51 tracks).
 */
const PLAYER_RIGS: Record<RaceId, { male: PlayerRig; female?: PlayerRig }> = {
  human: { male: { code: 'hum', donor: 'elm' }, female: { code: 'huf', donor: 'elf' } },
  barbarian: { male: { code: 'bam', donor: 'elm' }, female: { code: 'baf', donor: 'elf' } },
  erudite: { male: { code: 'erm', donor: 'elm' }, female: { code: 'erf', donor: 'elf' } },
  wood_elf: { male: { code: 'elm' }, female: { code: 'elf' } },
  high_elf: { male: { code: 'him', donor: 'elm' }, female: { code: 'hif', donor: 'elf' } },
  dark_elf: { male: { code: 'dam', donor: 'elm' }, female: { code: 'daf', donor: 'elf' } },
  half_elf: { male: { code: 'ham', donor: 'elm' }, female: { code: 'haf', donor: 'elf' } },
  dwarf: { male: { code: 'dwm' }, female: { code: 'dwf' } },
  troll: { male: { code: 'trm', donor: 'ogf' }, female: { code: 'trf', donor: 'ogf' } },
  ogre: { male: { code: 'ogm', donor: 'ogf' }, female: { code: 'ogf' } },
  // NOTE: the EQ halfling player model is hom/hof ("hobbit") — hlm/hlf are
  // Halas-citizen NPC models (barbarian-styled), not halflings.
  halfling: { male: { code: 'hom', donor: 'dwm' }, female: { code: 'hof', donor: 'dwf' } },
  gnome: { male: { code: 'gnm', donor: 'dwm' }, female: { code: 'gnf', donor: 'dwf' } },
  iksar: { male: { code: 'ikm' }, female: { code: 'ikf', donor: 'ikm' } },
}

/** Resolve the rig for a race + gender; missing female rigs fall back to
 *  the male model. */
export function playerRig(race: RaceId, gender: Gender = 'male'): PlayerRig {
  const r = PLAYER_RIGS[race] ?? PLAYER_RIGS.human
  return (gender === 'female' && r.female) ? r.female : r.male
}

/** Every race currently has a female rig (huf/baf/erf included); kept so
 *  the creation UI can note a male stand-in if a future race lacks one. */
export function femaleModelAvailable(race: RaceId): boolean {
  return !!PLAYER_RIGS[race]?.female
}

/**
 * Mob rigs that converted with missing or partial clips → bone-compatible
 * donor whose animations are retargeted in at spawn (same mechanism as the
 * player rigs; pairings validated with tmp/compare-rigs.mjs):
 *   frg (froglok, ZERO clips) ← fro 24/24 · kob (kobold, ZERO) ← gnn 21/26
 *   pum/tig (cats, ZERO) ← wol 26/28 (lim shares 29/29 but its own
 *   conversion renders collapsed — wolf clips read correctly)
 *   ghu (ghoul, ZERO) ← elm 22/26 · ske/zom (no attack clips) ← elm 25/26
 *   imp (death only) ← orc 20/24
 *   (imp wings + kob tail/claws have no donor tracks — they hold rest pose)
 */
export const MODEL_CLIP_DONOR: Record<string, string> = {
  frg: 'fro',
  kob: 'gnn',
  pum: 'wol',
  tig: 'wol',
  ghu: 'elm',
  ske: 'elm',
  zom: 'elm',
  imp: 'orc',
}

/**
 * Relative body height vs the 1.8-unit human baseline, so the lineup reads
 * like EQ's (ogres tower, gnomes scurry). Applied by /play's spawn and the
 * creation preview.
 */
export const RACE_SCALE: Record<RaceId, number> = {
  human: 1.0,
  barbarian: 1.15,
  erudite: 1.02,
  wood_elf: 0.95,
  high_elf: 1.0,
  dark_elf: 0.92,
  half_elf: 0.97,
  dwarf: 0.78,
  troll: 1.3,
  ogre: 1.4,
  halfling: 0.7,
  gnome: 0.62,
  iksar: 1.05,
}
