// Core type definitions for EverIdle.
// Mirrors GDD §23 (Data Schema Overview) and adapts EQ classic mechanics
// into TypeScript-strict shapes the engine and UI both consume.

// ─── Identity ────────────────────────────────────────────────────────────────

export type RaceId =
  | 'human' | 'barbarian' | 'erudite' | 'wood_elf' | 'high_elf' | 'dark_elf'
  | 'half_elf' | 'dwarf' | 'troll' | 'ogre' | 'halfling' | 'gnome' | 'iksar'

export type ClassId =
  | 'warrior' | 'paladin' | 'shadow_knight' | 'monk' | 'rogue' | 'ranger'
  | 'bard' | 'cleric' | 'druid' | 'shaman' | 'wizard' | 'magician'
  | 'necromancer' | 'enchanter'

export type DeityId =
  | 'tunare' | 'mithaniel_marr' | 'erollisi_marr' | 'rodcet_nife' | 'quellious'
  | 'karana' | 'bristlebane' | 'tribunal' | 'prexus' | 'veeshan'
  | 'cazic_thule' | 'innoruuk' | 'rallos_zek' | 'bertoxxulous' | 'solusek_ro'
  | 'agnostic'

export type Role = 'tank' | 'healer' | 'dps' | 'utility' | 'hybrid'
export type ArmorType = 'cloth' | 'leather' | 'chain' | 'plate'
export type ResourceType = 'mana' | 'endurance' | 'songs'
export type Alignment = 'good' | 'neutral' | 'evil' | 'none'
export type Size = 'small' | 'medium' | 'large'

// ─── Stats ───────────────────────────────────────────────────────────────────

export interface StatBlock {
  str: number
  sta: number
  agi: number
  dex: number
  wis: number
  int: number
  cha: number
}

export const ZERO_STATS: Readonly<StatBlock> = Object.freeze({
  str: 0, sta: 0, agi: 0, dex: 0, wis: 0, int: 0, cha: 0,
})

// ─── Static content: Race / Class / Deity ────────────────────────────────────

export interface Race {
  id: RaceId
  name: string
  size: Size
  startingCity: string
  startingZoneId: string
  statBonuses: StatBlock        // applied on top of base class stats
  traits: string[]              // e.g. ['regen', 'forage', 'slam']
  description: string
  classes: ClassId[]            // legal classes for this race
}

export interface CharClass {
  id: ClassId
  name: string
  role: Role
  armor: ArmorType
  resource: ResourceType
  description: string
  baseStats: StatBlock          // pre-race adjustment
  // HP/Mana per level scaling factor (multiplied by STA / INT|WIS)
  hpPerStaPerLevel: number
  manaPerCasterStatPerLevel: number
  casterStat: 'int' | 'wis' | 'none'
  // base HP/Mana at level 1 before stat scaling
  baseHpAtL1: number
  baseManaAtL1: number
  // multiplier vs a baseline level-1 attack of 5 damage
  meleeMultiplier: number
  /**
   * Double / triple attack capabilities. Six classes train Double Attack
   * (Warrior, Paladin, Shadowknight, Ranger, Monk, Rogue); a sub-set
   * gain Triple Attack as an innate at L60 (Warrior, Monk, Ranger).
   *
   *   doubleAttackAt — first level the skill is trainable (and where the
   *                    proc starts firing). Undefined = no double attack.
   *   doubleAttackCap — P99-classic skill cap at L60 (245 Warrior, 250
   *                     Monk, 240 Rogue, 235 Pal/SK/Ranger).
   *   tripleAttack    — true when the class gains the innate at L60.
   *
   * Skill itself is derived from level rather than tracked persistently —
   * see utils/combat.ts `doubleAttackSkill`. (Adding a real, skill-up-able
   * Double Attack score is a follow-up.)
   */
  doubleAttackAt?: number
  doubleAttackCap?: number
  tripleAttack?: boolean
}

export interface Deity {
  id: DeityId
  name: string
  alignment: Alignment
  domains: string[]
  blessing: string
  allowedRaces: RaceId[]        // empty = available to all
  allowedClasses: ClassId[]     // empty = available to all
}

// ─── Items ───────────────────────────────────────────────────────────────────

