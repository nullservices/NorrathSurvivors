<script setup lang="ts">
// Standalone Norrath Survivors run, using EverQuest assets on an open field.
// Hero/mob rigs, animations, zone ground textures, spell effects, and combat
// data come from the local EverQuest assets and game-data blobs.
//
//   • WASD / arrows  — move (camera-relative)
//   • click / Tab    — target a mob
//   • T              — toggle automatic spellcasting
//
// Survivor HUD and progression sit over the live WebGL scene.

import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

import { ZONE_BY_ID } from '~/data/zones'
import { MOB_BY_ID } from '~/data/mobs'
import { xpRequired, conColor, CON_DISPLAY } from '~/utils/xp'
import { playerRig, RACE_SCALE, MODEL_CLIP_DONOR, type Gender } from '~/utils/playerModels'
import RACE_MODELS from '~/data/generated/race_models.json'
import { retargetClips, mergeClips, fixupRig } from '~/utils/clipRetarget'
import {
  loadZone, zoneIdAt, serverToWorld, groundHeight, surfaceBelow, collideSlide,
  waterSurface, ladderAhead, findLedge, CameraCutaway,
  updateLift, toggleLift, liftSwitchAt, onLift,
  type LoadedZone, type SpawnPoint,
} from '~/utils/zoneRuntime'
import { applyMobVariant } from '~/utils/mobTexture'
import { publicPath } from '~/utils/publicPath'
import type { Mob, RaceId } from '~/types/game'

definePageMeta({ layout: false })
useHead({ title: 'Norrath Survivors' })

const gd = useGameData()

// ─── Tunables ───────────────────────────────────────────────────────────────
const MOVE_SPEED = 6.2          // player units / sec
const ENEMY_SPEED = 3.8
const MELEE_RANGE = 2.3         // world units
const ARENA_RADIUS = 108
const ARENA_WALK_RADIUS = 96
const ARENA_FIELD_SIZE = 240
const AGGRO_RANGE = 7.5
const LEASH_RANGE = 22
// Welded worlds can hold hundreds of spawns at once (gfaydark+crushbone ≈ 350).
// Mobs beyond this distance from the player are hidden and their animation
// mixers/AI frozen — far past aggro/leash, well outside the iso view, so it's
// invisible to play but saves the per-frame skinned-mesh + render cost.
const ACTIVE_RANGE = 100
// Model forward axis differs by rig: the old EQ monster models face local -Z
// (offset π), while the Luclin `_new` humanoids used for the player face +Z
// (offset 0). Stored per-entity as `yawOffset`.
// Every model is converted by the same wce-to-glb pipeline, so they share a
// local forward axis of +X — facing math adds -90° to align local +X with the
// movement/target direction.
const MODEL_YAW_OFFSET = -Math.PI / 2  // monster rigs (orc, gnoll, …)
const PLAYER_YAW_OFFSET = -Math.PI / 2 // Luclin `_new` player rigs

// EQ mob-name → model code (public/eq-assets/<code>.glb). Unmatched names
// fall back to a tinted capsule so the world always populates.
const MODEL_KEYWORDS: Array<[RegExp, string, number]> = [
  // [match, glb code, scale multiplier vs 1.8u baseline]
  [/orc/i, 'orc', 1.0],
  [/gnoll/i, 'gnn', 1.05],
  [/kobold/i, 'kob', 0.95],
  [/goblin/i, 'gob', 0.85],
  [/skeleton/i, 'ske', 1.0],
  [/zombie/i, 'zom', 1.0],
  [/ghoul/i, 'ghu', 1.0],
  [/(wolf|jackal|warg)/i, 'wol', 0.8],
  [/bear|cub/i, 'bea', 1.1],
  [/(spider|widow|arachnid)/i, 'spi', 0.8],
  [/(snake|cobra|viper)/i, 'sna', 0.7],
  [/(rat|vermin)/i, 'rat', 0.55],
  [/bat/i, 'bat', 0.6],
  [/wasp|bee|hornet/i, 'was', 0.7],
  [/(lion|puma|cougar|mountain cat)/i, 'pum', 1.0],
  [/tiger/i, 'tig', 1.1],
  [/(gorilla|ape)/i, 'gor', 1.2],
  [/(lizard|reptile|scaled)/i, 'liz', 1.0],
  [/(froglok|frog)/i, 'frg', 0.95],
  [/(giant|cyclops|hill)/i, 'gia', 2.4],
  [/(imp|gargoyle)/i, 'imp', 0.8],
  [/(decaying|crushbone)/i, 'ske', 1.0],
]

// ─── Loaded-state for the HUD ────────────────────────────────────────────────
const containerRef = ref<HTMLDivElement | null>(null)
const ready = ref(false)
const loadingMsg = ref('Entering the old world…')
const loadError = ref<string | null>(null)
const zoneName = ref('')

type LogClass = 'sys' | 'you' | 'them' | 'death' | 'spawn' | 'loot'
interface LogEntry { id: number; text: string; cls: LogClass }
const log = ref<LogEntry[]>([])
let nextLogId = 1
function pushLog(text: string, cls: LogClass = 'sys') {
  log.value.push({ id: nextLogId++, text, cls })
  if (log.value.length > 80) log.value.splice(0, log.value.length - 80)
}

const player = reactive({
  name: 'Adventurer',
  className: 'Wizard',
  race: 'human' as RaceId,
  level: 1,
  xp: 0,
  xpToLevel: xpRequired(1),
  hp: 100,
  maxHp: 100,
  mana: 100,
  maxMana: 100,
  dead: false,
})

interface TargetView {
  id: number; name: string; level: number; hp: number; maxHp: number
  conText: string; conColor: string; dist: number; isNamed: boolean
}
const targetView = ref<TargetView | null>(null)

// Control scheme: 'wasd' (default keyboard) or 'click' (Diablo-style
// click-to-move / click-to-attack). Toggle with the on-screen control or `M`.
const controlMode = ref<'wasd' | 'click'>('wasd')
const moveTarget = ref<{ x: number; z: number } | null>(null)  // click destination
let clickFollowId: number | null = null                        // enemy we clicked to attack
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)

interface MiniBlip { id: number; nx: number; nz: number; alive: boolean; targeted: boolean }
const miniBlips = ref<MiniBlip[]>([])
const playerBlip = reactive({ nx: 0.5, nz: 0.5 })

const autoAttack = ref(true)
const nowMs = ref(performance.now())
const waveNumber = ref(1)
const runKills = ref(0)
const runSeconds = ref(0)
const runOver = ref(false)
const paused = ref(false)
const upgradeChoices = ref<Array<{ name: string; description: string }>>([])
let runStartedAt = 0
let pauseStartedAt = 0
let nextWaveAt = 0
let pendingUpgradeCount = 0
let survivorMobPool: Mob[] = []
let spellDamage = 34
let spellCooldownMs = 1350
let spellRange = 12
let spellSpeed = 25
let spellCount = 1
let survivorSpellReadyAt = 0
let moveSpeedMultiplier = 1
let maxEnemies = 30
interface SpellSpriteFx {
  sprite: THREE.Sprite
  map: THREE.Texture
  material: THREE.SpriteMaterial
  columns: number
  rows: number
  size: number
}
interface SurvivorBolt {
  visual: THREE.Group
  targetId: number
  damage: number
  life: number
  age: number
  flame: SpellSpriteFx | null
  orb: SpellSpriteFx | null
  fallback: THREE.Mesh | null
}
interface SurvivorImpact { fx: SpellSpriteFx; age: number; duration: number }
const survivorBolts: SurvivorBolt[] = []
const survivorImpacts: SurvivorImpact[] = []
const spellTextures: { flame: THREE.Texture | null; orb: THREE.Texture | null; impact: THREE.Texture | null } = {
  flame: null, orb: null, impact: null,
}
const xpGems: Array<{ mesh: THREE.Mesh; value: number }> = []

const SURVIVOR_UPGRADE_BASE = [
  { name: 'Improved Conjuration', description: 'Spell damage +25%', apply: () => { spellDamage *= 1.25 } },
  { name: 'Quickened Casting', description: 'Cast speed +18%', apply: () => { spellCooldownMs *= 0.82 } },
  { name: 'Twin Bolts', description: 'Fire one additional bolt', apply: () => { spellCount += 1 } },
  { name: 'Long Reach', description: 'Spell range +22%', apply: () => { spellRange *= 1.22 } },
  { name: 'Fleet Foot', description: 'Movement speed +15%', apply: () => { moveSpeedMultiplier *= 1.15 } },
  { name: 'Greater Vitality', description: 'Heal fully and gain 25 max health', apply: () => { player.maxHp += 25; player.hp = player.maxHp } },
  { name: 'Arcane Overload', description: 'Spell damage +12% and cast speed +8%', apply: () => { spellDamage *= 1.12; spellCooldownMs *= 0.92 } },
]

// ─── three.js state (non-reactive) ───────────────────────────────────────────
let renderer: THREE.WebGLRenderer | null = null
let labelRenderer: CSS2DRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.OrthographicCamera | null = null
let raf = 0
const clock = new THREE.Clock()
const modelCache = new Map<string, THREE.Object3D & { animations: THREE.AnimationClip[] }>()

interface Combatant {
  kind: 'player' | 'enemy'
  id: number
  mobId?: string
  name: string
  level: number
  hp: number
  maxHp: number
  alive: boolean
  isNamed: boolean
  minDmg: number
  maxDmg: number
  attackDelayMs: number
  xpValue: number
  // scene
  root: THREE.Group
  mixer: THREE.AnimationMixer | null
  actions: Record<string, THREE.AnimationAction>
  currentClip: string
  meshes: THREE.Object3D[]   // raycast targets
  label: CSS2DObject
  hpFill: HTMLDivElement
  // movement / ai
  homeX: number
  homeY: number
  homeZ: number
  facing: number
  lastAttackAt: number
  aggro: boolean
  // player-only fake-attack lunge
  lungeUntil: number
  // while > now, a one-shot combat clip (swing) owns the rig; the
  // locomotion state machine won't override it until it finishes.
  busyUntil: number
  // model forward-axis correction (see MODEL_YAW_OFFSET / PLAYER_YAW_OFFSET)
  yawOffset: number
  // true while floating in deep water (set by snapToGround) → swim anim
  swimming?: boolean
}

let playerEnt: Combatant | null = null
const enemies: Combatant[] = []
let nextEntId = 1
let targetId: number | null = null

// ─── Real zone state (loaded when a converted <zone>.glb + spawn data
//     exist; otherwise the legacy campfire-camp scene is used) ─────────────
let zoneMode = false
let loadedZone: LoadedZone | null = null
let arenaMode = false
const arenaCenter = new THREE.Vector3()
const cameraCutaway = new CameraCutaway()
const playerSpawnPos = new THREE.Vector3(0, 0, 8)
let sunLight: THREE.DirectionalLight | null = null

// Swim / climb state. Swimming floats the player at the water surface (body
// half-submerged); climbing ascends a ladder on contact.
const swimming = ref(false)
const climbing = ref(false)
const liftHint = ref(false)      // near a lift switch → show "press F" prompt
const locText = ref('')          // live world coords (debug readout)
const SWIM_SPEED_MUL = 0.55       // slower in water
const SWIM_SUBMERGE = 0.9         // feet below surface → torso at waterline
const SWIM_MIN_DEPTH = 1.2        // water deeper than this (vs floor) = swim
const CLIMB_RISE = 4.0            // world units/sec up a ladder
// Active climb: the ledge position the current climb is committed to rising
// onto (scanned when the ladder is first grabbed). Null when not climbing.
let climbTarget: THREE.Vector3 | null = null

// Jump (spacebar): a vertical velocity launched off the ground, pulled back
// down by gravity until terrain-snap catches it. Disabled while swimming or
// climbing. `airborne` suppresses the ground-snap so a jump actually rises.
// Apex rise = JUMP_SPEED²/(2·GRAVITY) ≈ 3.0u. Sized to clear the ~2.3u stone
// ledges around the Crushbone trainer camp with real margin — at the old 9.6
// the apex cleared them by ~1cm, so you'd clip the ledge face mid-rise (the
// forward-collision probes only clear the lip near apex) and slide off, often
// into the moat below ("falling through into the underworld").
const JUMP_SPEED = 11.0           // initial up velocity (world units/sec)
const GRAVITY = 20.0             // world units/sec² → apex ~3.0u (~10 EQ ft)
let vy = 0                       // vertical velocity while airborne
let airborne = false
let jumpQueued = false           // set on keydown, consumed in the frame loop

/** Place an entity vertically: float at the surface in deep water (sets
 *  `ent.swimming`), else snap to terrain. Returns false off-mesh. */
function snapToGround(ent: Combatant): boolean {
  if (!zoneMode || !loadedZone) return true
  const p = ent.root.position
  const surf = waterSurface(loadedZone.waterMeshes, p.x, p.z)
  const gy = groundHeight(loadedZone.meshes, p.x, p.z, p.y)
  if (surf !== null && (gy === null || surf - gy > SWIM_MIN_DEPTH)) {
    ent.swimming = true
    p.y = surf - SWIM_SUBMERGE
    return true
  }
  ent.swimming = false
  if (gy === null) return false
  p.y = gy
  return true
}

/** Apply jump/fall physics to the player while airborne. Lands on whatever
 *  surface it falls through (or water → swim). Clears `airborne`/`vy`. */
function applyAirborne(dt: number) {
  if (!playerEnt || !loadedZone) { airborne = false; return }
  const p = playerEnt.root.position
  const prevY = p.y
  vy -= GRAVITY * dt
  p.y += vy * dt
  if (vy <= 0) {
    // The highest solid surface in the swept fall path this frame (with a
    // little extra reach below so a fast fall can't tunnel through a thin
    // deck). We land on it — independent of the headroom-filtered ground-
    // snap, so a ledge always catches us instead of dropping us through.
    const top = surfaceBelow(loadedZone.meshes, p.x, p.z, prevY + 0.3, (prevY + 0.3) - p.y + 0.5)
    if (top !== null && top <= prevY + 0.05 && p.y <= top + 0.3) {
      p.y = top; airborne = false; vy = 0; return
    }
    const surf = waterSurface(loadedZone.waterMeshes, p.x, p.z)
    if (surf !== null && p.y <= surf - SWIM_SUBMERGE) {
      p.y = surf - SWIM_SUBMERGE; airborne = false; vy = 0; swimming.value = true; return
    }
  }
  // Fell out of the world — recover at the spawn point.
  if (p.y < loadedZone.bounds.min.y - 30) {
    p.copy(playerSpawnPos); airborne = false; vy = 0
  }
}

const keys: Record<string, boolean> = {}
function restartRun() { window.location.reload() }
function togglePause() {
  if (runOver.value || upgradeChoices.value.length || !ready.value) return
  if (paused.value) {
    const heldFor = performance.now() - pauseStartedAt
    runStartedAt += heldFor
    nextWaveAt += heldFor
    survivorSpellReadyAt += heldFor
    paused.value = false
  } else {
    pauseStartedAt = performance.now()
    paused.value = true
    for (const key of Object.keys(keys)) keys[key] = false
    moveTarget.value = null
  }
}
const tmpV = new THREE.Vector3()
const camForward = new THREE.Vector3()
const camRight = new THREE.Vector3()
const camTarget = new THREE.Vector3()

// ─── Camera rig (orbit + zoom) ────────────────────────────────────────────
// The iso camera orbits the player on a sphere: yaw (right-drag horizontal),
// pitch (right-drag vertical, clamped), and an ortho zoom (wheel). Defaults
// reproduce the original fixed (+20,+24,+20) offset: dist 37.1, pitch 40.3°,
// yaw 45°. WASD movement stays camera-relative via inputVector(), so turning
// the camera turns "forward".
const CAM_DIST = 37.1
let camYaw = Math.PI / 4
let camPitch = 0.703              // ~40.3° elevation
const PITCH_MIN = 0.30, PITCH_MAX = 1.30
let viewSize = 6.5               // ortho half-height; smaller = zoomed in
const VIEW_MIN = 3.0, VIEW_MAX = 16.0
// Right-drag state.
let orbiting = false
let lastPointerX = 0, lastPointerY = 0
const ORBIT_YAW_SPEED = 0.012, ORBIT_PITCH_SPEED = 0.009

// ─── Helpers ─────────────────────────────────────────────────────────────────
function roll(min: number, max: number) { return Math.floor(min + Math.random() * (max - min + 1)) }
function dist2D(ax: number, az: number, bx: number, bz: number) {
  const dx = ax - bx, dz = az - bz
  return Math.sqrt(dx * dx + dz * dz)
}
function capitalize(s: string) { return s.charAt(0).toUpperCase() + s.slice(1) }

// EQ npc race id (1-12) → our player RaceId. Humanoid NPCs (guards,
// slaves, citizens, merchants) share the player race models, so they
// render through playerRig() — gendered + donor-aware.
const EQ_PLAYER_RACE: Record<number, RaceId> = {
  1: 'human', 2: 'barbarian', 3: 'erudite', 4: 'wood_elf', 5: 'high_elf',
  6: 'dark_elf', 7: 'half_elf', 8: 'dwarf', 9: 'troll', 10: 'ogre',
  11: 'halfling', 12: 'gnome', 128: 'iksar',
}
const monsterRaceModels = RACE_MODELS as Record<string, string>
// mob id → [race, gender, texture, size]; fetched on zone entry.
let mobAppearance: Record<string, [number, number, number, number]> = {}

/**
 * Resolve a mob's model. Priority: real EQ race id (authoritative — player
 * rig for humanoid races, the empirically-derived race→code map for
 * monsters), then the name-keyword matcher (curated camps / unmapped
 * races), then null → tinted capsule. Returns the donor rig for bare codes
 * so combat/idle clips are retargeted in (utils/clipRetarget).
 */
function resolveModel(mob: Mob): { code: string | null; scale: number; donor?: string; variant?: number } {
  const app = mobAppearance[mob.id]
  if (app) {
    const [race, gender, texture, size] = app
    const sizeScale = size > 0 ? Math.min(3, Math.max(0.4, size / 6)) : 1
    const playerRace = EQ_PLAYER_RACE[race]
    if (playerRace) {
      // Player-race NPCs: texture means face/detail, not a creature skin —
      // leave variant unset.
      const rig = playerRig(playerRace, gender === 1 ? 'female' : 'male' as Gender)
      return { code: rig.code, donor: rig.donor, scale: (RACE_SCALE[playerRace] ?? 1) }
    }
    const code = monsterRaceModels[String(race)]
    // texture id re-skins the creature (e.g. orc 0=Antonica, 1=Faydwer).
    if (code) return { code, scale: sizeScale, donor: MODEL_CLIP_DONOR[code], variant: texture }
  }
  // Fallback: name keywords (curated-camp data + races we couldn't map).
  for (const [re, code, scale] of MODEL_KEYWORDS) {
    if (re.test(mob.name)) return { code, scale, donor: MODEL_CLIP_DONOR[code] }
  }
  return { code: null, scale: 1 }
}

async function loadGlb(code: string) {
  const cached = modelCache.get(code)
  if (cached) return cached
  const loader = new GLTFLoader()
  const gltf = await loader.loadAsync(publicPath(`/eq-assets/${code}.glb`))
  const root = gltf.scene as THREE.Object3D & { animations: THREE.AnimationClip[] }
  root.animations = gltf.animations
  modelCache.set(code, root)
  return root
}

/**
 * Build an actions map keyed by EQ clip prefix. EQ codes are letter+2digits
 * with an optional Luclin variant suffix (a/b/g) — e.g. `c05b_bam`. We key by
 * the full code (`c05b`) AND register a base-code alias (`c05`) pointing at the
 * first variant, so clipFor() can ask for `c05` regardless of which rig loaded.
 */
function buildActions(mixer: THREE.AnimationMixer, clips: THREE.AnimationClip[]) {
  const actions: Record<string, THREE.AnimationAction> = {}
  for (const clip of clips) {
    const full = clip.name.split('_')[0].toLowerCase()   // e.g. c05b
    const action = mixer.clipAction(clip)
    if (!actions[full]) actions[full] = action
    const base = full.replace(/[abg]$/, '')              // c05
    if (!actions[base]) actions[base] = action
  }
  return actions
}

type AnimWant = 'idle' | 'walk' | 'attack' | 'death' | 'hit' | 'swim' | 'tread' | 'climb' | 'jump'
/** Pick the best available clip for a desired action, with EQ fallbacks.
 *  Skips partial conversions (e.g. legacy hum/bam `p01` animates only 9 of
 *  51 tracks, leaving the arms in bind pose) — under 40% of the rig's
 *  fullest clip means fall through to a complete one.
 *  EQ locomotion codes: L07 climb, L08 tread water, L09 swim forward. */
function clipFor(actions: Record<string, THREE.AnimationAction>, want: AnimWant) {
  const order: Record<AnimWant, string[]> = {
    idle:   ['o01', 'p01', 'p06', 'l01'],
    walk:   ['l01', 'l02'],
    attack: ['c05', 'c01', 'c09', 'c10', 'o01'],
    death:  ['d05', 'd02', 'd01'],
    hit:    ['d02', 'd01', 'd05'],
    swim:   ['l09', 'l08', 'l05', 'l01', 'l02'],   // swim → tread → fall → walk
    tread:  ['l08', 'l09', 'o01', 'p01'],          // idle in water
    climb:  ['l07', 'l05', 'l01', 'o01'],
    jump:   ['l04', 'l03', 'l05', 'o01'],          // jump stand → jump run → fall
  }
  const maxTracks = Math.max(1, ...Object.values(actions).map((a) => a.getClip().tracks.length))
  for (const p of order[want]) {
    if (actions[p] && actions[p].getClip().tracks.length >= maxTracks * 0.4) return p
  }
  return null
}

function play(ent: Combatant, want: AnimWant, opts: { loop?: boolean; fade?: number } = {}) {
  if (!ent.mixer) return
  let prefix = clipFor(ent.actions, want)
  // No idle/walk candidate at all → any clip held still beats a bind-pose
  // statue. (Rigs with zero clips never get here — spawn falls back to
  // the capsule.)
  if (!prefix && (want === 'idle' || want === 'walk')) {
    prefix = Object.keys(ent.actions)[0] ?? null
  }
  if (!prefix) return
  // Rigs without a stand clip (legacy troll: walk-only) resolve idle to a
  // locomotion (or arbitrary) clip — freeze it so they don't walk in
  // place. The same action can serve both idle and walk, so the timescale
  // must be refreshed even when the clip itself doesn't change.
  const timeScale = want === 'idle' && !/^[po]/.test(prefix) ? 0 : 1
  if (prefix === ent.currentClip) {
    ent.actions[prefix].timeScale = timeScale
    return
  }
  const next = ent.actions[prefix]
  next.timeScale = timeScale
  const prev = ent.currentClip ? ent.actions[ent.currentClip] : null
  next.reset()
  next.setLoop(opts.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, opts.loop === false ? 1 : Infinity)
  next.clampWhenFinished = opts.loop === false
  next.enabled = true
  next.setEffectiveWeight(1)
  next.fadeIn(opts.fade ?? 0.2)
  next.play()
  if (prev && prev !== next) prev.fadeOut(opts.fade ?? 0.2)
  ent.currentClip = prefix
}

// ─── Nameplate (CSS2D) ───────────────────────────────────────────────────────
function makeNameplate(name: string, accent: string): { obj: CSS2DObject; fill: HTMLDivElement; nameEl: HTMLDivElement } {
  const wrap = document.createElement('div')
  wrap.className = 'tg-nameplate'
  const nameEl = document.createElement('div')
  nameEl.className = 'tg-np-name'
  nameEl.textContent = name
  nameEl.style.color = accent
  const bar = document.createElement('div')
  bar.className = 'tg-np-bar'
  const fill = document.createElement('div')
  fill.className = 'tg-np-fill'
  fill.style.background = accent
  bar.appendChild(fill)
  wrap.appendChild(nameEl)
  wrap.appendChild(bar)
  const obj = new CSS2DObject(wrap)
  return { obj, fill, nameEl }
}

// ─── Build a combatant ───────────────────────────────────────────────────────
async function spawnModelInto(root: THREE.Group, code: string | null, scale: number, tint: number, donor?: string):
  Promise<{ mixer: THREE.AnimationMixer | null; actions: Record<string, THREE.AnimationAction>; meshes: THREE.Object3D[]; height: number }> {
  if (code) {
    try {
      const src = await loadGlb(code)
      const model = cloneSkinned(src) as THREE.Object3D
      fixupRig(code, model)
      // Bare/partial rigs borrow a bone-compatible donor's clips (the
      // legacy player models — see utils/playerModels.ts).
      let clips = src.animations
      if (donor) {
        try {
          const donorSrc = await loadGlb(donor)
          clips = mergeClips(clips, retargetClips(donorSrc.animations, donor, code, model))
        } catch (e) {
          console.warn('[play] donor rig load failed', donor, e)
        }
      }
      // normalise height to ~1.8 * scale
      const box = new THREE.Box3().setFromObject(model)
      const size = box.getSize(new THREE.Vector3())
      const center = box.getCenter(new THREE.Vector3())
      const h = size.y > 0 ? size.y : 1.8
      const s = (1.8 * scale) / h
      model.scale.setScalar(s)
      model.position.x = -center.x * s
      model.position.z = -center.z * s
      model.position.y = -box.min.y * s
      model.traverse((o) => {
        const m = o as THREE.Mesh
        if (m.isMesh) { m.castShadow = true; const mat = m.material as THREE.MeshStandardMaterial; if (mat) mat.side = THREE.DoubleSide }
      })
      root.add(model)
      // No-T-pose guarantee: a rig with zero usable clips would render
      // frozen in bind pose. Bail to the tinted capsule instead — that's
      // this codebase's established "missing model" signal, and it always
      // reads as intentional. (With MODEL_CLIP_DONOR coverage this should
      // never fire for the curated codes; it guards new/unaudited ones.)
      if (!clips.length) {
        root.remove(model)
        throw new Error(`rig '${code}' has no animation clips (no donor either)`)
      }
      const mixer = new THREE.AnimationMixer(model)
      const actions = buildActions(mixer, clips)
      const meshes: THREE.Object3D[] = []
      model.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o) })
      return { mixer, actions, meshes, height: 1.8 * scale }
    } catch (e) {
      console.warn('[TG] model load failed', code, e)
    }
  }
  // Fallback capsule.
  const geo = new THREE.CapsuleGeometry(0.45 * scale, 1.0 * scale, 4, 8)
  const mat = new THREE.MeshStandardMaterial({ color: tint, roughness: 0.8 })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  mesh.position.y = (0.95 * scale)
  root.add(mesh)
  return { mixer: null, actions: {}, meshes: [mesh], height: 1.9 * scale }
}

async function makePlayer(x: number, z: number, y = 0) {
  const root = new THREE.Group()
  root.position.set(x, y, z)
  const rig = playerRig(player.race, 'male')
  const built = await spawnModelInto(root, rig.code, RACE_SCALE[player.race] ?? 1.0, 0x4a78c8, rig.donor)
  scene!.add(root)
  const { obj, fill } = makeNameplate(player.name, '#86c5ff')
  obj.position.set(0, built.height + 0.5, 0)
  root.add(obj)
  playerEnt = {
    kind: 'player', id: 0, name: player.name, level: player.level, hp: player.hp, maxHp: player.maxHp,
    alive: true, isNamed: false, minDmg: 0, maxDmg: 0, attackDelayMs: 0, xpValue: 0,
    root, mixer: built.mixer, actions: built.actions, currentClip: '', meshes: built.meshes,
    label: obj, hpFill: fill, homeX: x, homeY: y, homeZ: z, facing: 0, lastAttackAt: 0, aggro: false, lungeUntil: 0, busyUntil: 0, yawOffset: PLAYER_YAW_OFFSET,
  }
  play(playerEnt, 'idle', { loop: true })
  built.mixer?.update(0)   // apply the idle pose now so the bind/T-pose never renders
}