export type EquipmentSlot =
  | 'head' | 'face' | 'neck' | 'shoulders' | 'arms' | 'back' | 'chest'
  | 'wrist_l' | 'wrist_r' | 'hands' | 'finger_l' | 'finger_r' | 'waist'
  | 'legs' | 'feet' | 'primary' | 'secondary' | 'range' | 'ammo'
  | 'ear_l' | 'ear_r' | 'charm' | 'power'

export type ItemQuality =
  | 'common' | 'uncommon' | 'rare' | 'quest' | 'epic' | 'planar'

export interface ItemBase {
  id: string
  name: string
  quality: ItemQuality
  requiredLevel: number
  requiredClasses?: ClassId[]   // omit/empty = any
  requiredRaces?: RaceId[]      // omit/empty = any
  stats?: Partial<StatBlock>
  hp?: number
  mana?: number
  ac?: number
  lore?: string

  /** Container capacity (EQ "bagslots"). Present only on bag items. */
  bagSize?: number

  // ── EQ-derived metadata (preserved from items.txt) ──
  iconId?: number               // → item_<iconId>.png in the icon repo
  itemtype?: number             // raw EQ itemtype (1H slash, archery, etc.)
  haste?: number                // % haste bonus
  weight?: number               // tenths of a stone (EQ units)
  vendorPrice?: number          // EQ vendor sell price, copper
  /** Fraction of vendorPrice the merchant pays back when buying from you (0..1). */
  sellRate?: number
  nodrop?: boolean
  notransfer?: boolean
  isLore?: boolean              // can only own one
  isMagic?: boolean
  /**
   * EQ augment item. EQEmu marks these with `itemtype: 54` but still
   * ships them with a `slots` bitfield pointing at whatever slot they
   * augment INTO — the projector reads that as chest/etc., which makes
   * augments look like wearable armor. We re-route them at load time
   * to `type: 'material'` so they sit in the pack instead of equipping,
   * and surface them as their own inventory filter bucket. Real augment
   * socketing is still TODO.
   */
  isAugment?: boolean
  deityBitfield?: number        // raw deity restriction bits

  // EQ-additional combat bonuses preserved for the item-details modal
  attack?: number               // ATK bonus
  hpRegen?: number              // HP regen per tick
  manaRegen?: number            // mana regen per tick
  resists?: {                   // saves vs schools
    fr?: number; cr?: number; dr?: number; mr?: number; pr?: number
    svc?: number               // svcorruption
  }
  size?: number                 // 0 Tiny / 1 Small / 2 Medium / 3 Large
}

export interface WeaponItem extends ItemBase {
  type: 'weapon'
  slot: 'primary' | 'secondary' | 'range'
  weaponDamage: number          // base damage per swing
  weaponDelay: number           // seconds between swings (lower = faster)
}

export interface ArmorItem extends ItemBase {
  type: 'armor'
  slot: Exclude<EquipmentSlot, 'primary' | 'secondary' | 'range' | 'ammo'>
}

export interface AccessoryItem extends ItemBase {
  type: 'accessory'
  slot: EquipmentSlot
}

export interface MaterialItem extends ItemBase {
  type: 'material'
  // No slot — these are inventory-only (food, components, ores, herbs, etc).
  // EQ itemtype is preserved on ItemBase so the UI can subcategorise.
}

export type Item = WeaponItem | ArmorItem | AccessoryItem | MaterialItem

// ─── Loot ────────────────────────────────────────────────────────────────────

export interface LootDrop {
  itemId: string
  /** Relative weight within the parent pool. Higher = more likely when the
   *  pool fires. Independent items use weight 1. */
  weight: number
  /** EQ's "chance >= 100" — pool always also drops this when it fires. */
  guaranteed?: boolean
}

/**
 * EQ-correct loot rolling: each pool corresponds to one lootdrop in the
 * source data. On a kill, the pool's `probability` is rolled once; if it
 * succeeds, `multiplier` items are picked from `items` by weight. This
 * preserves the EQEmu semantics where most mobs drop 0-2 items, not their
 * whole loot table.
 */
export interface LootPool {
  probability: number           // 0..1 — chance the pool fires this kill
  multiplier: number            // # of weighted picks if it fires (usually 1)
  items: LootDrop[]
}

export interface LootTable {
  id: string
  coinMin: number               // copper
  coinMax: number               // copper
  pools: LootPool[]
}