async function spawnEnemy(mob: Mob, x: number, z: number, y = 0) {
  const root = new THREE.Group()
  root.position.set(x, y, z)
  root.rotation.y = Math.random() * Math.PI * 2
  const { code, scale, donor, variant } = resolveModel(mob)
  const built = await spawnModelInto(root, code, scale, mob.isNamed ? 0xc0892e : 0x6b7d4a, donor)
  // Re-skin to the npc's texture variant (e.g. Crushbone orcs → Faydwer skin).
  if (code && variant) applyMobVariant(root, code, variant)
  scene!.add(root)
  const accent = mob.isNamed ? '#e7a13a' : '#d98b6b'
  const { obj, fill } = makeNameplate(capitalize(mob.name), accent)
  obj.position.set(0, built.height + 0.5, 0)
  root.add(obj)
  const ent: Combatant = {
    kind: 'enemy', id: nextEntId++, mobId: mob.id, name: mob.name, level: mob.level,
    hp: mob.hp, maxHp: mob.hp, alive: true, isNamed: !!mob.isNamed,
    minDmg: mob.minDamage, maxDmg: mob.maxDamage, attackDelayMs: Math.max(800, mob.attackDelay * 1000),
    xpValue: mob.xpValue,
    root, mixer: built.mixer, actions: built.actions, currentClip: '', meshes: built.meshes,
    label: obj, hpFill: fill, homeX: x, homeY: y, homeZ: z, facing: root.rotation.y, lastAttackAt: 0, aggro: arenaMode, lungeUntil: 0, busyUntil: 0, yawOffset: MODEL_YAW_OFFSET,
  }
  play(ent, 'idle', { loop: true })
  built.mixer?.update(0)   // apply the idle pose now so the bind/T-pose never renders
  enemies.push(ent)
  return ent
}

async function spawnSurvivorWave(count: number) {
  if (!loadedZone || !playerEnt || !survivorMobPool.length) return
  const aliveCount = enemies.filter((e) => e.alive).length
  const amount = Math.min(count, Math.max(0, maxEnemies - aliveCount))
  for (let i = 0; i < amount; i++) {
    const base = survivorMobPool[Math.floor(Math.random() * survivorMobPool.length)]
    const angle = Math.random() * Math.PI * 2
    const aspect = containerRef.value
      ? containerRef.value.clientWidth / Math.max(1, containerRef.value.clientHeight)
      : 16 / 9
    const screenRadius = Math.hypot(viewSize * aspect, viewSize)
    const radius = arenaMode ? screenRadius + 3 + Math.random() * 5 : 5 + Math.random() * 7
    const originX = playerEnt.root.position.x
    const originZ = playerEnt.root.position.z
    const x = originX + Math.cos(angle) * radius
    const z = originZ + Math.sin(angle) * radius
    const y = groundHeight(loadedZone.meshes, x, z, arenaCenter.y + 8) ?? playerEnt.root.position.y
    const threat = Math.max(0, waveNumber.value - 1)
    const level = Math.min(30, Math.max(base.level, 1 + Math.floor(threat / 2)))
    const scale = 1 + threat * 0.045
    const mob: Mob = {
      ...base,
      level,
      hp: Math.round(base.hp * scale),
      minDamage: Math.max(1, Math.round(base.minDamage * scale)),
      maxDamage: Math.max(2, Math.round(base.maxDamage * scale)),
      xpValue: Math.round(base.xpValue * (1 + threat * 0.08)),
    }
    await spawnEnemy(mob, x, z, y)
  }
}

function clampToArena(position: THREE.Vector3) {
  if (!arenaMode) return
  const dx = position.x - arenaCenter.x
  const dz = position.z - arenaCenter.z
  const distance = Math.hypot(dx, dz)
  if (distance > ARENA_WALK_RADIUS) {
    const scale = ARENA_WALK_RADIUS / distance
    position.x = arenaCenter.x + dx * scale
    position.z = arenaCenter.z + dz * scale
  }
}

async function loadSurvivorSpellTextures() {
  const loader = new THREE.TextureLoader()
  const load = (url: string) => new Promise<THREE.Texture>((resolve, reject) => {
    loader.load(url, resolve, undefined, reject)
  })
  const [flame, orb, impact] = await Promise.all([
    load(publicPath('/eq-effects/flamesp501.png')),
    load(publicPath('/eq-effects/Ballsp501.png')),
    load(publicPath('/eq-effects/Firesp501.png')),
  ])
  for (const texture of [flame, orb, impact]) {
    texture.colorSpace = THREE.SRGBColorSpace
    texture.magFilter = THREE.LinearFilter
    // Mipmaps blend neighboring atlas cells together, creating flashes at
    // frame edges. These small sprites stay crisp with linear filtering.
    texture.minFilter = THREE.LinearFilter
    texture.generateMipmaps = false
    texture.wrapS = THREE.ClampToEdgeWrapping
    texture.wrapT = THREE.ClampToEdgeWrapping
  }
  spellTextures.flame = flame
  spellTextures.orb = orb
  spellTextures.impact = impact
}

function makeSpellSprite(texture: THREE.Texture, columns: number, rows: number, size: number, tint = 0xffffff): SpellSpriteFx {
  const map = texture.clone()
  map.repeat.set(1 / columns, 1 / rows)
  map.offset.set(0, 1 - 1 / rows)
  map.needsUpdate = true
  const material = new THREE.SpriteMaterial({
    map, color: tint, transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, depthTest: true, toneMapped: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(size, size, 1)
  sprite.renderOrder = 10
  return { sprite, map, material, columns, rows, size }
}

function setSpellSpriteFrame(fx: SpellSpriteFx, frame: number) {
  const total = fx.columns * fx.rows
  const index = THREE.MathUtils.euclideanModulo(frame, total)
  const col = index % fx.columns
  const row = Math.floor(index / fx.columns)
  fx.map.offset.set(col / fx.columns, 1 - (row + 1) / fx.rows)
}

function disposeSpellSprite(fx: SpellSpriteFx) {
  fx.sprite.removeFromParent()
  fx.material.dispose()
  fx.map.dispose()
}

function spawnSpellImpact(at: THREE.Vector3) {
  if (!scene || !spellTextures.impact) return
  const fx = makeSpellSprite(spellTextures.impact, 4, 4, 1.75)
  fx.sprite.position.copy(at).add(new THREE.Vector3(0, 0.9, 0))
  scene.add(fx.sprite)
  survivorImpacts.push({ fx, age: 0, duration: 0.48 })
}

function fireSurvivorSpell(target: Combatant, boltIndex = 0) {
  if (!scene || !playerEnt) return
  const visual = new THREE.Group()
  visual.position.copy(playerEnt.root.position).add(new THREE.Vector3(0, 1.15, 0))
  const spread = (boltIndex - (spellCount - 1) / 2) * 0.22
  visual.position.x += spread
  visual.position.z -= spread
  let flame: SpellSpriteFx | null = null
  let orb: SpellSpriteFx | null = null
  let fallback: THREE.Mesh | null = null
  if (spellTextures.flame && spellTextures.orb) {
    flame = makeSpellSprite(spellTextures.flame, 4, 4, 1.25)
    orb = makeSpellSprite(spellTextures.orb, 4, 4, 0.56, 0xffa95a)
    visual.add(flame.sprite, orb.sprite)
  } else {
    const material = new THREE.MeshBasicMaterial({ color: 0xff9b42 })
    fallback = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), material)
    visual.add(fallback)
  }
  scene.add(visual)
  survivorBolts.push({ visual, targetId: target.id, damage: spellDamage, life: 2.5, age: 0, flame, orb, fallback })
  combatAnimOnce(playerEnt, 'attack', 500)
}

function updateSurvivorBolts(dt: number) {
  for (let i = survivorBolts.length - 1; i >= 0; i--) {
    const bolt = survivorBolts[i]
    const target = enemies.find((e) => e.id === bolt.targetId && e.alive)
    bolt.life -= dt
    bolt.age += dt
    if (bolt.flame) setSpellSpriteFrame(bolt.flame, Math.floor(bolt.age * 28))
    if (bolt.orb) setSpellSpriteFrame(bolt.orb, Math.floor(bolt.age * 18))
    const disposeBolt = () => {
      scene?.remove(bolt.visual)
      if (bolt.flame) disposeSpellSprite(bolt.flame)
      if (bolt.orb) disposeSpellSprite(bolt.orb)
      bolt.fallback?.geometry.dispose()
      if (bolt.fallback) (bolt.fallback.material as THREE.Material).dispose()
    }
    if (!target || bolt.life <= 0) {
      disposeBolt()
      survivorBolts.splice(i, 1)
      continue
    }
    const aim = target.root.position.clone().add(new THREE.Vector3(0, 0.85, 0))
    const delta = aim.sub(bolt.visual.position)
    const distance = delta.length()
    if (distance <= spellSpeed * dt + 0.35) {
      spawnSpellImpact(target.root.position)
      target.hp -= bolt.damage
      pushLog(`Fire Bolt strikes ${target.name} for ${Math.round(bolt.damage)}.`, 'you')
      play(target, 'hit', { loop: false })
      if (target.hp <= 0) killEnemy(target)
      else if (target.id === targetId) refreshTargetView()
      disposeBolt()
      survivorBolts.splice(i, 1)
      continue
    }
    bolt.visual.position.addScaledVector(delta.normalize(), spellSpeed * dt)
  }

  for (let i = survivorImpacts.length - 1; i >= 0; i--) {
    const impact = survivorImpacts[i]
    impact.age += dt
    const progress = Math.min(1, impact.age / impact.duration)
    setSpellSpriteFrame(impact.fx, Math.min(15, Math.floor(progress * 16)))
    impact.fx.material.opacity = 1 - progress * 0.25
    impact.fx.sprite.scale.setScalar(impact.fx.size * (0.82 + progress * 0.5))
    if (progress >= 1) {
      disposeSpellSprite(impact.fx)
      survivorImpacts.splice(i, 1)
    }
  }
}

function updateXpGems(dt: number) {
  if (!scene || !playerEnt) return
  for (let i = xpGems.length - 1; i >= 0; i--) {
    const gem = xpGems[i]
    const playerPoint = playerEnt.root.position.clone().add(new THREE.Vector3(0, 0.8, 0))
    const delta = playerPoint.sub(gem.mesh.position)
    const distance = delta.length()
    if (distance < 7) gem.mesh.position.addScaledVector(delta.normalize(), (5 + (7 - distance) * 2.6) * dt)
    else gem.mesh.rotation.y += dt * 2.4
    if (distance < 0.85) {
      scene.remove(gem.mesh)
      gem.mesh.geometry.dispose()
      ;(gem.mesh.material as THREE.Material).dispose()
      xpGems.splice(i, 1)
      gainSurvivorXp(gem.value)
    }
  }
}

function dropSurvivorXp(at: THREE.Vector3, amount: number) {
  if (!scene || amount <= 0) return
  const mesh = new THREE.Mesh(
    new THREE.OctahedronGeometry(0.22, 0),
    new THREE.MeshStandardMaterial({ color: 0x84e8ff, emissive: 0x21a7ec, emissiveIntensity: 1.8, roughness: 0.25, metalness: 0.15 }),
  )
  mesh.position.copy(at).add(new THREE.Vector3(0, 0.65, 0))
  scene.add(mesh)
  xpGems.push({ mesh, value: amount })
}

function gainSurvivorXp(amount: number) {
  player.xp += amount
  pushLog(`You absorb ${amount} experience.`, 'loot')
  let levels = 0
  while (player.xp >= player.xpToLevel && player.level < 60) {
    player.xp -= player.xpToLevel
    player.level += 1
    player.xpToLevel = xpRequired(player.level)
    player.maxHp += 18
    player.maxMana += 12
    player.hp = player.maxHp
    player.mana = player.maxMana
    levels++
    pushLog(`You have reached level ${player.level}!`, 'spawn')
  }
  if (player.level >= 60) player.xp = Math.min(player.xp, player.xpToLevel - 1)
  if (playerEnt) { playerEnt.level = player.level; playerEnt.maxHp = player.maxHp; playerEnt.hp = player.hp }
  if (levels) {
    pendingUpgradeCount += levels
    showNextUpgrade()
  }
}

function showNextUpgrade() {
  if (upgradeChoices.value.length || pendingUpgradeCount <= 0) return
  const shuffled = [...SURVIVOR_UPGRADE_BASE].sort(() => Math.random() - 0.5)
  upgradeChoices.value = shuffled.slice(0, 3).map(({ name, description }) => ({ name, description }))
}

function chooseSurvivorUpgrade(index: number) {
  const selected = upgradeChoices.value[index]
  if (!selected) return
  SURVIVOR_UPGRADE_BASE.find((upgrade) => upgrade.name === selected.name)?.apply()
  upgradeChoices.value = []
  pendingUpgradeCount = Math.max(0, pendingUpgradeCount - 1)
  pushLog(`${selected.name}: ${selected.description}.`, 'spawn')
  showNextUpgrade()
}

// ─── Scene bootstrap ─────────────────────────────────────────────────────────
function buildScene(zoneRoot?: THREE.Group) {
  const container = containerRef.value!
  const w = container.clientWidth, h = container.clientHeight

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0c0a12)
  // Keep the Crushbone backdrop legible near the arena and fade the full zone
  // before its MMO-scale sprawl competes with the survivor play space.
  scene.fog = zoneRoot ? new THREE.Fog(0x0c0a12, 24, 72) : new THREE.Fog(0x0c0a12, 28, 60)

  const aspect = w / h
  camera = new THREE.OrthographicCamera(-viewSize * aspect, viewSize * aspect, viewSize, -viewSize, 0.1, 600)
  camera.position.set(20, 24, 20)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio))
  renderer.setSize(w, h)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  // Zone-mode camera cutaway clips geometry via per-material planes.
  renderer.localClippingEnabled = true
  container.appendChild(renderer.domElement)

  labelRenderer = new CSS2DRenderer()
  labelRenderer.setSize(w, h)
  labelRenderer.domElement.style.position = 'absolute'
  labelRenderer.domElement.style.top = '0'
  labelRenderer.domElement.style.left = '0'
  labelRenderer.domElement.style.pointerEvents = 'none'
  container.appendChild(labelRenderer.domElement)

  // Lighting — warm late-afternoon Norrath. Bright enough that the EQ
  // model textures read clearly under the isometric camera.
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x40341f, 1.45))
  scene.add(new THREE.AmbientLight(0xffffff, 0.35))
  const sun = new THREE.DirectionalLight(0xfff0d2, 1.6)
  sun.position.set(14, 26, 8)
  sun.castShadow = true
  sun.shadow.mapSize.set(2048, 2048)
  sun.shadow.camera.left = -40; sun.shadow.camera.right = 40
  sun.shadow.camera.top = 40; sun.shadow.camera.bottom = -40
  sun.shadow.camera.near = 1; sun.shadow.camera.far = 80
  sun.shadow.bias = -0.0004
  scene.add(sun)
  scene.add(sun.target)
  sunLight = sun

  if (zoneRoot) {
    scene.add(zoneRoot)
    if (arenaMode && loadedZone) buildOpenSurvivorField(zoneRoot)
    return
  }

  // Legacy camp diorama for zones that haven't been converted yet.
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x2e3320, roughness: 1 })
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), groundMat)
  ground.rotation.x = -Math.PI / 2
  ground.receiveShadow = true
  scene.add(ground)

  // Subtle grid so motion reads.
  const grid = new THREE.GridHelper(120, 60, 0x4a5a30, 0x232a16)
  ;(grid.material as THREE.Material).opacity = 0.25
  ;(grid.material as THREE.Material).transparent = true
  grid.position.y = 0.02
  scene.add(grid)

  scatterProps()
  buildCampfire()
}

function buildOpenSurvivorField(zoneRoot: THREE.Group) {
  if (!scene || !loadedZone) return
  const zoneSurface = loadedZone.meshes.find((mesh) => mesh.name.toLowerCase().includes('zone_geo'))
  const sourceMaterials = zoneSurface
    ? (Array.isArray(zoneSurface.material) ? zoneSurface.material : [zoneSurface.material]) as THREE.MeshStandardMaterial[]
    : []
  const eqGround = sourceMaterials.find((material) => /1dirtfloor|dirtplain|clovegrass|grassrock/i.test(material.name))
  let fieldMaterial: THREE.MeshStandardMaterial
  if (eqGround) {
    fieldMaterial = eqGround.clone()
    if (eqGround.map) {
      const texture = eqGround.map.clone()
      texture.wrapS = THREE.RepeatWrapping
      texture.wrapT = THREE.RepeatWrapping
      const tiles = ARENA_FIELD_SIZE / 5
      texture.repeat.set(tiles, tiles)
      texture.offset.set(0, 0)
      texture.center.set(0, 0)
      texture.rotation = 0
      texture.needsUpdate = true
      fieldMaterial.map = texture
    }
    fieldMaterial.color.set(0xffffff)
  } else {
    fieldMaterial = new THREE.MeshStandardMaterial({ color: 0x4b5138, roughness: 1 })
  }
  // Converted zone materials can be missing their original texture after the
  // source zone is hidden. Layer a small, repeatable outdoor ground texture so
  // the arena still reads as earth and grass instead of a flat green plane.
  const groundCanvas = document.createElement('canvas')
  groundCanvas.width = 512
  groundCanvas.height = 512
  const ctx = groundCanvas.getContext('2d')
  if (ctx) {
    ctx.fillStyle = '#56603b'
    ctx.fillRect(0, 0, 512, 512)
    for (let i = 0; i < 1700; i++) {
      const x = Math.random() * 512
      const y = Math.random() * 512
      const r = 2 + Math.random() * 16
      ctx.globalAlpha = 0.08 + Math.random() * 0.2
      ctx.fillStyle = Math.random() < 0.55 ? '#273725' : (Math.random() < 0.5 ? '#a18a59' : '#75814a')
      ctx.beginPath()
      ctx.ellipse(x, y, r * (0.7 + Math.random()), r * (0.35 + Math.random() * 0.5), Math.random() * Math.PI, 0, Math.PI * 2)
      ctx.fill()
    }
    // Fine broken strokes suggest grass without becoming a noisy tiled grid.
    ctx.globalAlpha = 0.3
    for (let i = 0; i < 1300; i++) {
      const x = Math.random() * 512
      const y = Math.random() * 512
      ctx.strokeStyle = Math.random() < 0.5 ? '#85915a' : '#35442c'
      ctx.lineWidth = 1 + Math.random() * 1.5
      ctx.beginPath()
      ctx.moveTo(x, y)
      ctx.lineTo(x + (Math.random() - 0.5) * 5, y - 2 - Math.random() * 6)
      ctx.stroke()
    }
    ctx.globalAlpha = 1
    const groundTexture = new THREE.CanvasTexture(groundCanvas)
    groundTexture.wrapS = THREE.RepeatWrapping
    groundTexture.wrapT = THREE.RepeatWrapping
    groundTexture.repeat.set(ARENA_FIELD_SIZE / 14, ARENA_FIELD_SIZE / 14)
    groundTexture.colorSpace = THREE.SRGBColorSpace
    groundTexture.anisotropy = renderer?.capabilities.getMaxAnisotropy() ?? 1
    groundTexture.needsUpdate = true
    fieldMaterial.map = groundTexture
    fieldMaterial.color.set(0xffffff)
  }
  fieldMaterial.side = THREE.DoubleSide
  fieldMaterial.roughness = 1
  fieldMaterial.metalness = 0

  // Survivors play space: one wide, flat, walkable field. The selected zone's
  // authentic EQ dirt/grass material supplies its visual identity; the MMO
  // buildings, hills, and collision clutter are intentionally left out.
  const field = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_FIELD_SIZE, ARENA_FIELD_SIZE), fieldMaterial)
  field.name = 'norrath_survivor_field'
  field.rotation.x = -Math.PI / 2
  field.position.set(arenaCenter.x, arenaCenter.y - 0.06, arenaCenter.z)
  field.receiveShadow = true
  field.updateWorldMatrix(true, false)
  ;(field.geometry as any).computeBoundsTree?.()
  scene.add(field)
  scatterArenaDetails()

  // Keep the converted assets loaded for their authentic zone texture and
  // data, but don't draw or collide with the source MMO layout during a run.
  zoneRoot.visible = false
  loadedZone.meshes = [field]
  loadedZone.waterMeshes = []
  loadedZone.ladderMeshes = []
  loadedZone.bounds = new THREE.Box3().setFromObject(field)
}

/** Zone dressing around the combat space: keep the center clear and frame the arena with EQ-style terrain details. */
function scatterArenaDetails() {
  if (!scene) return
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x49321e, roughness: 1 })
  const pineMat = new THREE.MeshStandardMaterial({ color: 0x34442b, roughness: 1, flatShading: true })
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x52603a, roughness: 1, flatShading: true })
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x77715f, roughness: 1, flatShading: true })
  const grassMat = new THREE.MeshStandardMaterial({ color: 0x7e8950, roughness: 1, side: THREE.DoubleSide })
  for (let i = 0; i < 76; i++) {
    const a = Math.random() * Math.PI * 2
    const r = 20 + Math.random() * 86
    const x = arenaCenter.x + Math.cos(a) * r
    const z = arenaCenter.z + Math.sin(a) * r
    const edgeScale = THREE.MathUtils.smoothstep(r, 24, 44)
    const choice = Math.random()
    if (choice < 0.33) {
      const s = (0.35 + Math.random() * 1.1) * (0.65 + edgeScale * 0.5)
      const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), stoneMat)
      rock.position.set(x, s * 0.42, z)
      rock.rotation.set(Math.random() * 0.5, Math.random() * Math.PI, Math.random() * 0.4)
      rock.castShadow = true
      scene.add(rock)
    } else if (choice < 0.57 && r > 34) {
      const tree = new THREE.Group()
      const h = 4 + Math.random() * 4
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.42, h * 0.48, 7), trunkMat)
      trunk.position.y = h * 0.24
      const canopy = new THREE.Mesh(new THREE.ConeGeometry(1.5 + Math.random(), h * 0.78, 7), pineMat)
      canopy.position.y = h * 0.68
      trunk.castShadow = canopy.castShadow = true
      tree.add(trunk, canopy)
      tree.position.set(x, 0, z)
      tree.rotation.y = Math.random() * Math.PI
      scene.add(tree)
    } else {
      const tuft = new THREE.Group()
      const blades = 3 + Math.floor(Math.random() * 4)
      for (let j = 0; j < blades; j++) {
        const blade = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.65 + Math.random() * 0.5, 4), Math.random() < 0.5 ? grassMat : leafMat)
        blade.position.set((Math.random() - 0.5) * 0.55, 0.24, (Math.random() - 0.5) * 0.55)
        blade.rotation.z = (Math.random() - 0.5) * 0.6
        tuft.add(blade)
      }
      tuft.position.set(x, 0, z)
      scene.add(tuft)
    }
  }
}

/** Low-poly rocks + conifers for depth around the camp. */
function scatterProps() {
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x3a3a40, roughness: 1, flatShading: true })
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x3a2616, roughness: 1 })
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x223016, roughness: 1, flatShading: true })
  for (let i = 0; i < 46; i++) {
    const a = Math.random() * Math.PI * 2
    const r = 10 + Math.random() * 34
    const x = Math.cos(a) * r, z = Math.sin(a) * r
    if (Math.random() < 0.5) {
      const s = 0.5 + Math.random() * 1.4
      const rock = new THREE.Mesh(new THREE.IcosahedronGeometry(s, 0), rockMat)
      rock.position.set(x, s * 0.45, z)
      rock.rotation.set(Math.random(), Math.random(), Math.random())
      rock.castShadow = true; rock.receiveShadow = true
      scene!.add(rock)
    } else {
      const tree = new THREE.Group()
      const th = 2.4 + Math.random() * 2.2
      const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, th * 0.5, 6), trunkMat)
      trunk.position.y = th * 0.25
      const cone = new THREE.Mesh(new THREE.ConeGeometry(1.1 + Math.random() * 0.4, th, 7), leafMat)
      cone.position.y = th * 0.5 + th * 0.35
      trunk.castShadow = true; cone.castShadow = true
      tree.add(trunk); tree.add(cone)
      tree.position.set(x, 0, z)
      scene!.add(tree)
    }
  }
}

let fireLight: THREE.PointLight | null = null
function buildCampfire() {
  const grp = new THREE.Group()
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 1, flatShading: true })
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2
    const stone = new THREE.Mesh(new THREE.DodecahedronGeometry(0.28, 0), stoneMat)
    stone.position.set(Math.cos(a) * 0.8, 0.14, Math.sin(a) * 0.8)
    stone.castShadow = true
    grp.add(stone)
  }
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.4, 0.9, 8),
    new THREE.MeshStandardMaterial({ color: 0xff7a1e, emissive: 0xff5a10, emissiveIntensity: 2, roughness: 1 }),
  )
  flame.position.y = 0.5
  grp.add(flame)
  fireLight = new THREE.PointLight(0xff8a30, 6, 16, 2)
  fireLight.position.set(0, 1.1, 0)
  grp.add(fireLight)
  scene!.add(grp)
}

// ─── Targeting ───────────────────────────────────────────────────────────────
function targetEnt(): Combatant | null {
  if (targetId == null) return null
  return enemies.find((e) => e.id === targetId) ?? null
}
function setTarget(id: number | null) {
  if (targetId === id) return
  targetId = id
  const t = targetEnt()
  if (t) pushLog(`You consider ${t.name}.`, 'sys')
  refreshTargetView()
}
function tabTarget() {
  if (player.dead) return
  const alive = enemies.filter((e) => e.alive)
  if (!alive.length) { setTarget(null); return }
  alive.sort((a, b) => dist2D(a.root.position.x, a.root.position.z, playerEnt!.root.position.x, playerEnt!.root.position.z)
                     - dist2D(b.root.position.x, b.root.position.z, playerEnt!.root.position.x, playerEnt!.root.position.z))
  if (targetId == null) { setTarget(alive[0].id); return }
  const idx = alive.findIndex((e) => e.id === targetId)
  setTarget(alive[(idx + 1) % alive.length].id)
}

const raycaster = new THREE.Raycaster()
const ndc = new THREE.Vector2()
function onCanvasClick(ev: MouseEvent) {
  if (!renderer || !camera) return
  const rect = renderer.domElement.getBoundingClientRect()
  ndc.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  ndc.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  raycaster.setFromCamera(ndc, camera)
  let best: { id: number; d: number } | null = null
  for (const e of enemies) {
    if (!e.alive) continue
    const hits = raycaster.intersectObjects(e.meshes, true)
    if (hits.length && (!best || hits[0].distance < best.d)) best = { id: e.id, d: hits[0].distance }
  }

  // Where the click lands on the ground (used for click-to-move AND for
  // generous mob selection — the models are small, so a precise mesh hit
  // isn't required: clicking near a mob's feet selects it like an ARPG).
  // Real zones raycast the terrain mesh; the camp diorama uses the y=0 plane.
  const groundPt = new THREE.Vector3()
  let hasGround: boolean
  if (zoneMode && loadedZone) {
    const hit = raycaster.intersectObjects(loadedZone.meshes, false)[0]
    hasGround = !!hit
    if (hit) groundPt.copy(hit.point)
  } else {
    hasGround = !!raycaster.ray.intersectPlane(groundPlane, groundPt)
  }
  if (!best && hasGround) {
    let near: { id: number; d: number } | null = null
    for (const e of enemies) {
      if (!e.alive) continue
      const d = dist2D(groundPt.x, groundPt.z, e.root.position.x, e.root.position.z)
      if (d < 1.6 && (!near || d < near.d)) near = { id: e.id, d }
    }
    if (near) best = { id: near.id, d: 0 }
  }

  if (best) {
    // Clicked (or clicked near) a mob: always target it. In click mode, also
    // walk to it and engage (Diablo-style click-to-attack).
    setTarget(best.id)
    if (controlMode.value === 'click') { clickFollowId = best.id; moveTarget.value = null }
    return
  }

  if (controlMode.value === 'click') {
    // Clicked open ground: set a walk destination.
    if (hasGround) { moveTarget.value = { x: groundPt.x, z: groundPt.z }; clickFollowId = null }
  } else {
    // WASD mode: an empty click clears the target.
    setTarget(null)
  }
}