// ─── Mobs / Camps / Zones ────────────────────────────────────────────────────

export interface Mob {
  id: string
  name: string
  level: number
  hp: number
  minDamage: number
  maxDamage: number
  ac: number
  attackDelay: number           // seconds
  xpValue: number
  lootTableId: string
  isUndead?: boolean
  isNamed?: boolean
  /** EQEmu npc_faction_id — drives kill-time faction deltas. */
  npcFactionId?: number
  /** EQEmu npc_spells_id — drives spell casting AI. */
  npcSpellsId?: number
  /** EQEmu bodytype, preserved for skinning + body-vs-magic-effect checks. */
  bodyType?: number
  /** EQEmu MR/FR/CR/PR/DR/Corrup, projected from npc_types. Used by the
   *  resist roll (utils/resists.ts) when the player nukes/DoTs this mob. */
  resists?: {
    mr: number; cr: number; dr: number; fr: number; pr: number; corrup: number
  }
  /**
   * Every zone short name this mob appears in via the EQEmu spawn chain
   * (spawn2 → spawngroup → spawnentry). Always populated even when the
   * camp consolidator dropped this mob from its short-list, so the wiki
   * mob page can answer "where does X spawn?" without relying on the
   * camp curation rolling for it.
   */
  zoneShortNames?: string[]
}

export interface MobSpawn {
  mobId: string
  weight: number                // relative weight in the spawn pool
}

export interface NamedSpawn {
  mobId: string
  /** 0..1 chance this named rolls per spawn tick. Each entry in the
   *  array rolls independently; the first to succeed wins. */
  spawnChance: number
}

export interface Camp {
  id: string
  name: string
  spawnTimerSec: number         // base seconds between spawns
  difficultyModifier: number    // multiplier on mob HP/damage
  mobs: MobSpawn[]
  /**
   * Possible named spawns for this camp. Each entry rolls independently
   * at spawn time; the first to roll under its spawnChance becomes the
   * spawn. Empty / absent means a regular trash-only camp.
   *
   * Single-entry array = the classic "one named per camp" pattern
   * (raid lairs, dedicated named camps). Multi-entry array = a trash
   * camp with multiple possible rare spawns rotating between
   * placeholders, mirroring EQ's real "rare spawn pool" pattern.
   *
   * Backwards compat: a legacy single-object form is converted to a
   * 1-element array in data/zones.ts setZones().
   */
  namedMob?: NamedSpawn[]
  /**
   * Marks a hand-authored raid lair (Lord Nagafen's Lair etc.). The
   * camp picker shows an "Engage" button instead of auto-spawning, and
   * `engageRaid()` spawns the named with raid scaling (extra HP, +25%
   * incoming damage, 2x XP, double-rolled loot). A 5-minute cooldown
   * gates re-engagement so you can retry without waiting 30 minutes.
   */
  isRaidLair?: boolean
}

export interface Zone {
  id: string
  name: string
  continent: string
  levelRange: [number, number]
  zem: number                   // zone XP modifier
  camps: Camp[]
  levelRequirement: number
  description: string
  /** XP zone (true) vs city/safe-zone (false). Drives the travel picker. */
  isCombatZone: boolean
  /** Faction ID that owns this zone (most common npc primary faction). */
  primaryFactionId?: number
}

// ─── Character (runtime state) ───────────────────────────────────────────────

/**
 * Personal inventory is a flat, unbounded list of stacks. The 8-slot bag
 * model was tried briefly (commit 35fca95) and reverted — players found
 * the capacity friction worse than the realism gain. A "Backpack" or
 * "Large Backpack" item can still exist in inventory but is inert (its
 * bagSize is ignored by the engine).
 */
export interface InventorySlot {
  itemId: string
  qty: number
}

/** Older save shape, retained only for the load-time migration. Identical
 *  to the current shape today but kept as a separate name so future
 *  schema bumps can lean on it again. */
export interface LegacyInventoryItem {
  itemId: string
  qty: number
}

/**
 * Number of spell gem slots a character has on their bar. Classic EQ
 * pure-casters got 8 from L1; the value lives here so the store and the
 * UI agree on the cap.
 */
export const SPELL_GEM_SLOTS = 8

/**
 * Legacy per-character bank capacity. Kept only so the load-time migration
 * (stores/character.ts) can clip oversized payloads before draining them
 * into the shared bank. New writes always go to `SHARED_BANK_SLOTS`.
 */
export const BANK_SLOTS = 16

/**
 * Account-level shared bank capacity. Every character on the same Supabase
 * user reads/writes the same vault — see composables/useAccountBank.ts and
 * stores/accountBank.ts. Two pages of 16 to keep the grid uncramped.
 */
export const SHARED_BANK_SLOTS = 32

export interface Character {
  /**
   * Stable per-character UUID generated client-side at creation time.
   * Maps 1:1 onto the character_saves.character_id Postgres column.
   * Multiple characters per Supabase user are keyed by this.
   */
  characterId: string

  // identity
  name: string
  surname: string | null
  race: RaceId
  /** Cosmetic only (model pick) — optional so EverIdle-era payloads load. */
  gender?: 'male' | 'female'
  class: ClassId
  deity: DeityId

  // progression
  level: number
  xp: number                    // XP into current level
  xpToLevel: number             // XP required to reach next level

  // derived live stats (recomputed on equip / level / buff change)
  hp: number
  maxHp: number
  mana: number
  maxMana: number
  stats: StatBlock              // race + class + level + gear

  // equipment & inventory
  equipment: Partial<Record<EquipmentSlot, string>>  // slot -> itemId
  /**
   * Augment socketed into each equipment slot. EQEmu's per-item augslot
   * data wasn't projected, so we use a simple rule: any equipped item
   * of quality `rare` or better grants one augment socket. The socket
   * is tied to the slot (not the item) — swapping gear in a socketed
   * slot keeps the augment in place. Drag an augment from the bag onto
   * the slot to socket it; unsocket from the item-details modal.
   */
  equipmentAugments?: Partial<Record<EquipmentSlot, string>>
  inventory: InventorySlot[]                 // flat list of stacks (unbounded)

  /**
   * Legacy per-character bank. The shared (account-level) bank replaced
   * this; new deposits/withdraws never touch this field. On character
   * load any items still present are drained into the account bank and
   * this array is emptied. Kept on the type only so old saves parse.
   */
  bank: InventorySlot[]

  // spellbook (auto-granted when level requirement met)
  knownSpells: number[]                                 // spell IDs known
  spellPriority: number[]                               // ordered cast list (max SPELL_GEM_SLOTS)
  spellCooldowns: Record<number, number>                // spellId → epoch ms when usable

  // faction standings (only stored where ≠ base; base comes from FACTION_BY_ID)
  factions: Record<number, number>                      // factionId → standing

  // hired mercenary (one slot; null when none)
  merc: ActiveMerc | null

  /**
   * Summoned or charmed pet (one slot). Persists across encounters but
   * dispels on player death, on combat zone change, or when its charm
   * timer (if charmed) expires.
   */
  activePet: ActivePet | null

  // active life mode — mutually exclusive (Melvor-style)
  activeMode: ActivityMode

  /** When true in combat mode: no spawns, no swings — the world freezes. */
  combatPaused: boolean

  // gathering skill pools (0..300 each, EQ-style)
  gatheringSkills: GatheringSkills

  // when the next forage / fishing roll is due (epoch ms)
  nextForageAt: number
  nextFishingAt?: number

  // general utility skills (Bind Wound today, more later)
  generalSkills: GeneralSkills

  // bind-wound cast in-flight; null when idle
  bindWoundCast: BindWoundCast | null

  // food / drink — epoch ms until well-fed / hydrated runs out (0 = depleted)
  fedUntil: number
  hydratedUntil: number

  // tradeskills — per-skill level + the active recipe being auto-crafted
  tradeskills: TradeskillSkills
  activeCraft: ActiveCraft | null

  // alternate advancement (GDD §18)
  aaPoints: number                          // unspent AA points
  aaXp: number                              // XP banked toward next AA point
  aaSpent: Record<string, number>           // aa.id → ranks purchased
  aaXpSplit: 0 | 25 | 50 | 75 | 100         // % of incoming XP routed to AA

  // epic-weapon quest progress (GDD §17)
  epicProgress: EpicProgress

  // active DoTs ticking on the player from mob casts
  activeDots: ActiveDot[]

  // generic timed buffs/debuffs (fear, stat-mods, etc.). DoTs and slow keep
  // their dedicated slots so the hot path stays fast.
  activeBuffs: ActiveBuff[]