function refreshTargetView() {
  const t = targetEnt()
  if (!t || !t.alive) { targetView.value = null; return }
  const cc = conColor(player.level, t.level)
  targetView.value = {
    id: t.id, name: t.name, level: t.level, hp: Math.max(0, Math.ceil(t.hp)), maxHp: t.maxHp,
    conText: CON_DISPLAY[cc].text, conColor: CON_DISPLAY[cc].color,
    dist: dist2D(t.root.position.x, t.root.position.z, playerEnt!.root.position.x, playerEnt!.root.position.z),
    isNamed: t.isNamed,
  }
}

// ─── Combat ──────────────────────────────────────────────────────────────────
function inMelee(a: Combatant, b: Combatant) {
  return dist2D(a.root.position.x, a.root.position.z, b.root.position.x, b.root.position.z) <= MELEE_RANGE
}
/** Play a one-shot melee clip and lock the rig for its length so the
 *  locomotion state machine doesn't yank it back to walk/idle mid-swing. */
function combatAnimOnce(ent: Combatant, want: 'attack', cap = 1400) {
  const prefix = clipFor(ent.actions, want)
  if (prefix) {
    play(ent, want, { loop: false, fade: 0.06 })
    const dur = ent.actions[prefix]?.getClip().duration || 0.6
    ent.busyUntil = nowMs.value + Math.min(cap, Math.max(350, dur * 1000))
  } else {
    // No combat clip on this rig (capsule fallback, unaudited model) —
    // the lunge nudge guarantees every attack still reads visually.
    lunge(ent)
  }
}

function playerAutoAttack() {
  if (!autoAttack.value || player.dead || !playerEnt || !survivorMobPool.length) return
  const p = playerEnt.root.position
  let t = targetEnt()
  if (!t?.alive || dist2D(t.root.position.x, t.root.position.z, p.x, p.z) > spellRange) {
    t = enemies
      .filter((e) => e.alive && dist2D(e.root.position.x, e.root.position.z, p.x, p.z) <= spellRange)
      .sort((a, b) => dist2D(a.root.position.x, a.root.position.z, p.x, p.z) - dist2D(b.root.position.x, b.root.position.z, p.x, p.z))[0] ?? null
    setTarget(t?.id ?? null)
  }
  if (!t?.alive || nowMs.value < survivorSpellReadyAt) return
  survivorSpellReadyAt = nowMs.value + spellCooldownMs
  faceToward(playerEnt, t.root.position.x, t.root.position.z)
  for (let n = 0; n < spellCount; n++) fireSurvivorSpell(t, n)
}

function enemyAttack(e: Combatant) {
  if (!e.alive || player.dead) return
  if (!inMelee(e, playerEnt!)) return
  if (nowMs.value < e.lastAttackAt + e.attackDelayMs) return
  e.lastAttackAt = nowMs.value
  faceToward(e, playerEnt!.root.position.x, playerEnt!.root.position.z)
  // Swing animation; busyUntil keeps the AI from yanking it back to a
  // walk/idle clip until the swing finishes (it then returns to idle since
  // the mob is standing in melee, not moving).
  combatAnimOnce(e, 'attack', 1200)
  // AC raises your dodge/parry chance a touch and mitigates the hit.
  const ac = player.level * 2
  const avoid = Math.min(20, ac / 25)
  const mr = (e.level >= 10 ? 70 : 78) - avoid
  if (Math.random() * 100 > mr) { pushLog(`${capitalize(e.name)} tries to hit YOU, but misses!`, 'them'); return }
  const mitig = Math.min(0.6, ac / (ac + 220))
  const dmg = Math.max(1, Math.round(roll(e.minDmg, e.maxDmg) * (1 - mitig)))
  player.hp = Math.max(0, player.hp - dmg)
  pushLog(`${capitalize(e.name)} hits YOU for ${dmg} points of damage.`, 'them')
  if (player.hp <= 0) onPlayerDeath(e)
}

function killEnemy(e: Combatant) {
  e.alive = false
  e.hp = 0
  e.aggro = false
  play(e, 'death', { loop: false })
  e.label.visible = false
  pushLog(`You have slain ${e.name}!`, 'death')
  if (targetId === e.id) { targetId = null; targetView.value = null }
  awardKill(e)
  const deadId = e.id
  window.setTimeout(() => {
    const index = enemies.findIndex((candidate) => candidate.id === deadId)
    if (index >= 0) {
      scene?.remove(e.root)
      enemies.splice(index, 1)
    }
  }, 2800)
}

function awardKill(e: Combatant) {
  const cc = conColor(player.level, e.level)
  const conMul: Record<string, number> = { red: 1.6, yellow: 1.3, white: 1, blue: 0.7, green: 0.15, gray: 0 }
  // `xpValue` is the raw EQ award (roughly level²), while this run uses a
  // much steeper survivor level curve. Keep each orb as progress toward a
  // level instead of letting a single classic EQ kill level the player.
  const xp = Math.max(1, Math.round(e.xpValue * (conMul[cc] ?? 1) * 0.1))
  runKills.value += 1
  dropSurvivorXp(e.root.position, xp)
}

function onPlayerDeath(killer: Combatant) {
  player.dead = true
  player.hp = 0
  pushLog('You have been slain by ' + killer.name + '!', 'death')
  if (playerEnt) {
    if (clipFor(playerEnt.actions, 'death')) {
      play(playerEnt, 'death', { loop: false })
      playerEnt.busyUntil = nowMs.value + 3200
    } else {
      tipOver(playerEnt, true)
    }
  }
  window.setTimeout(() => { runOver.value = true }, 2400)
}

// ─── Facing / lunge / death-tilt for models without those clips ──────────────
function faceToward(ent: Combatant, tx: number, tz: number) {
  const dx = tx - ent.root.position.x, dz = tz - ent.root.position.z
  if (dx === 0 && dz === 0) return
  ent.facing = Math.atan2(dx, dz) + ent.yawOffset
}
function lunge(ent: Combatant) { ent.lungeUntil = nowMs.value + 220 }
function tipOver(ent: Combatant, down: boolean) {
  ent.root.rotation.x = down ? -Math.PI / 2.2 : 0
}

// ─── Input ───────────────────────────────────────────────────────────────────
const MOVE_KEYS = ['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']
function onKeyDown(e: KeyboardEvent) {
  const k = e.key.toLowerCase()
  if (k === 'escape') {
    if (upgradeChoices.value.length) return
    togglePause()
    e.preventDefault()
    return
  }
  if (paused.value) return
  if (upgradeChoices.value.length) {
    if (k === '1' || k === '2' || k === '3') chooseSurvivorUpgrade(Number(k) - 1)
    e.preventDefault()
    return
  }
  if (runOver.value) {
    if (k === 'r' || k === 'enter') window.location.reload()
    return
  }
  if (MOVE_KEYS.includes(k)) { keys[k] = true; e.preventDefault() }
  if (k === 't') autoAttack.value = !autoAttack.value
  if (k === 'm') toggleControlMode()
  if (k === 'home') resetCamera()
  if (k === ' ' || k === 'spacebar') { jumpQueued = true; e.preventDefault() }
  if (k === 'tab') { tabTarget(); e.preventDefault() }
  if (k === 'f') useLift()
}
/** Flip the nearest lift switch (Kelethin lifts) when standing by it. */
function useLift() {
  if (!zoneMode || !loadedZone || !playerEnt) return
  const p = playerEnt.root.position
  const hit = liftSwitchAt(loadedZone.lifts, p.x, p.y, p.z)
  if (hit) {
    toggleLift(hit.lift, hit.sw.end)
    pushLog(`You pull the lever — the lift ${hit.lift.target === 'up' ? 'rises' : 'lowers'}.`, 'spawn')
  }
}
function toggleControlMode() {
  controlMode.value = controlMode.value === 'wasd' ? 'click' : 'wasd'
  moveTarget.value = null
  clickFollowId = null
  pushLog(controlMode.value === 'click'
    ? 'Click-to-move enabled — click the ground to walk, click a foe to attack.'
    : 'Keyboard movement enabled — WASD / arrows to move.', 'sys')
}
function onKeyUp(e: KeyboardEvent) { const k = e.key.toLowerCase(); if (k in keys) keys[k] = false }

function inputVector(out: THREE.Vector3) {
  // Camera-relative on the ground plane.
  camForward.set(camTarget.x - camera!.position.x, 0, camTarget.z - camera!.position.z).normalize()
  camRight.crossVectors(camForward, new THREE.Vector3(0, 1, 0)).normalize()
  out.set(0, 0, 0)
  if (keys['w'] || keys['arrowup']) out.add(camForward)
  if (keys['s'] || keys['arrowdown']) out.sub(camForward)
  if (keys['a'] || keys['arrowleft']) out.sub(camRight)
  if (keys['d'] || keys['arrowright']) out.add(camRight)
  if (out.lengthSq() > 0) out.normalize()
  return out
}