  // attack-speed debuff from mob slows (100 = unaffected; <100 = slowed)
  attackSpeedPct: number
  slowExpiresAt: number             // epoch ms when the current slow lifts

  // economy
  copper: number                // canonical store; 100 cp = 1 sp etc

  /**
   * Item ids the player has flagged as "do not sell" — Sell All in the
   * vendor panel skips these. Stored as an array (JSONB-friendly) but
   * used as a Set semantically.
   */
  protectedItemIds: string[]

  // location
  currentZoneId: string
  currentCampId: string | null
  bindZoneId: string

  // lifetime stats
  totalMobsKilled: number
  totalXpEarned: number
  deaths: number

  // ─── Achievement progress ────────────────────────────────────────────────
  /** Per-mob kill counters used by `slayMob` achievement conditions. */
  mobKills?: Record<string, number>
  /** Set of zone ids the character has set foot in (for `visitZone` achievements). */
  visitedZoneIds?: string[]
  /** Ids of achievements the player has completed (rewards already applied). */
  completedAchievementIds?: number[]
  /**
   * Cumulative AA points awarded by achievements, kept separately so we
   * can show the player how much of their AA pool came from this source.
   * Already included in `aaPoints` (which is the spendable balance).
   */
  achievementAaGranted?: number
  /** Stat additions granted by achievements, applied on top of equipment stats. */
  achievementStatBonus?: Partial<StatBlock>

  // ─── Camp Mastery ────────────────────────────────────────────────────────
  /**
   * Per-camp mastery progress. Every kill at a camp adds 1 XP to that
   * camp's entry; XP thresholds gate levels 1-10. Each level grants a
   * stacked bonus at that camp (XP, loot, coin, respawn) and level 10
   * unlocks the camp's Champion — a beefed-up named on its own respawn
   * cycle. Keyed by `${zoneId}:${campId}` to match combat.campRespawns.
   */
  campMastery?: Record<string, { xp: number; level: number; championDefeated?: boolean }>
  /** Last time the Champion was killed at each camp (epoch ms), used for the cooldown. */
  championCooldowns?: Record<string, number>

  /**
   * Per-faction milestone tracking. Records the highest standing tier
   * we've awarded a one-time reward for (Warmly = 3 AA + 5pp,
   * Ally = 5 AA + 10pp). Falling back below the tier and re-cresting
   * does NOT pay out again — the milestone is for the first time you
   * earn the standing, period. Keyed by faction id.
   */
  factionMilestonesClaimed?: Record<number, string>

  // ─── Daily contract ─────────────────────────────────────────────────────
  /**
   * One rotating goal per UTC day. Generated deterministically from
   * characterId + dayKey, tracked passively as the player plays, and
   * grants AA + coin on claim. Cleared/regenerated when dayKey changes.
   */
  dailyContract?: DailyContract

  // ─── Prestige (Rebirth) + Inheritance ────────────────────────────────────
  /**
   * Number of times the character has rebirthed. Each Rebirth resets
   * level → 1, XP → 0, inventory + equipment wiped (bank preserved),
   * but keeps AAs, achievements, camp mastery, and grants inheritance
   * stat points. Displayed as ✦N next to the character name.
   */
  prestigeCount?: number
  /**
   * Stat-point allocations earned through Rebirths and spent on per-stat
   * permanent boosts. Refundable any time — the pool tracks total
   * earned, the breakdown stores per-stat distribution.
   */
  inheritancePool?: number   // total points earned across all rebirths
  inheritanceStats?: Partial<StatBlock>   // points currently allocated per stat

  // bookkeeping
  createdAt: number             // epoch ms
  lastTickAt: number            // epoch ms (for offline progress later)
}

export interface EpicProgress {
  stepIndex: number             // next step the player needs to complete (0-based)
  completed: boolean
  rewardedItemId: string | null
}

// ─── Combat (transient) ──────────────────────────────────────────────────────