// ─── Frame loop ──────────────────────────────────────────────────────────────
let blipThrottle = 0
function frame() {
  raf = requestAnimationFrame(frame)
  const dt = Math.min(0.05, clock.getDelta())
  nowMs.value = performance.now()
  if (runStartedAt > 0 && !paused.value) runSeconds.value = Math.floor((nowMs.value - runStartedAt) / 1000)
  if (upgradeChoices.value.length || runOver.value || paused.value) {
    if (renderer && scene && camera) renderer.render(scene, camera)
    if (labelRenderer && scene && camera) labelRenderer.render(scene, camera)
    return
  }

  // Player movement.
  if (playerEnt && !player.dead) {
    const busy = nowMs.value < playerEnt.busyUntil
    const px = playerEnt.root.position.x, pz = playerEnt.root.position.z

    // Jump launch: from solid ground only (not swimming/climbing/airborne).
    if (jumpQueued) {
      jumpQueued = false
      if (zoneMode && loadedZone && !airborne && !swimming.value && !climbTarget) {
        vy = JUMP_SPEED; airborne = true
      }
    }

    // Resolve a movement intent from the active control scheme.
    let mvx = 0, mvz = 0, moving = false
    if (controlMode.value === 'wasd') {
      inputVector(tmpV)
      if (tmpV.lengthSq() > 0) { mvx = tmpV.x; mvz = tmpV.z; moving = true }
    } else {
      // Click-to-move: head for the clicked enemy (until in melee) or the
      // clicked ground point.
      let destX: number | null = null, destZ: number | null = null, stop = 0.25
      if (clickFollowId != null) {
        const t = enemies.find((e) => e.id === clickFollowId)
      if (t && t.alive) { destX = t.root.position.x; destZ = t.root.position.z; stop = spellRange * 0.8 }
        else { clickFollowId = null }
      } else if (moveTarget.value) {
        destX = moveTarget.value.x; destZ = moveTarget.value.z
      }
      if (destX != null && destZ != null) {
        const dx = destX - px, dz = destZ - pz
        const dist = Math.hypot(dx, dz)
        if (dist > stop) { mvx = dx / dist; mvz = dz / dist; moving = true }
        else if (clickFollowId == null) moveTarget.value = null   // reached ground point
      }
    }

    if (moving) {
      const pos = playerEnt.root.position
      const prevX = pos.x, prevZ = pos.z, prevY = pos.y

      // Let go of a committed climb when pressing away from the ledge (drop
      // back down); otherwise grab a ladder ahead and commit to its ledge.
      // (No ladder grabbing mid-jump.)
      if (climbTarget && (mvx * (climbTarget.x - pos.x) + mvz * (climbTarget.z - pos.z)) < -0.1) {
        climbTarget = null
      } else if (!airborne && zoneMode && loadedZone && !climbTarget
          && ladderAhead(loadedZone.ladderMeshes, pos, mvx, mvz)) {
        climbTarget = findLedge(loadedZone.meshes, pos, mvx, mvz)
      }

      // ── Climb: rise straight up the ladder, then step onto the ledge ────
      if (climbTarget && loadedZone) {
        climbing.value = true; swimming.value = false
        pos.y += CLIMB_RISE * dt          // vertical only — no horizontal drift
        // Reached ledge height → step forward onto the ledge and finish.
        if (pos.y >= climbTarget.y - 0.15) {
          pos.copy(climbTarget)
          climbing.value = false
          climbTarget = null
        }
      } else {
        climbing.value = false
        const speed = MOVE_SPEED * moveSpeedMultiplier * (swimming.value ? SWIM_SPEED_MUL : 1)
        let stepX = mvx * speed * dt
        let stepZ = mvz * speed * dt
        // Wall/prop collision (zone mode): block or slide along walls, crates,
        // trees, ladders. Walkable slopes pass through.
        if (zoneMode && loadedZone) {
          const slid = collideSlide(loadedZone.meshes, pos, stepX, stepZ)
          stepX = slid.dx; stepZ = slid.dz
        }
        pos.x += stepX
        pos.z += stepZ
        clampToArena(pos)

        // ── Vertical: airborne physics, else swim/ground snap ───────────────
        if (airborne) {
          applyAirborne(dt)
        } else if (zoneMode && loadedZone) {
          const surf = waterSurface(loadedZone.waterMeshes, pos.x, pos.z)
          const g = groundHeight(loadedZone.meshes, pos.x, pos.z, pos.y)
          if (surf !== null && (g === null || surf - g > SWIM_MIN_DEPTH)) {
            swimming.value = true
            pos.y = surf - SWIM_SUBMERGE
          } else if (g !== null) {
            swimming.value = false
            pos.y = g
          } else {
            pos.x = prevX; pos.z = prevZ; pos.y = prevY   // off-mesh — revert
          }
        }
      }
      // Face the intended direction even when sliding, so turning reads right.
      playerEnt.facing = Math.atan2(mvx, mvz) + playerEnt.yawOffset
      if (!busy) {
        play(playerEnt, airborne ? 'jump' : climbing.value ? 'climb'
          : swimming.value ? 'swim' : 'walk', { loop: true })
      }
    } else {
      // Standing still. Still apply jump/fall physics if airborne.
      if (airborne) applyAirborne(dt)
      const tgt = targetEnt()
      if (tgt && tgt.alive) faceToward(playerEnt, tgt.root.position.x, tgt.root.position.z)
      if (!busy) {
        play(playerEnt, airborne ? 'jump' : climbing.value ? 'climb'
          : swimming.value ? 'tread' : 'idle', { loop: true })
      }
    }
  }

  // Kelethin lifts: animate platforms; carry the player when standing on one.
  if (zoneMode && loadedZone && loadedZone.lifts.length) {
    const p = playerEnt?.root.position
    let nearSwitch = false
    for (const lift of loadedZone.lifts) {
      const dy = updateLift(lift, dt)
      if (dy !== 0 && p && onLift(lift, p.x, p.z, p.y)) p.y += dy
    }
    if (p && liftSwitchAt(loadedZone.lifts, p.x, p.y, p.z)) nearSwitch = true
    liftHint.value = nearSwitch
  }

  // Enemy AI.
  if (playerEnt) {
    const px = playerEnt.root.position.x, pz = playerEnt.root.position.z
    for (const e of enemies) {
      if (!e.alive) continue
      const d = dist2D(e.root.position.x, e.root.position.z, px, pz)
      // Freeze + hide far mobs (big welded worlds) — skip all AI/animation.
      if (d > ACTIVE_RANGE) {
        if (e.root.visible) e.root.visible = false
        continue
      }
      if (!e.root.visible) e.root.visible = true
      if (!player.dead && d < AGGRO_RANGE) {
        if (!e.aggro) { e.aggro = true; pushLog(`${capitalize(e.name)} glares and charges!`, 'spawn') }
      }
      const homeD = dist2D(e.root.position.x, e.root.position.z, e.homeX, e.homeZ)
      if (!arenaMode && e.aggro && homeD > LEASH_RANGE) { e.aggro = false }

      if (e.aggro && !player.dead) {
        // Always square up to the player while engaged — whether chasing or
        // toe-to-toe in melee.
        faceToward(e, px, pz)
      }

      const busy = nowMs.value < e.busyUntil
      if (e.aggro && !player.dead && d > MELEE_RANGE) {
        // Chasing.
        const dx = px - e.root.position.x, dz = pz - e.root.position.z
        const len = Math.hypot(dx, dz) || 1
        e.root.position.x += (dx / len) * ENEMY_SPEED * dt
        e.root.position.z += (dz / len) * ENEMY_SPEED * dt
        clampToArena(e.root.position)
        snapToGround(e)
        if (!busy) play(e, e.swimming ? 'swim' : 'walk', { loop: true })
      } else if (e.aggro && !player.dead) {
        // In melee, standing — idle between swings (tread if in water).
        if (!busy) play(e, e.swimming ? 'tread' : 'idle', { loop: true })
      } else if (!e.aggro) {
        // drift home
        if (homeD > 0.3) {
          const dx = e.homeX - e.root.position.x, dz = e.homeZ - e.root.position.z
          const len = Math.hypot(dx, dz) || 1
          e.root.position.x += (dx / len) * ENEMY_SPEED * 0.5 * dt
          e.root.position.z += (dz / len) * ENEMY_SPEED * 0.5 * dt
          clampToArena(e.root.position)
          snapToGround(e)
          e.facing = Math.atan2(dx, dz) + e.yawOffset
          if (!busy) play(e, e.swimming ? 'swim' : 'walk', { loop: true })
        } else if (!busy) {
          play(e, e.swimming ? 'tread' : 'idle', { loop: true })
        }
      }
      if (e.aggro) enemyAttack(e)
    }
  }

  playerAutoAttack()
  updateSurvivorBolts(dt)
  updateXpGems(dt)
  if (survivorMobPool.length && nowMs.value >= nextWaveAt) {
    waveNumber.value += 1
    nextWaveAt = nowMs.value + Math.max(8_000, 22_000 - waveNumber.value * 650)
    pushLog(`Wave ${waveNumber.value} approaches!`, 'death')
    void spawnSurvivorWave(Math.min(6 + waveNumber.value * 2, 18))
  }

  // Smooth facing + lunge offset, mixers, hp bars.
  if (playerEnt) updateEntityVisual(playerEnt, dt)
  for (const e of enemies) if (e.root.visible) updateEntityVisual(e, dt)

  // Campfire flicker.
  if (fireLight) fireLight.intensity = 5 + Math.sin(nowMs.value * 0.012) * 1.4 + Math.random() * 0.5

  // Camera follow (terrain-aware) on the orbit sphere — yaw/pitch from
  // right-drag, ortho zoom from the wheel.
  if (playerEnt && camera) {
    camTarget.lerp(playerEnt.root.position, 0.12)
    const cp = Math.cos(camPitch), sp = Math.sin(camPitch)
    camera.position.set(
      camTarget.x + CAM_DIST * cp * Math.sin(camYaw),
      camTarget.y + CAM_DIST * sp,
      camTarget.z + CAM_DIST * cp * Math.cos(camYaw),
    )
    camera.lookAt(camTarget)
    // Keep the shadow sun centred on the action in big zones.
    if (zoneMode && sunLight) {
      sunLight.position.set(camTarget.x + 14, camTarget.y + 26, camTarget.z + 8)
      sunLight.target.position.copy(camTarget)
    }
  }

  // Camera cutaway: slice away anything between the camera and the player
  // (hillsides, roofs, canopy) so the view is never buried. Every frame —
  // it's just a plane update.
  if (zoneMode && !arenaMode && playerEnt && camera) {
    cameraCutaway.update(camera, playerEnt.root.position)
  }

  // HUD sync (throttled bits).
  blipThrottle += dt
  if (blipThrottle > 0.1) {
    blipThrottle = 0
    syncMinimap()
    if (targetView.value) refreshTargetView()
    if (zoneMode && playerEnt) {
      const p = playerEnt.root.position
      locText.value = `world ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)}`
      // Welded worlds span multiple zones — keep the banner in step with which
      // one the player is actually standing in.
      if (loadedZone && loadedZone.parts.length > 1) {
        const here = zoneIdAt(loadedZone.meshes, p.x, p.z, p.y)
        if (here) {
          const nm = ZONE_BY_ID[here]?.name ?? here
          if (nm !== zoneName.value) zoneName.value = nm
        }
      }
    }
  }
  player.hp = player.hp // reactive touch no-op; hp set directly elsewhere

  renderer!.render(scene!, camera!)
  labelRenderer!.render(scene!, camera!)
}

function updateEntityVisual(ent: Combatant, dt: number) {
  if (ent.mixer) ent.mixer.update(dt)
  // ease facing
  let diff = ent.facing - ent.root.rotation.y
  while (diff > Math.PI) diff -= Math.PI * 2
  while (diff < -Math.PI) diff += Math.PI * 2
  ent.root.rotation.y += diff * Math.min(1, dt * 12)
  // lunge: nudge model child forward briefly
  const model = ent.root.children.find((c) => !(c as unknown as { isCSS2DObject?: boolean }).isCSS2DObject) as THREE.Object3D | undefined
  if (model) {
    const want = nowMs.value < ent.lungeUntil ? 0.45 : 0
    model.position.z += (want - model.position.z) * Math.min(1, dt * 16)
  }
  // hp bar
  const pct = Math.max(0, Math.min(1, ent.kind === 'player' ? player.hp / player.maxHp : ent.hp / ent.maxHp))
  ent.hpFill.style.width = (pct * 100) + '%'
  if (ent.kind === 'enemy') {
    const targeted = ent.id === targetId
    ent.label.element.classList.toggle('tg-np-target', targeted)
  }
}

const MINI_HALF = 24
function syncMinimap() {
  if (!playerEnt) return
  // The survivor run uses a tight arena map even though its terrain comes from EQ.
  let toN: (x: number, z: number) => [number, number]
  if (arenaMode) {
    toN = (x, z) => [
      clamp01((x - arenaCenter.x + ARENA_RADIUS) / (ARENA_RADIUS * 2)),
      clamp01((z - arenaCenter.z + ARENA_RADIUS) / (ARENA_RADIUS * 2)),
    ]
  } else if (zoneMode && loadedZone) {
    const b = loadedZone.bounds
    const sx = Math.max(1e-6, b.max.x - b.min.x)
    const sz = Math.max(1e-6, b.max.z - b.min.z)
    toN = (x, z) => [clamp01((x - b.min.x) / sx), clamp01((z - b.min.z) / sz)]
  } else {
    toN = (x, z) => [clamp01((x + MINI_HALF) / (MINI_HALF * 2)), clamp01((z + MINI_HALF) / (MINI_HALF * 2))]
  }
  ;[playerBlip.nx, playerBlip.nz] = toN(playerEnt.root.position.x, playerEnt.root.position.z)
  miniBlips.value = enemies.map((e) => {
    const [nx, nz] = toN(e.root.position.x, e.root.position.z)
    return { id: e.id, alive: e.alive, targeted: e.id === targetId, nx, nz }
  })
}
function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v }

// ─── Resize ──────────────────────────────────────────────────────────────────
function onResize() {
  if (!renderer || !camera || !labelRenderer || !containerRef.value) return
  const w = containerRef.value.clientWidth, h = containerRef.value.clientHeight
  const aspect = w / h
  camera.left = -viewSize * aspect; camera.right = viewSize * aspect
  camera.top = viewSize; camera.bottom = -viewSize
  camera.updateProjectionMatrix()
  renderer.setSize(w, h)
  labelRenderer.setSize(w, h)
}

/** Recompute the ortho frustum from `viewSize` (zoom) at the current aspect. */
function applyZoom() {
  if (!camera || !containerRef.value) return
  const aspect = containerRef.value.clientWidth / containerRef.value.clientHeight
  camera.left = -viewSize * aspect; camera.right = viewSize * aspect
  camera.top = viewSize; camera.bottom = -viewSize
  camera.updateProjectionMatrix()
}

// ─── Camera orbit (right-drag) + zoom (wheel) ─────────────────────────────────
function onContextMenu(e: MouseEvent) { e.preventDefault() }
function onPointerDown(e: PointerEvent) {
  if (e.button !== 2) return            // right button only
  orbiting = true
  lastPointerX = e.clientX; lastPointerY = e.clientY
  renderer?.domElement.setPointerCapture(e.pointerId)
  e.preventDefault()
}
function onPointerMove(e: PointerEvent) {
  if (!orbiting) return
  const dx = e.clientX - lastPointerX, dy = e.clientY - lastPointerY
  lastPointerX = e.clientX; lastPointerY = e.clientY
  camYaw -= dx * ORBIT_YAW_SPEED
  camPitch = Math.min(PITCH_MAX, Math.max(PITCH_MIN, camPitch - dy * ORBIT_PITCH_SPEED))
}
function onPointerUp(e: PointerEvent) {
  if (e.button !== 2) return
  orbiting = false
  renderer?.domElement.releasePointerCapture(e.pointerId)
}
function onWheel(e: WheelEvent) {
  e.preventDefault()
  // Wheel up (deltaY<0) zooms in (smaller frustum). ~12% per notch.
  viewSize = Math.min(VIEW_MAX, Math.max(VIEW_MIN, viewSize * (e.deltaY > 0 ? 1.12 : 0.89)))
  applyZoom()
}
/** Reset to the default iso framing (bound to the on-screen control + Home). */
function resetCamera() {
  camYaw = Math.PI / 4
  camPitch = 0.703
  viewSize = 6.5
  applyZoom()
}

// ─── Zone / camp selection from real data ────────────────────────────────────
// ─── Lifecycle ───────────────────────────────────────────────────────────────
onMounted(async () => {
  try {
    await gd.ready()
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
    return
  }

  // These local-only textures were converted from the P99 SpellEffects DDS
  // atlases. Keep the run playable with the lightweight fallback if absent.
  await loadSurvivorSpellTextures().catch((e) => console.warn('EQ spell textures unavailable; using fallback bolt.', e))

  // Use the converted zone only as this arena's art and mob source. Loading a
  // single zone avoids pulling its whole welded travel world into the run.
  const zoneId = String(useRoute().query.zone ?? '') || 'crushbone'
  loadedZone = await loadZone(zoneId)
  if (!loadedZone) {
    loadError.value = `The converted ${zoneId} zone could not be loaded.`
    return
  }
  const spawnDoc = await fetch(publicPath(`/gamedata/spawns/${zoneId}.json`))
    .then((r) => (r.ok ? r.json() : null)).catch(() => null)
  const spawnPoints: SpawnPoint[] = spawnDoc?.data ?? []
  if (!spawnPoints.length) {
    loadError.value = `No real ${zoneId} spawn data is available.`
    return
  }
  zoneMode = true
  arenaMode = true
  zoneName.value = ZONE_BY_ID[zoneId]?.name ?? zoneId
  loadingMsg.value = `Preparing the ${zoneName.value} survivor arena…`

  // Crushbone's forge camp has a tight cluster of real forge, anvil, lantern,
  // and orc props. Center the run there instead of at the far-away safe point.
  const arenaSpawn = zoneId === 'crushbone'
    ? spawnPoints.find((point) => point.id === 6)
    : null
  const start = arenaSpawn
    ? serverToWorld(arenaSpawn.x, arenaSpawn.y, arenaSpawn.z)
    : spawnDoc?.meta?.safe
      ? serverToWorld(spawnDoc.meta.safe.x, spawnDoc.meta.safe.y, spawnDoc.meta.safe.z)
      : serverToWorld(spawnPoints[0].x, spawnPoints[0].y, spawnPoints[0].z)
  const centerY = groundHeight(loadedZone.meshes, start.x, start.z, start.y + 12)
  arenaCenter.set(start.x, centerY ?? start.y, start.z)

  // Mob appearance (race/gender/size → model) backs resolveModel; load it
  // before spawning anything. Cheap (~13k tiny rows) and cached by the
  // browser. Best-effort — resolveModel falls back to name keywords.
  mobAppearance = await fetch(publicPath('/gamedata/mob_appearance.json'))
    .then((r) => (r.ok ? r.json() : null)).then((j) => j?.data ?? {}).catch(() => ({}))

  await nextTick()
  buildScene(loadedZone.root)
  if (!arenaMode) cameraCutaway.attach(loadedZone.meshes)

  // Spawn at the edge of the forge yard, with all initial enemies entering
  // from the survivor-arena perimeter.
  const playerX = arenaCenter.x
  const playerZ = arenaCenter.z + 3
  const playerY = groundHeight(loadedZone.meshes, playerX, playerZ, arenaCenter.y + 12) ?? arenaCenter.y
  playerSpawnPos.set(playerX, playerY, playerZ)
  await makePlayer(playerX, playerZ, playerY)
  camTarget.copy(playerEnt!.root.position)

  const poolIds = new Set<string>()
  for (const point of spawnPoints) {
    for (const entry of point.entries) poolIds.add(entry.mobId)
  }
  survivorMobPool = [...poolIds]
    .map((id) => MOB_BY_ID[id])
    .filter((mob): mob is Mob => !!mob && !mob.isNamed && mob.level <= 12 && !!resolveModel(mob).code)
  if (!survivorMobPool.length) {
    loadError.value = 'No modeled survivor enemies are available in ' + zoneName.value + '.'
    return
  }
  await spawnSurvivorWave(6)
  runStartedAt = performance.now()
  nextWaveAt = runStartedAt + 20_000

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('resize', onResize)
  renderer!.domElement.addEventListener('click', onCanvasClick)
  // Camera orbit (right-drag) + zoom (wheel).
  renderer!.domElement.addEventListener('contextmenu', onContextMenu)
  renderer!.domElement.addEventListener('pointerdown', onPointerDown)
  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  renderer!.domElement.addEventListener('wheel', onWheel, { passive: false })

  // Begin the local run after the scene and character are ready.
  ready.value = true
  pushLog(`Welcome to ${zoneName.value}. WASD to move, Space to jump, automatically cast against nearby foes.`, 'sys')
  clock.start()
  frame()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('resize', onResize)
  renderer?.domElement.removeEventListener('click', onCanvasClick)
  renderer?.domElement.removeEventListener('contextmenu', onContextMenu)
  renderer?.domElement.removeEventListener('pointerdown', onPointerDown)
  window.removeEventListener('pointermove', onPointerMove)
  window.removeEventListener('pointerup', onPointerUp)
  renderer?.domElement.removeEventListener('wheel', onWheel)
  for (const bolt of survivorBolts) {
    scene?.remove(bolt.visual)
    if (bolt.flame) disposeSpellSprite(bolt.flame)
    if (bolt.orb) disposeSpellSprite(bolt.orb)
    bolt.fallback?.geometry.dispose()
    if (bolt.fallback) (bolt.fallback.material as THREE.Material).dispose()
  }
  for (const impact of survivorImpacts) disposeSpellSprite(impact.fx)
  for (const texture of Object.values(spellTextures)) texture?.dispose()
  renderer?.dispose()
  renderer = null
})

// ─── HUD derived ─────────────────────────────────────────────────────────────
const hpPctPlayer = computed(() => (player.hp / player.maxHp) * 100)
const manaPctPlayer = computed(() => (player.mana / player.maxMana) * 100)
const xpPct = computed(() => Math.min(100, (player.xp / Math.max(1, player.xpToLevel)) * 100))
const hpPctTarget = computed(() => targetView.value ? (targetView.value.hp / targetView.value.maxHp) * 100 : 0)
const combatFeed = computed(() => log.value.filter((entry) => entry.cls !== 'sys').slice(-3).reverse())

</script>

<template>
  <main class="arena fixed inset-0 overflow-hidden bg-[#090b0d] text-[#f2e6ca] select-none">
    <div ref="containerRef" class="absolute inset-0" />
    <div class="vignette absolute inset-0 pointer-events-none" />

    <section v-if="!ready" class="veil">
      <div class="entry-card">
        <div class="seal">NS</div>
        <div class="kicker">A NORRATH SURVIVORS RUN</div>
        <h1>Entering {{ zoneName || 'Norrath' }}</h1>
        <p v-if="!loadError">{{ loadingMsg }}</p><p v-else class="error">{{ loadError }}</p>
        <div class="loading-track"><i /></div>
      </div>
    </section>

    <template v-if="ready">
      <header class="brand">
        <div class="kicker">THE OLD WORLD · 1999</div>
        <h1>Norrath <span>Survivors</span></h1>
        <div class="run-plaque">
          <b>{{ zoneName }}</b><i />
          <span>WAVE <strong>{{ String(waveNumber).padStart(2, '0') }}</strong></span><i />
          <strong>{{ Math.floor(runSeconds / 60).toString().padStart(2, '0') }}:{{ (runSeconds % 60).toString().padStart(2, '0') }}</strong><i />
          <span>{{ runKills }} SLAIN</span>
        </div>
      </header>

      <section class="hero-panel">
        <div class="hero-heading">
          <div class="hero-seal"><span>W</span><b>LV {{ player.level }}</b></div>
          <div class="hero-name"><strong>{{ player.name }}</strong><small>{{ player.race }} · {{ player.className }}</small></div>
          <button class="pause-button" title="Pause (Esc)" @click="togglePause">Ⅱ</button>
        </div>
        <div class="bar-label"><span>HEALTH</span><b>{{ Math.ceil(player.hp) }} <i>/ {{ player.maxHp }}</i></b></div>
        <div class="resource-bar"><i class="health-fill" :style="{ width: hpPctPlayer + '%' }" /></div>
        <div class="bar-label mana-label"><span>MANA</span><b>{{ Math.ceil(player.mana) }} <i>/ {{ player.maxMana }}</i></b></div>
        <div class="resource-bar mana-bar"><i :style="{ width: manaPctPlayer + '%' }" /></div>
        <div class="bar-label xp-label"><span>EXPERIENCE</span><b>{{ Math.floor(xpPct) }}%</b></div>
        <div class="resource-bar xp-bar"><i :style="{ width: xpPct + '%' }" /></div>
      </section>

      <section class="map-panel">
        <div class="map-caption"><b>{{ zoneName }}</b><span>ARENA</span></div>
        <div class="mini-map">
          <div class="map-grid" /><div class="map-ring ring-a" /><div class="map-ring ring-b" />
          <i class="map-camp" />
          <i v-for="b in miniBlips.filter(b => b.alive)" :key="b.id" class="map-mob" :class="{ marked: b.targeted }" :style="{ left: (b.nx * 100) + '%', top: (b.nz * 100) + '%' }" />
          <i class="map-player" :style="{ left: (playerBlip.nx * 100) + '%', top: (playerBlip.nz * 100) + '%' }" />
          <span class="map-north">N</span>
        </div>
      </section>

      <div v-if="liftHint" class="world-prompt"><kbd>F</kbd> USE LIFT</div>
      <section v-if="targetView" class="target-panel">
        <div><span>{{ targetView.isNamed ? 'ELITE TARGET' : 'TARGET' }}</span><b :class="targetView.conColor">LV {{ targetView.level }} · {{ targetView.conText }}</b></div>
        <strong>{{ targetView.name }}</strong>
        <div class="target-bar"><i :style="{ width: hpPctTarget + '%' }" /></div>
      </section>

      <aside class="combat-feed">
        <div v-for="entry in combatFeed" :key="entry.id" :class="'feed-' + entry.cls">{{ entry.text }}</div>
      </aside>

      <footer class="bottom-hud">
        <div class="spell-panel">
          <button class="spell-orb" :class="{ muted: !autoAttack }" :aria-pressed="autoAttack" title="Toggle auto-cast (T)" @click="autoAttack = !autoAttack">✦<kbd>T</kbd></button>
          <div class="spell-copy"><strong>Fire Bolt <span :class="autoAttack ? 'active' : 'inactive'">{{ autoAttack ? 'ACTIVE' : 'PAUSED' }}</span></strong><small>Automatically strikes the nearest foe</small></div>
          <button class="mode-toggle" @click="toggleControlMode">{{ controlMode === 'click' ? 'CLICK MOVE' : 'KEYBOARD' }} <kbd>M</kbd></button>
        </div>
        <div class="controls"><span><kbd>{{ controlMode === 'click' ? 'CLICK' : 'WASD' }}</kbd> MOVE</span><span><kbd>TAB</kbd> TARGET</span><span>RIGHT DRAG ORBIT</span><span>WHEEL ZOOM</span><span><kbd>ESC</kbd> PAUSE</span></div>
      </footer>

      <div v-if="player.dead && !runOver" class="falling-overlay"><strong>YOU HAVE FALLEN</strong><span>The Crushbone horde closes in…</span></div>

      <section v-if="upgradeChoices.length" class="modal-veil">
        <div class="choice-modal">
          <div class="kicker">A MOMENT OF CLARITY</div><h2>Choose your boon</h2>
          <p>The battle waits. Shape the power that carries you deeper.</p>
          <div class="boon-grid">
            <button v-for="(upgrade, i) in upgradeChoices" :key="upgrade.name" class="boon-card" @click="chooseSurvivorUpgrade(i)">
              <span class="boon-number">0{{ i + 1 }}</span><i>{{ ['✦', '◈', '⌁'][i] }}</i>
              <strong>{{ upgrade.name }}</strong><small>{{ upgrade.description }}</small>
              <span class="boon-action">SELECT <kbd>{{ i + 1 }}</kbd></span>
            </button>
          </div>
        </div>
      </section>

      <section v-if="paused" class="modal-veil">
        <div class="pause-modal"><div class="kicker">THE WORLD HOLDS ITS BREATH</div><h2>Run paused</h2>
          <p>{{ zoneName }} · Wave {{ waveNumber }} · Level {{ player.level }}</p>
          <button class="primary-action" @click="togglePause">RESUME THE FIGHT <kbd>ESC</kbd></button>
          <button class="secondary-action" @click="restartRun">ABANDON THIS RUN</button>
        </div>
      </section>

      <section v-if="runOver" class="modal-veil end-screen">
        <div class="end-modal"><div class="end-mark">†</div><div class="kicker">CRUSHBONE CLAIMS ANOTHER</div><h2>The horde prevails</h2>
          <p>Your stand will be remembered.</p>
          <div class="run-record"><div><b>{{ Math.floor(runSeconds / 60) }}:{{ (runSeconds % 60).toString().padStart(2, '0') }}</b><small>SURVIVED</small></div><div><b>{{ runKills }}</b><small>FOES SLAIN</small></div><div><b>{{ waveNumber }}</b><small>WAVE REACHED</small></div></div>
          <button class="primary-action" @click="restartRun">RETURN TO CRUSHBONE <kbd>R</kbd></button>
        </div>
      </section>
    </template>
  </main>
</template>