export interface ActiveMob {
  instanceId: string            // unique per spawn
  mobId: string
  hp: number
  maxHp: number
  nextSwingAt: number           // epoch ms
  spawnedAt: number
  isNamed: boolean
  /** Active DoTs ticking on this mob. */
  activeDots: ActiveDot[]
  /** Generic timed buffs/debuffs applied to this mob by the player. */
  activeBuffs: ActiveBuff[]
  /** Attack-speed % of normal (100 = unaffected, 60 = 40% slow). */
  attackSpeedPct: number
  /** Slow effect expires at this epoch ms (0 = no slow active). */
  slowExpiresAt: number
  /** Cooldown for the mob's next spell cast (epoch ms). */
  nextSpellAt: number
  /** Per-spell cooldowns for this mob. */
  spellCooldowns: Record<number, number>
  /**
   * Mob mana pool. Sized off level; nukes/DoTs consume the spell's manaCost
   * (or the npc_spells entry's override when set). When empty the mob falls
   * back to melee until regen restores enough to cast again. Without this,
   * caster trash with `recastDelayMs: -1` would nuke every cast cadence
   * forever — that's how a reanimated hand was landing a 400-damage
   * Lightning Shock every 5.5s with no fatigue.
   *
   * Optional for backwards-compat with older saves; combat.ts re-initialises
   * if missing on first cast attempt.
   */
  mana?: number
  maxMana?: number
  /** Last epoch ms a mana-regen tick was applied, for delta-based regen. */
  manaRegenAt?: number
  /**
   * Spawned via the raid lair "Engage" button. Drives extra HP scaling,
   * +25% outgoing damage, 2x XP on kill, and double-roll loot. Plain
   * camp respawns of the same named have this false.
   */
  raidActive?: boolean
  /**
   * Spawned via Camp Mastery's L10 Champion encounter. Hits harder, has
   * a beefier loot table, doesn't grant mastery XP back into its own
   * camp (you've already maxed it), and triggers the Champion cooldown
   * on kill.
   */
  championKill?: boolean
}

export interface ActiveDot {
  spellId: number
  dmgPerTick: number
  ticksRemaining: number
  nextTickAt: number           // epoch ms
  caster: 'player' | 'mob' | 'merc'
  sourceName?: string          // display name when mob-applied
}

/**
 * Generic timed buff or debuff applied by a spell. Discriminated by
 * `effectId` (same numbering EQEmu uses in spells_new.effectidNN). Lives
 * on both Character.activeBuffs (effects targeting the player) and
 * ActiveMob.activeBuffs (effects the player cast at a mob). Slow and DoT
 * stay in their own first-class slots for engine simplicity — only the
 * effects that don't already have dedicated handling route through here.
 */
export interface ActiveBuff {
  spellId: number
  effectId: number
  magnitude: number             // baseValue from the spell effect (signed)
  expiresAt: number             // epoch ms
  caster: 'player' | 'mob' | 'merc'
  sourceName?: string
}

export interface CombatLogEntry {
  id: number                    // monotonic
  t: number                     // epoch ms
  kind: 'hit' | 'miss' | 'kill' | 'death' | 'loot' | 'levelup' | 'xp' | 'system' | 'merc'
  text: string
}

// ─── Activity mode (Melvor-style) ───────────────────────────────────────────

export type ActivityMode = 'combat' | 'gathering' | 'crafting'

// ─── Gathering (GDD §14) ────────────────────────────────────────────────────

export type GatheringSkill = 'foraging' | 'fishing' | 'skinning'

export interface GatheringSkills {
  foraging: number             // 0..300 EQ-style
  fishing: number
  skinning: number
}

// ─── General utility skills (GDD §15) ───────────────────────────────────────
// Self-improvement skills the player triggers manually. Bind Wound is the
// first; future entries (Sense Heading, Forage, Tracking, etc.) drop in here.

export interface GeneralSkills {
  bindWound: number            // 0..200 EQ-style
}

export interface BindWoundCast {
  startedAt: number            // epoch ms
  finishesAt: number           // epoch ms
}

// ─── Tradeskills (GDD §13) ──────────────────────────────────────────────────

export type TradeskillKey =
  | 'fishing' | 'make_poison' | 'tinkering' | 'research' | 'alchemy'
  | 'baking' | 'tailoring' | 'blacksmithing' | 'fletching' | 'brewing'
  | 'jewelcraft' | 'pottery'

export type TradeskillSkills = Record<TradeskillKey, number>

/** One active recipe being auto-crafted in the background. */
export interface ActiveCraft {
  recipeId: number
  nextAttemptAt: number         // epoch ms
  successes: number
  failures: number
}