<style>
.arena{font-family:Inter,ui-sans-serif,system-ui,sans-serif}.vignette{background:radial-gradient(ellipse at center,transparent 48%,#04050655 82%,#040506bd 100%),linear-gradient(#07080980,transparent 25%,transparent 68%,#070809a8)}
.hero-panel,.map-panel,.target-panel,.spell-panel{border:1px solid #cdaa6b50;background:linear-gradient(145deg,#171715ed,#090b0def);box-shadow:0 14px 36px #0007,inset 0 1px #fff1;backdrop-filter:blur(12px)}
.hero-panel{position:absolute;z-index:20;top:20px;left:20px;width:min(300px,calc(100vw - 40px));padding:13px 15px;border-radius:7px}
.hero-heading{display:flex;align-items:center;gap:11px;margin-bottom:13px}.hero-seal,.seal{display:grid;place-items:center;border:1px solid #c9a66c;border-radius:50%;background:radial-gradient(circle at 35% 25%,#635844,#191918 70%);color:#e6cb92;box-shadow:0 0 0 3px #d4b37712}
.hero-seal{position:relative;width:44px;height:44px;flex:none}.hero-seal span{font:700 21px Georgia,serif}.hero-seal b{position:absolute;bottom:-5px;padding:2px 5px;border:1px solid #574b38;border-radius:3px;background:#101111;font:7px ui-monospace,monospace}
.hero-name{flex:1;min-width:0}.hero-name strong{display:block;overflow:hidden;color:#f0dfbb;font:600 14px Georgia,serif;text-overflow:ellipsis;white-space:nowrap}.hero-name small{display:block;margin-top:3px;color:#d9cdb18f;font-size:8px;letter-spacing:.14em;text-transform:uppercase}
.pause-button{width:30px;height:30px;border:1px solid #dbc1963b;border-radius:4px;background:#ffffff06;color:#d6c6a6}.pause-button:hover{border-color:#caa96d;color:#f3d79d}
.bar-label{display:flex;justify-content:space-between;color:#d8cbb094;font-size:8px;font-weight:700;letter-spacing:.13em}.bar-label b{color:#eee5d3;font:10px ui-monospace,monospace}.bar-label b i{color:#dfd3be70;font-style:normal}.resource-bar,.target-bar{height:7px;margin-top:4px;overflow:hidden;border:1px solid #000b;border-radius:2px;background:#080909;box-shadow:inset 0 1px 3px #000}.resource-bar i,.target-bar i{display:block;height:100%;transition:width .18s}.health-fill{background:linear-gradient(90deg,#762c22,#bd5c43 65%,#d6815f);box-shadow:0 0 9px #c24c523f}.mana-label{margin-top:8px}.mana-bar{height:5px}.mana-bar i{background:linear-gradient(90deg,#28526c,#5797ae)}.xp-label{margin-top:11px;font-size:7px}.xp-bar{height:4px}.xp-bar i{background:linear-gradient(90deg,#936b37,#e1bf79)}
.brand{position:absolute;z-index:20;top:18px;left:50%;transform:translateX(-50%);text-align:center;pointer-events:none}.kicker{color:#dbba7eb8;font-size:8px;font-weight:700;letter-spacing:.25em}.brand h1{margin:4px 0 9px;color:#efe2c4;font:700 24px Georgia,serif;letter-spacing:.05em;text-shadow:0 2px 12px #000}.brand h1 span{color:#cbb17f}.run-plaque{display:flex;align-items:center;gap:11px;padding:8px 11px;border:1px solid #d1b07852;border-radius:4px;background:#0a0b0bd9;box-shadow:0 8px 20px #0005;color:#e6dbc4b8;font:8px ui-monospace,monospace;letter-spacing:.1em}.run-plaque i{width:1px;height:10px;background:#d7b88342}.run-plaque b{max-width:120px;overflow:hidden;color:#d2bf98;text-overflow:ellipsis;white-space:nowrap}.run-plaque strong{color:#e8ca8f}
.map-panel{position:absolute;z-index:20;top:20px;right:20px;width:150px;padding:8px;border-radius:6px}.map-caption{display:flex;justify-content:space-between;color:#e1d2b7b3;font-size:7px;letter-spacing:.1em}.map-caption b{max-width:95px;overflow:hidden;color:#d4bc8c;text-overflow:ellipsis;white-space:nowrap}.map-caption span{color:#d1c1a26e}.mini-map{position:relative;height:118px;margin-top:6px;overflow:hidden;border:1px solid #c9af853d;border-radius:3px;background:radial-gradient(circle,#232420,#111312 78%)}.map-grid{position:absolute;inset:0;opacity:.25;background-image:linear-gradient(#ccb58d38 1px,transparent 1px),linear-gradient(90deg,#ccb58d38 1px,transparent 1px);background-size:25% 25%}.map-ring{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);border:1px solid #c3af8920;border-radius:50%}.ring-a{width:44%;height:44%}.ring-b{width:76%;height:76%}.map-camp,.map-mob,.map-player{position:absolute;z-index:2;transform:translate(-50%,-50%);border-radius:50%}.map-camp{top:50%;left:50%;width:5px;height:5px;background:#d8a05f;box-shadow:0 0 8px #ca7147}.map-mob{width:4px;height:4px;background:#b64e3b;box-shadow:0 0 5px #c7432fa6}.map-mob.marked{width:6px;height:6px;background:#f0cd8d;box-shadow:0 0 8px #e7b861}.map-player{width:7px;height:7px;background:#83bac2;border:1px solid #e4e0ce;box-shadow:0 0 8px #6aa6b4}.map-north{position:absolute;top:3px;left:50%;transform:translateX(-50%);color:#d2bb8c;font:bold 7px Georgia,serif}
.target-panel{position:absolute;z-index:20;top:157px;left:50%;width:min(320px,calc(100vw - 32px));padding:9px 12px;transform:translateX(-50%);border-color:#ae5b426b;border-radius:5px;text-align:center}.target-panel>div:first-child{display:flex;justify-content:space-between;color:#e0ccb79e;font-size:7px;font-weight:700;letter-spacing:.12em}.target-panel>strong{display:block;margin-top:4px;color:#ead9bd;font:600 13px Georgia,serif;letter-spacing:.06em;text-transform:uppercase}.target-bar{height:5px;margin-top:7px}.target-bar i{background:linear-gradient(90deg,#702c24,#bd6148)}
.world-prompt{position:absolute;top:53%;left:50%;z-index:20;transform:translate(-50%,-50%);padding:8px 12px;border:1px solid #d4b27066;border-radius:4px;background:#0c0c0be0;color:#e4cf9d;font-size:9px;letter-spacing:.08em}.world-prompt kbd,.controls kbd,.spell-orb kbd,.mode-toggle kbd,.primary-action kbd{padding:2px 4px;border:1px solid #ddc69e59;border-radius:2px;background:#0005;color:#ead3a2;font:8px ui-monospace,monospace}
.combat-feed{position:absolute;bottom:112px;left:20px;z-index:20;display:flex;flex-direction:column;gap:4px;max-width:300px}.combat-feed div{padding:5px 8px;border-left:2px solid #bd553db8;background:linear-gradient(90deg,#090a0ab3,transparent);color:#ecdcbbc9;font:10px Georgia,serif;text-shadow:0 1px 3px #000;animation:feed-in .25s ease-out}.combat-feed .feed-you,.combat-feed .feed-loot{border-color:#d3ae6e;color:#ead7ab}.combat-feed .feed-death{border-color:#bd4c3a;color:#e49b83}
.bottom-hud{position:absolute;bottom:18px;left:50%;z-index:20;width:min(580px,calc(100vw - 32px));transform:translateX(-50%)}.spell-panel{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:7px}.spell-orb{position:relative;display:grid;place-items:center;width:42px;height:42px;flex:none;border:1px solid #91b6c1;border-radius:50%;background:radial-gradient(circle at 35% 28%,#b2e5e7,#3c8a9a 38%,#17333b 76%);box-shadow:0 0 16px #51a6b859,inset 0 0 9px #e2ffff59;color:#f0ffff;font-size:20px;transition:.18s}.spell-orb:hover{filter:brightness(1.16)}.spell-orb.muted{filter:grayscale(.75);opacity:.65;box-shadow:none}.spell-orb kbd{position:absolute;right:-4px;bottom:-3px}.spell-copy{flex:1;min-width:0}.spell-copy strong{display:flex;align-items:center;gap:8px;color:#ead9bd;font:600 12px Georgia,serif}.spell-copy small{display:block;margin-top:3px;color:#dccfb581;font-size:9px}.active,.inactive{color:#93c4b4;font:700 7px ui-monospace,monospace;letter-spacing:.1em}.inactive{color:#a69a83}.mode-toggle{padding:7px;border:1px solid #d0b88f38;border-radius:4px;background:#fff1;color:#d1c3a5;font-size:7px;font-weight:700;letter-spacing:.08em;white-space:nowrap}.mode-toggle:hover{border-color:#caa96d;color:#f0d39b}.controls{display:flex;justify-content:center;flex-wrap:wrap;gap:11px;margin-top:7px;color:#e7dabf99;font-size:7px;letter-spacing:.06em;text-shadow:0 1px 3px #000}.controls kbd{margin-right:2px;padding:1px 3px;font-size:7px}
.falling-overlay{position:absolute;inset:0;z-index:30;display:grid;align-content:center;justify-items:center;gap:8px;background:#2d0c0c29;color:#eacfbab3;font:italic 13px Georgia,serif;pointer-events:none}.falling-overlay strong{color:#d87962;font:700 29px Georgia,serif;letter-spacing:.18em;text-shadow:0 2px 12px #000}
.modal-veil,.veil{position:absolute;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:20px;background:#050708c9;backdrop-filter:blur(8px)}.veil{z-index:50;background:#090b0df5}.choice-modal,.pause-modal,.end-modal,.entry-card{width:min(790px,100%);padding:32px;border:1px solid #cfaf786e;border-radius:9px;background:radial-gradient(ellipse at 50% 0%,#5e482a3b,transparent 56%),linear-gradient(145deg,#191918,#0b0d0e 72%);box-shadow:0 30px 90px #000a,inset 0 1px #fff1;text-align:center}.choice-modal h2,.pause-modal h2,.end-modal h2{margin:7px 0 4px;color:#f0dfbb;font:600 25px Georgia,serif}.choice-modal>p,.pause-modal>p,.end-modal>p{margin:0;color:#e0d2b88f;font:italic 12px Georgia,serif}
.boon-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:23px}.boon-card{position:relative;display:flex;min-height:206px;flex-direction:column;align-items:flex-start;padding:17px;border:1px solid #cdb2873d;border-radius:6px;background:linear-gradient(150deg,#312c22ad,#0e0f0fe0);text-align:left;transition:.2s}.boon-card:hover{transform:translateY(-4px);border-color:#c5a56f;box-shadow:0 12px 30px #0006,0 0 20px #cba4621a}.boon-number{position:absolute;top:12px;right:14px;color:#e5cc9f70;font:10px ui-monospace,monospace}.boon-card>i{display:grid;place-items:center;width:40px;height:40px;margin-bottom:17px;border:1px solid #d6b87e6b;border-radius:50%;background:#c5974e33;color:#e0bf7e;font-style:normal;font-size:18px}.boon-card>strong{color:#efe2c8;font:600 14px Georgia,serif}.boon-card>small{margin-top:7px;color:#e2d6be99;font:11px/1.5 Georgia,serif}.boon-action{display:flex;align-items:center;gap:5px;margin-top:auto;padding-top:15px;color:#dabd89a3;font:700 7px ui-monospace,monospace;letter-spacing:.13em}
.pause-modal,.end-modal{width:min(440px,100%);padding:37px}.primary-action,.secondary-action{display:flex;align-items:center;justify-content:center;gap:12px;width:100%;margin-top:24px;padding:12px;border:1px solid #c7a567;border-radius:4px;background:linear-gradient(100deg,#795d37,#433621);color:#f5e6c5;font-size:9px;font-weight:800;letter-spacing:.15em}.primary-action:hover{filter:brightness(1.2);box-shadow:0 0 22px #cba4622e}.secondary-action{margin-top:9px;border-color:#c9b69733;background:transparent;color:#ddd0b985}.secondary-action:hover{border-color:#cca77199;color:#e8d7b4}.end-mark{margin-bottom:9px;color:#bd775d;font:40px Georgia,serif}.end-modal{border-color:#a5586373}.end-modal h2{text-transform:uppercase;letter-spacing:.1em;font-size:23px}.run-record{display:grid;grid-template-columns:repeat(3,1fr);margin-top:22px;padding:14px 0;border-block:1px solid #d6b78429}.run-record div{display:grid;gap:4px}.run-record div+div{border-left:1px solid #d6b78426}.run-record b{color:#e4c78c;font:20px Georgia,serif}.run-record small{color:#e2d3b779;font-size:7px;letter-spacing:.12em}
.entry-card{width:min(390px,100%);padding:34px}.seal{width:58px;height:58px;margin:0 auto 14px;font:700 22px Georgia,serif}.entry-card h1{margin-top:8px;color:#eddfc1;font:600 21px Georgia,serif}.entry-card p{margin-top:8px;color:#dfd2b98c;font:italic 12px Georgia,serif}.entry-card .error{color:#db9078}.loading-track{height:2px;margin-top:20px;overflow:hidden;background:#282522}.loading-track i{display:block;width:45%;height:100%;background:#c4a36a;animation:sweep 1.5s infinite ease-in-out}
@keyframes feed-in{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:translateY(0)}}@keyframes sweep{0%{transform:translateX(-110%)}100%{transform:translateX(240%)}}
@media(max-width:760px){.brand{top:15px}.brand h1{font-size:19px}.kicker{font-size:6px}.run-plaque{gap:6px;padding:7px;font-size:6px}.hero-panel{top:12px;left:12px;width:220px;padding:10px}.hero-seal{width:37px;height:37px}.map-panel{top:12px;right:12px;width:108px;padding:6px}.map-caption span,.map-north{display:none}.mini-map{height:80px}.target-panel{top:145px}.bottom-hud{bottom:10px}.spell-panel{gap:8px;padding:8px}.spell-orb{width:36px;height:36px}.spell-copy strong{font-size:10px}.spell-copy small{font-size:8px}.mode-toggle{font-size:6px;padding:6px}.controls{gap:6px;font-size:6px}.combat-feed{bottom:105px;left:12px;max-width:220px}.combat-feed div{font-size:9px}.choice-modal,.pause-modal,.end-modal{padding:21px 15px}.boon-grid{gap:7px;margin-top:16px}.boon-card{min-height:175px;padding:11px}.boon-card>i{width:32px;height:32px;margin-bottom:12px}.boon-card>strong{font-size:12px}.boon-card>small{font-size:10px}}
@media(max-width:480px){.brand{top:140px}.brand h1{font-size:17px;margin:2px 0 5px}.run-plaque{gap:4px;font-size:5px}.hero-panel{top:10px;left:8px;width:calc(100vw - 142px)}.hero-name strong{font-size:12px}.map-panel{top:10px;right:8px;width:94px}.mini-map{height:68px}.target-panel{top:214px}.combat-feed{display:none}.boon-grid{grid-template-columns:1fr;max-height:61vh;overflow:auto}.boon-card{min-height:122px}.boon-card>i{margin-bottom:7px}.boon-action{padding-top:8px}.controls span:nth-child(2),.controls span:nth-child(3),.controls span:nth-child(4){display:none}}
.tg-nameplate{text-align:center;transform:translateY(-100%);font-family:ui-monospace,monospace;pointer-events:none;white-space:nowrap}.tg-np-name{font-size:11px;font-weight:600;text-shadow:0 1px 2px #000,0 0 4px #000;letter-spacing:.02em}.tg-np-bar{margin:2px auto 0;width:56px;height:4px;background:#000c;border:1px solid #000e;border-radius:2px;overflow:hidden}.tg-np-fill{height:100%;width:100%;transition:width .12s linear}.tg-np-target .tg-np-bar{box-shadow:0 0 0 1px #d8b256,0 0 6px #d8b256}.tg-np-target .tg-np-name{color:#f5e8c4!important}
</style>