// ─── Mercenaries (GDD §9) ────────────────────────────────────────────────────

export type MercType = 'tank' | 'healer' | 'dps_melee' | 'dps_caster'
export type MercTier =
  | 'apprentice_1' | 'apprentice_2'
  | 'journeyman_1' | 'journeyman_2' | 'journeyman_3'
  | 'master_1'     | 'master_2'     | 'master_3'

/** Runtime merc state attached to the character. */
/**
 * Summoned or charmed pet. Lives until killed, dispelled, the charm timer
 * expires (when origin === 'charm'), the player dies, or the player
 * changes zones. Single slot per character — a new summon replaces the
 * current pet.
 */
export interface ActivePet {
  /** Display name (e.g. "Skeletal Minion" for summons, the mob's name for charms). */
  name: string
  /** EQ icon id for UI rendering. Uses the spell icon namespace. */
  iconId?: number
  /** 'summon' = magician/necro summon; 'charm' = enchanter/druid charm. */
  origin: 'summon' | 'charm'
  /** Spell that produced this pet, for log / dispel correlation. */
  spellId: number
  /** Combat stats. */
  level: number
  hp: number
  maxHp: number
  damageMin: number
  damageMax: number
  attackDelaySec: number
  nextSwingAt: number          // epoch ms
  /** Epoch ms when a charm-origin pet despawns; 0 for permanent summons. */
  charmExpiresAt: number
  /** For charm-origin pets, the source mobId so the combat tick can
   *  re-engage the original mob if the charm breaks while it's still alive. */
  originMobId?: string
  summonedAt: number
}

// ─── Achievements ────────────────────────────────────────────────────────
//
// Catalog projected from live-EQ files (scripts/build-achievements.ts).
// Only achievements whose conditions are fully trackable with our event
// model are kept. Conditions are a discriminated union the runtime
// tracker matches on; rewards are applied once on completion.

export type AchievementCategory = 'level' | 'skill' | 'slayer' | 'explorer' | 'special'

export type AchievementCondition =
  | { kind: 'level'; level: number }
  | { kind: 'skill'; skill: string; threshold: number }
  | { kind: 'slayMob'; mobId: string; count: number }
  | { kind: 'visitZone'; zoneId: string }

export type AchievementReward =
  | { kind: 'aa'; points: number }
  | { kind: 'stat'; stat: keyof StatBlock; amount: number }

export interface Achievement {
  id: number
  name: string
  description: string
  iconId: number
  pointValue: number
  category: AchievementCategory
  conditions: AchievementCondition[]
  reward: AchievementReward
}

export interface ActiveMerc {
  type: MercType
  tier: MercTier

  // pool — recomputed when hired or when the player gains a level
  hp: number
  maxHp: number
  mana: number
  maxMana: number

  // current scaling level — within 2 of the character's level
  effectiveLevel: number

  // economy
  hiredAt: number                  // epoch ms
  nextUpkeepAt: number             // epoch ms when next upkeep is due
  totalUpkeepPaid: number          // copper

  // status flags
  suspended: boolean               // manually paused (no combat, no upkeep)
  deathCooldownUntil: number       // 0 = alive; epoch ms when revive available

  // combat bookkeeping
  nextActionAt: number             // epoch ms — when this merc next acts
}

// ─── Daily contracts ─────────────────────────────────────────────────────

export type DailyContractType = 'slay' | 'hunt' | 'xp' | 'loot' | 'mastery'

export interface DailyContract {
  /** Stable id for the day-character pair (used as the React/Vue key). */
  id: string
  /** UTC day string the contract was generated for. `YYYY-MM-DD`. */
  dayKey: string
  /** What kind of event progresses this contract. */
  type: DailyContractType
  /** For 'hunt' contracts: lowercased substring matched against mob name. */
  huntTarget?: string
  /** Display label for the substring (e.g. "Orcs" for huntTarget="orc"). */
  huntLabel?: string
  /** How many events the contract needs. */
  targetCount: number
  /** Current event count toward the target. */
  progress: number
  /** Reward AA points on claim. */
  rewardAa: number
  /** Reward coin (copper) on claim. */
  rewardCoin: number
  /** True once progress >= targetCount. */
  completed: boolean
  /** Epoch ms when the player clicked Claim. */
  claimedAt?: number
}
