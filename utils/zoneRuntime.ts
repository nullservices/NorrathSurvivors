import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { publicPath } from '~/utils/publicPath'
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh'

/**
 * Runtime support for real EQ zone geometry (built by scripts/build-zone.mjs)
 * and real spawn points (scripts/build-spawns.mjs).
 *
 * Coordinates: the zone .glb keeps EQ units in EQ's Z-up frame under a root
 * that applies the Z-up → Y-up rotation. The runtime scales the whole zone
 * by EQ_WORLD_SCALE so it matches the 1.8-unit-human character models, and
 * converts EQ (x, y, z) → world (x·K, z·K, −y·K) for spawn placement.
 */

// 1 EQ unit → world units (a ~6-unit-tall EQ human ≈ our 1.8u baseline).
export const EQ_WORLD_SCALE = 0.3

/** EQ Z-up *geometry* coords → world position (matches the zone root's
 *  rotation). */
export function eqToWorld(x: number, y: number, z: number): THREE.Vector3 {
  return new THREE.Vector3(x * EQ_WORLD_SCALE, z * EQ_WORLD_SCALE, -y * EQ_WORLD_SCALE)
}

/** EQEmu *server* coords (spawn2 / zone safe spots) → world position.
 *  Server x/y are swapped relative to the WLD geometry frame (verified:
 *  crushbone's safe spot only lands inside the zone bounds when swapped). */
export function serverToWorld(x: number, y: number, z: number): THREE.Vector3 {
  return eqToWorld(y, x, z)
}

// Accelerate raycasts against the merged zone mesh (~200k tris). The lib
// extends three's prototypes; TS doesn't know about the added members.
;(THREE.BufferGeometry.prototype as any).computeBoundsTree = computeBoundsTree
;(THREE.BufferGeometry.prototype as any).disposeBoundsTree = disposeBoundsTree
;(THREE.Mesh.prototype as any).raycast = acceleratedRaycast

export interface LoadedZone {
  root: THREE.Group
  /** Solid geometry — terrain, walls, props, ladders. Used for ground
   *  snapping, collision, and the occlusion cutaway. Excludes water. */
  meshes: THREE.Mesh[]
  /** Water-surface meshes (translucent) — for swim detection. */
  waterMeshes: THREE.Mesh[]
  /** Ladder props — climbable; a subset of `meshes` (still solid). */
  ladderMeshes: THREE.Mesh[]
  bounds: THREE.Box3
  /** Welded sub-zones (≥1). Each carries the placement transform so callers
   *  can position that zone's server-coord spawns/safe-spot in the shared
   *  world frame. A single (un-welded) zone has one part at identity. */
  parts: ZonePart[]
  /** Kelethin-style lifts (rideable platforms + their switches). Empty for a
   *  plain loadZone; populated by loadWorld. */
  lifts: LiftRuntime[]
}

/** A rideable lift platform + its switch. The platform node is reparented into
 *  the world frame so its `position.y` is animated directly between `downY`
 *  (boarding, at the terrain) and `upY` (the Kelethin tier). */
export interface LiftRuntime {
  id: string
  node: THREE.Object3D            // platform — animate node.position.y (world)
  meshes: THREE.Mesh[]            // platform collision meshes (a subset of zone meshes)
  upY: number
  downY: number
  centerX: number                // platform centre (world xz, fixed)
  centerZ: number
  radius: number                 // platform xz radius for ride detection
  topOffset: number              // platform top surface relative to node.position.y
  switches: LiftSwitch[]         // a fixed switch at each end (top + bottom)
  state: 'up' | 'down' | 'moving'
  target: 'up' | 'down'
}
/** A fixed lever beside the lift at one end; flipping it calls the lift to that
 *  end, or sends it (carrying you) if it's already there. */
export interface LiftSwitch {
  node: THREE.Object3D
  end: 'up' | 'down'
}

/** A zone placed into the shared world: rotate `rotY` about world-up, then
 *  translate by `offset`. Identity for a stand-alone or base zone. */
export interface ZonePlacement {
  id: string
  offset: [number, number, number]
  rotY: number
  /** Baked cut boxes in THIS zone's LOCAL frame (= world − offset; rotation not
   *  tracked). Each `[x0,y0,z0, x1,y1,z1, all]` removes geometry inside it from
   *  this zone — `all=1` everything (floor+walls), else only wall faces. Stored
   *  local so the hole travels with the zone when you move it. */
  cuts?: number[][]
}
export interface ZonePart {
  id: string
  place: ZonePlacement
  /** World-space bounds of this part — lets the runtime tell which welded
   *  zone the player is currently standing in (for the zone banner). */
  bounds: THREE.Box3
}

// ─── Welded worlds ───────────────────────────────────────────────────────────
// Zones stitched into one continuous space (no load screen between them). The
// transform aligns the connecting zoneline doorway (derived from EQEmu
// zone_points) so you can walk straight across. Entering ANY member zone loads
// the whole group. gfaydark↔crushbone: their shared doorway is welded to 0.00u
// error with identity rotation (both use the same server-axis convention and
// the through-axis is world-X), gfaydark offset south/west of the crushbone
// fort gate. See tmp/dev-weld verification.
// Each zone carries its own baked cut boxes (local frame) — the dead-end
// zoneline caps are sliced out of the geometry so the two passages join.
// Defaults below slice the seam-corridor walls. The crushbone↔gfaydark junction
// is gfaydark's rough mountain-border
// canyon (verified: ~no real geometry overlap; the seam region is gfaydark).
const CRUSHBONE_GFAYDARK: ZonePlacement[] = [
  { id: 'crushbone', offset: [0, 0, 0], rotY: 0, cuts: [[-210, -8, -90, -100, 44, -50, 0]] },
  { id: 'gfaydark', offset: [-975.0, -4.555, -65.25], rotY: 0, cuts: [[765, -3.445, -24.75, 875, 48.555, 15.25, 0]] },
]
const WELDS: Record<string, ZonePlacement[]> = {
  crushbone: CRUSHBONE_GFAYDARK,
  gfaydark: CRUSHBONE_GFAYDARK,
}

const _yAxis = new THREE.Vector3(0, 1, 0)
/** Place an EQ *server* coord into the shared world frame for a given zone
 *  part (server→world, then the part's rotation + offset). */
export function placeServerPoint(place: ZonePlacement, x: number, y: number, z: number): THREE.Vector3 {
  const p = serverToWorld(x, y, z)
  if (place.rotY) p.applyAxisAngle(_yAxis, place.rotY)
  p.x += place.offset[0]; p.y += place.offset[1]; p.z += place.offset[2]
  return p
}

/** Load a zone and, if it belongs to a welded group, every zone welded to it,
 *  each placed by its transform — returned as one combined LoadedZone whose
 *  `meshes`/`waterMeshes`/`ladderMeshes` span all members (so collision,
 *  snapping, and the cutaway "just work" across the seam). Best-effort on
 *  welded neighbours: a missing neighbour glb is skipped, not fatal. Returns
 *  null only if the entered zone itself fails to load. */
export async function loadWorld(zoneId: string): Promise<LoadedZone | null> {
  // A local weld config can override the bundled placement for a zone group.
  const cfg = await fetchWeldOverride(zoneId)
  const places: ZonePlacement[] = cfg?.zones
    ?? WELDS[zoneId]
    ?? [{ id: zoneId, offset: [0, 0, 0] as [number, number, number], rotY: 0 }]
  const root = new THREE.Group()
  root.name = 'world'
  const meshes: THREE.Mesh[] = []
  const waterMeshes: THREE.Mesh[] = []
  const ladderMeshes: THREE.Mesh[] = []
  const parts: ZonePart[] = []
  const allCuts: CutBox[] = []
  for (const place of places) {
    const lz = await loadZone(place.id)
    if (!lz) {
      if (place.id === zoneId) return null   // entered zone is mandatory
      continue                                // neighbour missing → skip
    }
    const parent = new THREE.Group()
    parent.name = `zone_${place.id}`
    parent.rotation.y = place.rotY
    parent.position.set(place.offset[0], place.offset[1], place.offset[2])
    parent.add(lz.root)
    root.add(parent)
    parent.updateMatrixWorld(true)
    // Apply this zone's baked cuts (local → world via offset) to ITS meshes
    // only — slices the dead-end caps out so the passages join.
    const wcuts = localCutsToWorld(place)
    if (wcuts.length) cutWallsInBoxes(lz.meshes, wcuts)
    allCuts.push(...wcuts)
    meshes.push(...lz.meshes)
    waterMeshes.push(...lz.waterMeshes)
    ladderMeshes.push(...lz.ladderMeshes)
    parts.push({ id: place.id, place, bounds: new THREE.Box3().setFromObject(parent) })
  }
  root.updateMatrixWorld(true)
  const bounds = new THREE.Box3().setFromObject(root)
  // Belt-and-suspenders: suppress wall collision in the cut boxes too, so a
  // wall straddling a box edge (its triangle centroid outside the box, hence
  // not sliced) still doesn't block the crossing.
  setWallPortals(allCuts.map((c) => c.box))
  const lifts = processLifts(root, meshes)
  return { root, meshes, waterMeshes, ladderMeshes, bounds, parts, lifts }
}

/** A zone's local cut boxes → world `CutBox`es (local + offset; rotation not
 *  tracked, fine for the rotY=0 welds we use). */
export function localCutsToWorld(place: ZonePlacement): CutBox[] {
  const [ox, oy, oz] = place.offset
  return (place.cuts ?? []).map((d) => ({
    box: new THREE.Box3(
      new THREE.Vector3(d[0] + ox, d[1] + oy, d[2] + oz),
      new THREE.Vector3(d[3] + ox, d[4] + oy, d[5] + oz)),
    all: d[6] === 1,
  }))
}

// ─── Kelethin lifts ─────────────────────────────────────────────────────────
const LIFT_SPEED = 9               // world units / sec the platform travels
export const LIFT_SWITCH_RANGE = 8 // how close you must be to flip a switch

/** Find the lift platform (`lift_<id>`) + switch (`liftsw_<id>`) nodes baked
 *  into the placed world (at the BOARDING spot — the top of the wooden ramp),
 *  reparent each into the world frame, raycast UP to the Kelethin platform it
 *  rises to, and put a switch at each end. Starts DOWN so it's visible at the
 *  ramp where you board. */
function processLifts(root: THREE.Group, meshes: THREE.Mesh[]): LiftRuntime[] {
  const plats = new Map<string, THREE.Object3D>()
  const switches = new Map<string, THREE.Object3D>()
  root.updateMatrixWorld(true)
  root.traverse((o) => {
    if (o.name?.startsWith('liftsw_')) switches.set(o.name.slice(7), o)
    else if (o.name?.startsWith('lift_')) plats.set(o.name.slice(5), o)
  })
  const lifts: LiftRuntime[] = []
  for (const [id, node] of plats) {
    const wpos = node.getWorldPosition(new THREE.Vector3())
    const bbox = new THREE.Box3().setFromObject(node)
    const topOffset = bbox.max.y - wpos.y
    // The rideable deck sits at the node origin (the faylevator's bbox stretches
    // out a thin arm, so its bbox centre is empty space). Detection uses the
    // origin with a modest radius.
    const centerX = wpos.x, centerZ = wpos.z, radius = 9
    const platMeshes: THREE.Mesh[] = []
    node.traverse((c) => { if ((c as THREE.Mesh).isMesh) platMeshes.push(c as THREE.Mesh) })
    const others = meshes.filter((m) => !platMeshes.includes(m))
    root.attach(node)              // reparent to world frame (root is identity)
    const downY = node.position.y  // baked at the boarding spot
    // Rise to the Kelethin platform above: the nearest solid surface that's a
    // real lift up (skip railings/ramp right beside the deck — require ≥10u).
    downRay.set(new THREE.Vector3(centerX, downY + topOffset, centerZ), UP)
    downRay.far = 200
    let city: number | null = null
    for (const h of downRay.intersectObjects(others, false)) {
      const y = h.point.y
      if (y > downY + topOffset + 10 && (city === null || y < city)) city = y
    }
    const upY = city !== null ? city - topOffset - 0.05 : downY + 26
    // A FIXED switch at each end (call/send). The baked switch is at the
    // boarding spot ('down'); clone one up to the Kelethin platform ('up').
    const liftSwitches: LiftSwitch[] = []
    const sw = switches.get(id) ?? null
    if (sw) {
      root.attach(sw)
      liftSwitches.push({ node: sw, end: 'down' })
      const sp = sw.position
      const top = sw.clone(true)
      top.position.set(sp.x, upY + topOffset, sp.z)
      root.add(top); top.updateMatrixWorld(true)
      liftSwitches.push({ node: top, end: 'up' })
    }
    node.position.y = downY        // start at the ramp (visible where you board)
    node.updateMatrixWorld(true)
    lifts.push({
      id, node, meshes: platMeshes, upY, downY,
      centerX, centerZ, radius, topOffset, switches: liftSwitches,
      state: 'down', target: 'down',
    })
  }
  return lifts
}

/** Animate a lift toward its target; returns the Y delta this frame (so the
 *  caller can carry a rider). Updates the platform's world matrix for collision. */
export function updateLift(lift: LiftRuntime, dt: number): number {
  const goal = lift.target === 'up' ? lift.upY : lift.downY
  const y = lift.node.position.y
  if (Math.abs(y - goal) < 1e-3) { lift.state = lift.target; return 0 }
  const step = Math.sign(goal - y) * Math.min(Math.abs(goal - y), LIFT_SPEED * dt)
  lift.node.position.y = y + step
  lift.node.updateMatrixWorld(true)
  lift.state = 'moving'
  return step
}

/** Flip a switch at `end`: call the lift to that end if it's away, or send it
 *  to the other end (carrying any rider) if it's already here. */
export function toggleLift(lift: LiftRuntime, end: 'up' | 'down') {
  const here = lift.state === end || (lift.state === 'moving' && lift.target === end)
  lift.target = here ? (end === 'up' ? 'down' : 'up') : end
}

const _swPos = new THREE.Vector3()
/** The lift switch within reach of (x,y,z) — xz within `LIFT_SWITCH_RANGE` and
 *  at roughly the same height (so the top/bottom switches don't cross-trigger). */
export function liftSwitchAt(lifts: LiftRuntime[], x: number, y: number, z: number): { lift: LiftRuntime; sw: LiftSwitch } | null {
  let best: { lift: LiftRuntime; sw: LiftSwitch } | null = null
  let bestD = LIFT_SWITCH_RANGE * LIFT_SWITCH_RANGE
  for (const l of lifts) {
    for (const s of l.switches) {
      const p = s.node.getWorldPosition(_swPos)
      const dx = p.x - x, dz = p.z - z, d = dx * dx + dz * dz
      if (d < bestD && Math.abs(p.y - y) < 6) { bestD = d; best = { lift: l, sw: s } }
    }
  }
  return best
}

/** True if (x,z) is on top of this lift's platform (for carrying the rider). */
export function onLift(lift: LiftRuntime, x: number, z: number, y: number): boolean {
  const dx = x - lift.centerX, dz = z - lift.centerZ
  if (dx * dx + dz * dz > lift.radius * lift.radius) return false
  const top = lift.node.position.y + lift.topOffset
  return Math.abs(y - top) < 1.5
}

/** Saved weld override for the group containing `zoneId` (from the editor), or
 *  null. Each zone carries its own `cuts` (local frame). Never throws — a
 *  missing/invalid config just falls back to the hardcoded weld. */
async function fetchWeldOverride(zoneId: string): Promise<{ zones: ZonePlacement[] } | null> {
  try {
    const res = await fetch(publicPath('/gamedata/weld-config.json'))
    if (!res.ok) return null
    const cfg = await res.json()
    const groups = cfg?.welds ?? {}
    for (const g of Object.values(groups) as any[]) {
      if (g?.zones?.some((z: ZonePlacement) => z.id === zoneId)) return { zones: g.zones }
    }
  } catch { /* no server / not saved yet */ }
  return null
}

/** True if `o` or any ancestor's name contains `token` (build-zone names
 *  the water mesh "water" and ladder nodes "ladder_N"). */
function namedLike(o: THREE.Object3D, token: string): boolean {
  for (let n: THREE.Object3D | null = o; n; n = n.parent) {
    if (n.name && n.name.toLowerCase().includes(token)) return true
  }
  return false
}

/** Load a built zone glb; null when this zone hasn't been converted yet
 *  (callers fall back to the legacy campfire scene). */
export async function loadZone(zoneId: string): Promise<LoadedZone | null> {
  let gltf
  try {
    gltf = await new GLTFLoader().loadAsync(publicPath(`/eq-assets/zones/${zoneId}.glb`))
  } catch {
    return null
  }
  const root = gltf.scene as unknown as THREE.Group
  root.scale.setScalar(EQ_WORLD_SCALE)
  const meshes: THREE.Mesh[] = []
  const waterMeshes: THREE.Mesh[] = []
  const ladderMeshes: THREE.Mesh[] = []
  root.traverse((o) => {
    const m = o as THREE.Mesh
    if (!m.isMesh) return
    ;(m.geometry as any).computeBoundsTree?.()
    m.receiveShadow = true
    const mat = m.material as THREE.MeshStandardMaterial
    if (mat) mat.side = THREE.DoubleSide
    if (namedLike(m, 'water')) {
      waterMeshes.push(m)   // not solid — you swim into it
      return
    }
    meshes.push(m)
    if (namedLike(m, 'ladder')) ladderMeshes.push(m)
  })
  root.updateWorldMatrix(true, true)
  const bounds = new THREE.Box3().setFromObject(root)
  const parts: ZonePart[] = [{ id: zoneId, place: { id: zoneId, offset: [0, 0, 0], rotY: 0 }, bounds }]
  return { root, meshes, waterMeshes, ladderMeshes, bounds, parts, lifts: [] }
}

/** Water surface height at (x,z), or null if no water column there. Casts
 *  down from high above and returns the topmost water face hit. */
export function waterSurface(waterMeshes: THREE.Mesh[], x: number, z: number, fromAbove = 200): number | null {
  if (!waterMeshes.length) return null
  downRay.set(new THREE.Vector3(x, fromAbove, z), DOWN)
  downRay.far = fromAbove + 400
  const hits = downRay.intersectObjects(waterMeshes, false)
  if (!hits.length) return null
  let top: number | null = null
  for (const h of hits) if (top === null || h.point.y > top) top = h.point.y
  return top
}

export interface SpawnEntry { mobId: string; chance: number }
export interface SpawnPoint {
  id: number
  x: number
  y: number
  z: number
  heading: number
  respawn: number
  entries: SpawnEntry[]
}

export async function fetchSpawns(zoneId: string): Promise<SpawnPoint[] | null> {
  try {
    const res = await fetch(publicPath(`/gamedata/spawns/${zoneId}.json`))
    if (!res.ok) return null
    const json = await res.json()
    return json.data ?? null
  } catch {
    return null
  }
}

/** Weighted pick from a spawn point's mob table. */
export function pickSpawnMob(entries: SpawnEntry[]): string {
  const total = entries.reduce((s, e) => s + e.chance, 0)
  let r = Math.random() * (total || 1)
  for (const e of entries) {
    r -= e.chance
    if (r <= 0) return e.mobId
  }
  return entries[0].mobId
}

// ─── Ground snapping ────────────────────────────────────────────────────────
const downRay = new THREE.Raycaster()
;(downRay as any).firstHitOnly = false   // walkways/bridges: pick the hit nearest the entity
const DOWN = new THREE.Vector3(0, -1, 0)
const UP = new THREE.Vector3(0, 1, 0)
const headRay = new THREE.Raycaster()
;(headRay as any).firstHitOnly = true
// Clearance needed to count a surface as standable (used only to pick which
// surface to step UP onto — never to drop you off one you're standing on).
const STAND_HEADROOM = 0.9
// Max drop for a surface to still count as "the one you're standing on".
const MAX_STAND_STEP = 1.5

/**
 * Terrain height at (x, z), searching downward from `fromY + probe`.
 *
 * Priority:
 *  1. If a surface sits at/just-below your feet (within `MAX_STAND_STEP`),
 *     that's what you're STANDING ON — keep it, even under a low overhang.
 *     This is what stops you falling through a ledge you've landed on.
 *  2. Otherwise you're stepping UP onto something above (e.g. a bridge deck
 *     from its edge): pick the nearest surface with `STAND_HEADROOM` clear
 *     above, so you land on the deck top, not its underside.
 *  3. Fall back to the nearest surface. Null off the mesh.
 */
export function groundHeight(meshes: THREE.Mesh[], x: number, z: number, fromY: number, probe = 2.5): number | null {
  downRay.set(new THREE.Vector3(x, fromY + probe, z), DOWN)
  downRay.far = probe + 60
  const hits = downRay.intersectObjects(meshes, false)
  if (!hits.length) return null
  if (hits.length === 1) return hits[0].point.y

  // (1) The surface you're standing on: highest hit at/just-above-to-within-a-
  // step-below your feet. Kept regardless of headroom.
  let foot: number | null = null
  for (const h of hits) {
    const y = h.point.y
    if (y <= fromY + 0.25 && y >= fromY - MAX_STAND_STEP && (foot === null || y > foot)) foot = y
  }
  if (foot !== null) return foot

  // (2) Stepping up onto something above → nearest standable (headroom).
  let best: number | null = null, bestDist = Infinity
  let nearest: number | null = null, nDist = Infinity
  for (const h of hits) {
    const y = h.point.y
    const d = Math.abs(y - fromY)
    if (d < nDist) { nDist = d; nearest = y }
    headRay.set(new THREE.Vector3(x, y + 0.2, z), UP)
    headRay.far = STAND_HEADROOM
    if (headRay.intersectObjects(meshes, false).length === 0 && d < bestDist) {
      bestDist = d; best = y
    }
  }
  return best ?? nearest
}

/** Which welded zone the player is standing in: raycast down and walk up to
 *  the `zone_<id>` placement group (loadWorld names them). Null off-mesh or for
 *  a single un-welded zone. Used to update the zone banner across a seam. */
export function zoneIdAt(meshes: THREE.Mesh[], x: number, z: number, fromY: number): string | null {
  downRay.set(new THREE.Vector3(x, fromY + 5, z), DOWN)
  downRay.far = 200
  const hit = downRay.intersectObjects(meshes, false)[0]
  if (!hit) return null
  for (let o: THREE.Object3D | null = hit.object; o; o = o.parent) {
    if (o.name && o.name.startsWith('zone_')) return o.name.slice(5)
  }
  return null
}

/** Highest solid surface within `maxDrop` below `fromY` (no headroom filter).
 *  Used for jump landing — you land on whatever you fall through, even a
 *  low/enclosed spot. Returns null if nothing is below within range. */
export function surfaceBelow(meshes: THREE.Mesh[], x: number, z: number, fromY: number, maxDrop: number): number | null {
  downRay.set(new THREE.Vector3(x, fromY, z), DOWN)
  downRay.far = maxDrop
  const hits = downRay.intersectObjects(meshes, false)
  if (!hits.length) return null
  let top: number | null = null
  for (const h of hits) if (top === null || h.point.y > top) top = h.point.y
  return top
}

// ─── Wall / prop collision ────────────────────────────────────────────────
const fwdRay = new THREE.Raycaster()
;(fwdRay as any).firstHitOnly = false
const PLAYER_RADIUS = 0.45        // world units
// A surface counts as a wall (blocks) only if it's steeper than ~55° — so
// ramps, stairs, and rolling terrain stay walkable while vertical faces
// (castle walls, crates, tree trunks, ladders) stop you.
const WALL_NORMAL_Y = 0.57
// Sample heights up the body so both low props (crates) and tall walls are
// caught. Knee + chest.
const PROBE_HEIGHTS = [0.4, 1.1]
const _origin = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _n = new THREE.Vector3()

// Wall-collision portals: world-space boxes where near-vertical surfaces do
// NOT block movement. Welded zones meet back-to-back at the original zoneline
// boundary walls (you'd normally "zone" through them); a portal at the seam
// carves a walkable doorway through those walls. Ground-snap is untouched, so
// you cross on the continuous ground. Set per loaded world by loadWorld.
let wallPortals: THREE.Box3[] = []
export function setWallPortals(boxes: THREE.Box3[]) { wallPortals = boxes }
function inPortal(p: THREE.Vector3): boolean {
  for (const b of wallPortals) if (b.containsPoint(p)) return true
  return false
}

// ─── Wall cutting (slice the dead-end zoneline caps off a weld) ─────────────
const _cutA = new THREE.Vector3(), _cutB = new THREE.Vector3(), _cutC = new THREE.Vector3()
const _cutN = new THREE.Vector3(), _cutCent = new THREE.Vector3()
const _cutE1 = new THREE.Vector3(), _cutE2 = new THREE.Vector3()
const _cutWBox = new THREE.Box3()

/**
 * Remove near-vertical (wall-like) triangles whose centroid falls inside any
 * cut box — used to slice the dead-end zoneline *cap* walls off both sides of a
 * weld so the two passages actually join. This removes the geometry outright,
 * so it fixes BOTH the visual (the cap is gone) AND collision (no triangle to
 * hit). Floors/ramps (|normal.y| ≥ WALL_NORMAL_Y) inside the box are KEPT, so
 * you still have ground to walk on.
 *
 * Idempotent: the first cut snapshots each mesh's original index, and every
 * call rebuilds from that snapshot — so moving/removing a box restores anything
 * it previously cut. Rebuilds the BVH so collision matches the new geometry.
 * Cheap: meshes whose world bounds don't touch any box are skipped untouched.
 */
export interface CutBox {
  box: THREE.Box3
  /** true → remove EVERY triangle in the box (floor + walls), to carve a clean
   *  hole; false (default) → only near-vertical wall faces, keeping floors. */
  all?: boolean
}
export function cutWallsInBoxes(meshes: THREE.Mesh[], cuts: CutBox[]) {
  for (const mesh of meshes) {
    const geo = mesh.geometry as THREE.BufferGeometry
    const ud = mesh.userData as any
    if (ud.__origIndex === undefined) ud.__origIndex = geo.index ? Array.from(geo.index.array) : null
    const orig: number[] | null = ud.__origIndex
    mesh.updateWorldMatrix(true, false)
    _cutWBox.setFromObject(mesh)
    const touches = cuts.some((c) => c.box.intersectsBox(_cutWBox))
    if (!touches) {
      if (ud.__cut) { geo.setIndex(orig); ud.__cut = false; rebuildBVH(geo) }   // restore
      continue
    }
    const pos = geo.attributes.position as THREE.BufferAttribute
    const triN = orig ? orig.length / 3 : pos.count / 3
    const mw = mesh.matrixWorld
    const out: number[] = []
    for (let t = 0; t < triN; t++) {
      const ia = orig ? orig[t * 3] : t * 3, ib = orig ? orig[t * 3 + 1] : t * 3 + 1, ic = orig ? orig[t * 3 + 2] : t * 3 + 2
      _cutA.fromBufferAttribute(pos, ia).applyMatrix4(mw)
      _cutB.fromBufferAttribute(pos, ib).applyMatrix4(mw)
      _cutC.fromBufferAttribute(pos, ic).applyMatrix4(mw)
      _cutCent.copy(_cutA).add(_cutB).add(_cutC).multiplyScalar(1 / 3)
      let cut = false
      for (const c of cuts) {
        if (c.box.containsPoint(_cutCent)) {
          if (c.all) { cut = true; break }   // remove everything inside
          _cutN.copy(_cutE1.copy(_cutB).sub(_cutA)).cross(_cutE2.copy(_cutC).sub(_cutA)).normalize()
          if (Math.abs(_cutN.y) < WALL_NORMAL_Y) cut = true   // walls only
          break
        }
      }
      if (!cut) out.push(ia, ib, ic)
    }
    geo.setIndex(out); ud.__cut = true; rebuildBVH(geo)
  }
}
function rebuildBVH(geo: THREE.BufferGeometry) {
  ;(geo as any).disposeBoundsTree?.()
  ;(geo as any).computeBoundsTree?.()
  geo.computeBoundingSphere()
}

/**
 * PERMANENTLY remove geometry inside the cut boxes (the editor's "commit"). Cuts
 * from the CURRENT geometry and makes it the new baseline — so once committed,
 * the removed triangles stay gone (a later move won't bring them back), and the
 * box can be cleared. Snapshots a pristine copy once for `restorePristine`.
 */
export function bakeCutInBoxes(meshes: THREE.Mesh[], cuts: CutBox[]) {
  for (const mesh of meshes) {
    const geo = mesh.geometry as THREE.BufferGeometry
    const ud = mesh.userData as any
    if (ud.__pristineIndex === undefined) ud.__pristineIndex = geo.index ? Array.from(geo.index.array) : null
    mesh.updateWorldMatrix(true, false)
    _cutWBox.setFromObject(mesh)
    if (!cuts.some((c) => c.box.intersectsBox(_cutWBox))) continue
    const cur = geo.index ? geo.index.array : null
    const pos = geo.attributes.position as THREE.BufferAttribute
    const triN = cur ? cur.length / 3 : pos.count / 3
    const mw = mesh.matrixWorld
    const out: number[] = []
    for (let t = 0; t < triN; t++) {
      const ia = cur ? cur[t * 3] : t * 3, ib = cur ? cur[t * 3 + 1] : t * 3 + 1, ic = cur ? cur[t * 3 + 2] : t * 3 + 2
      _cutA.fromBufferAttribute(pos, ia).applyMatrix4(mw)
      _cutB.fromBufferAttribute(pos, ib).applyMatrix4(mw)
      _cutC.fromBufferAttribute(pos, ic).applyMatrix4(mw)
      _cutCent.copy(_cutA).add(_cutB).add(_cutC).multiplyScalar(1 / 3)
      let cut = false
      for (const c of cuts) {
        if (c.box.containsPoint(_cutCent)) {
          if (c.all) { cut = true; break }
          _cutN.copy(_cutE1.copy(_cutB).sub(_cutA)).cross(_cutE2.copy(_cutC).sub(_cutA)).normalize()
          if (Math.abs(_cutN.y) < WALL_NORMAL_Y) cut = true
          break
        }
      }
      if (!cut) out.push(ia, ib, ic)
    }
    geo.setIndex(out); ud.__origIndex = out; ud.__cut = false; rebuildBVH(geo)
  }
}
/** Restore meshes to their pristine (pre-bake) geometry — the editor's "reset". */
export function restorePristine(meshes: THREE.Mesh[]) {
  for (const mesh of meshes) {
    const ud = mesh.userData as any
    if (ud.__pristineIndex === undefined) continue
    const geo = mesh.geometry as THREE.BufferGeometry
    geo.setIndex(ud.__pristineIndex as number[]); ud.__origIndex = ud.__pristineIndex; ud.__cut = false
    rebuildBVH(geo)
  }
}

/** True if moving from `pos` along (dx,dz) runs into a steep (wall-like)
 *  surface within the player's radius. Walkable slopes — and surfaces inside a
 *  wall portal (the welded-zone doorway) — are ignored. */
function hitsWall(meshes: THREE.Mesh[], pos: THREE.Vector3, dx: number, dz: number): boolean {
  const len = Math.hypot(dx, dz)
  if (len < 1e-5) return false
  const reach = len + PLAYER_RADIUS
  _dir.set(dx / len, 0, dz / len)
  for (const hy of PROBE_HEIGHTS) {
    _origin.set(pos.x, pos.y + hy, pos.z)
    fwdRay.set(_origin, _dir)
    fwdRay.far = reach
    for (const h of fwdRay.intersectObjects(meshes, false)) {
      if (!h.face) continue
      _n.copy(h.face.normal).transformDirection(h.object.matrixWorld)
      if (Math.abs(_n.y) < WALL_NORMAL_Y) {            // near-vertical → wall
        if (wallPortals.length && inPortal(h.point)) continue   // doorway — pass
        return true
      }
    }
  }
  return false
}

// Climb detection probes lower + higher than wall collision (you grab a
// ladder while floating low in water or standing on a ledge) and reaches a
// touch further so contact isn't lost between frames.
const LADDER_PROBE_HEIGHTS = [0.0, 0.6, 1.2, 1.8, 2.5, 3.2]
const LADDER_REACH = PLAYER_RADIUS + 0.6

/** True if a ladder prop is within reach in the move direction — the cue to
 *  climb instead of collide. */
export function ladderAhead(ladderMeshes: THREE.Mesh[], pos: THREE.Vector3, dx: number, dz: number): boolean {
  if (!ladderMeshes.length) return false
  const len = Math.hypot(dx, dz)
  if (len < 1e-5) return false
  _dir.set(dx / len, 0, dz / len)
  for (const hy of LADDER_PROBE_HEIGHTS) {
    _origin.set(pos.x, pos.y + hy, pos.z)
    fwdRay.set(_origin, _dir)
    fwdRay.far = len + LADDER_REACH
    if (fwdRay.intersectObjects(ladderMeshes, false).length) return true
  }
  return false
}

/**
 * Find the ledge to climb a ladder onto: scan forward (the move direction)
 * at a few distances for the lowest walkable surface at-or-above the
 * player's feet, up to `maxUp` above. Returns the stand position the climb
 * commits to (so a ladder that ends below its ledge is still bridged), or
 * null if nothing climbable is ahead.
 */
export function findLedge(
  meshes: THREE.Mesh[], pos: THREE.Vector3, dx: number, dz: number, maxUp = 9,
): THREE.Vector3 | null {
  const len = Math.hypot(dx, dz)
  if (len < 1e-5) return null
  const fx = dx / len, fz = dz / len
  let best: THREE.Vector3 | null = null
  for (const dist of [PLAYER_RADIUS + 0.3, PLAYER_RADIUS + 0.9, PLAYER_RADIUS + 1.6]) {
    const px = pos.x + fx * dist
    const pz = pos.z + fz * dist
    _origin.set(px, pos.y + maxUp, pz)
    fwdRay.set(_origin, DOWN)
    fwdRay.far = maxUp + 2
    // Lowest hit at/above the feet = the first ledge above us (not a roof).
    let cand: number | null = null
    for (const h of fwdRay.intersectObjects(meshes, false)) {
      const y = h.point.y
      if (y > pos.y - 0.4 && (cand === null || y < cand)) cand = y
    }
    if (cand !== null && (best === null || cand < best.y)) {
      best = new THREE.Vector3(px, cand, pz)
    }
  }
  return best
}

// Obstacles shorter than this (bridge decks, curbs, single stairs) are
// auto-stepped onto rather than blocking — the ground-snap then lifts you.
const STEP_HEIGHT = 1.2

const _up = new THREE.Vector3(0, 1, 0)
const PLAYER_HEIGHT = 1.7         // headroom needed to stand on a surface

/** Can the player step up over the obstacle ahead? True when nothing
 *  wall-like is hit ABOVE step height (so it's a low ledge, not a tall
 *  wall), there's walkable ground just past it within step height, AND that
 *  ground has standing headroom (so you step ONTO a surface, never INTO an
 *  enclosed structure like the inside of a bridge). */
function canStepOver(meshes: THREE.Mesh[], pos: THREE.Vector3, dx: number, dz: number): boolean {
  const len = Math.hypot(dx, dz)
  if (len < 1e-5) return false
  _dir.set(dx / len, 0, dz / len)
  // Anything wall-like at chest-above-step height → it's a real wall.
  _origin.set(pos.x, pos.y + STEP_HEIGHT + 0.2, pos.z)
  fwdRay.set(_origin, _dir)
  fwdRay.far = len + PLAYER_RADIUS
  for (const h of fwdRay.intersectObjects(meshes, false)) {
    if (!h.face) continue
    _n.copy(h.face.normal).transformDirection(h.object.matrixWorld)
    if (Math.abs(_n.y) < WALL_NORMAL_Y) return false
  }
  // Walkable ground just past the obstacle, within a step's rise?
  const fx = pos.x + _dir.x * (PLAYER_RADIUS + 0.25)
  const fz = pos.z + _dir.z * (PLAYER_RADIUS + 0.25)
  const g = groundHeight(meshes, fx, fz, pos.y + STEP_HEIGHT)
  if (g === null || g - pos.y <= 0.05 || g - pos.y > STEP_HEIGHT) return false
  // Headroom above that surface: a ceiling right above means we'd be
  // stepping INTO a structure (bridge interior, low arch) — refuse.
  _origin.set(fx, g + 0.1, fz)
  fwdRay.set(_origin, _up)
  fwdRay.far = PLAYER_HEIGHT
  return fwdRay.intersectObjects(meshes, false).length === 0
}

/** Blocked = hits a wall AND can't simply step up onto it. */
function blocked(meshes: THREE.Mesh[], pos: THREE.Vector3, dx: number, dz: number): boolean {
  return hitsWall(meshes, pos, dx, dz) && !canStepOver(meshes, pos, dx, dz)
}

/**
 * Resolve an intended (dx,dz) step against zone walls/props. Returns the
 * allowed movement: full if clear (or steppable), else slid along whichever
 * axis is open (so you skim along walls instead of sticking), else zero.
 *
 * Anti-trap: if every direction is blocked — including straight back — the
 * player is enclosed inside a prop (clipped into a tree trunk, say). Sitting
 * against a single wall leaves the reverse open, so that stays solid; only a
 * true enclosure lets the move through so you can climb back out.
 */
export function collideSlide(
  meshes: THREE.Mesh[], pos: THREE.Vector3, dx: number, dz: number,
): { dx: number; dz: number } {
  if (!blocked(meshes, pos, dx, dz)) return { dx, dz }
  if (Math.abs(dx) > 1e-4 && !blocked(meshes, pos, dx, 0)) return { dx, dz: 0 }
  if (Math.abs(dz) > 1e-4 && !blocked(meshes, pos, 0, dz)) return { dx: 0, dz }
  if (blocked(meshes, pos, -dx, -dz)) return { dx, dz }   // enclosed → escape
  return { dx: 0, dz: 0 }
}

// ─── Camera cutaway (the primary "see your character" mechanism) ───────────
/**
 * Slices away zone geometry that is BOTH between the camera and the player
 * AND above the player's head — overhanging cliff faces, roofs, walls,
 * canopy — without removing the low foreground ground (which would leave
 * black voids). Two clipping planes with `clipIntersection = true`: a
 * fragment is discarded only where *both* clip:
 *   1. camera plane — camera-side of a plane just in front of the player
 *   2. height plane — above playerY + head clearance
 *
 * Requires `renderer.localClippingEnabled = true`. Only zone materials get
 * the planes, so characters/mobs/HUD are never clipped.
 */
export class CameraCutaway {
  /** Initialised far away so nothing clips before the first update. */
  private camPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e9)
  private heightPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 1e9)
  private dir = new THREE.Vector3()
  private camPos = new THREE.Vector3()
  private point = new THREE.Vector3()

  attach(meshes: THREE.Mesh[]) {
    for (const m of meshes) {
      const mat = m.material as THREE.MeshStandardMaterial
      if (mat) {
        mat.clippingPlanes = [this.camPlane, this.heightPlane]
        mat.clipIntersection = true
      }
    }
  }

  update(camera: THREE.Camera, playerPos: THREE.Vector3, margin = 2.5, headroom = 2.4) {
    camera.getWorldPosition(this.camPos)
    this.dir.copy(playerPos).sub(this.camPos).normalize()
    this.point.copy(playerPos).addScaledVector(this.dir, -margin)
    this.camPlane.setFromNormalAndCoplanarPoint(this.dir, this.point)
    // Clips where distance < 0 → everything above playerY + headroom.
    this.heightPlane.normal.set(0, -1, 0)
    this.heightPlane.constant = playerPos.y + headroom
  }
}

// ─── Occlusion fading (Diablo-style cutaway) ───────────────────────────────
/**
 * Fades any zone geometry that sits between the camera and the player —
 * roofs, castle walls, tree canopies — so indoor areas read like other
 * isometric games. Fading happens per *material* (the zone renders one
 * primitive per material), which in practice reads as "this kind of
 * surface gets see-through" and is visually consistent.
 */
export class OcclusionFader {
  private ray = new THREE.Raycaster()
  private faded = new Set<THREE.MeshStandardMaterial>()

  update(camera: THREE.Camera, playerPos: THREE.Vector3, meshes: THREE.Mesh[]) {
    const camPos = new THREE.Vector3()
    camera.getWorldPosition(camPos)
    // Aim at the player's torso so a low doorsill doesn't trigger the fade.
    const target = playerPos.clone().setY(playerPos.y + 1.0)
    const dir = target.clone().sub(camPos)
    const dist = dir.length()
    dir.normalize()
    this.ray.set(camPos, dir)
    this.ray.far = dist - 0.5

    const nowFaded = new Set<THREE.MeshStandardMaterial>()
    for (const hit of this.ray.intersectObjects(meshes, false)) {
      const mat = (hit.object as THREE.Mesh).material as THREE.MeshStandardMaterial
      if (mat) nowFaded.add(mat)
    }
    // Fade in newly-occluding materials…
    for (const mat of nowFaded) {
      if (!this.faded.has(mat)) {
        mat.transparent = true
        mat.opacity = 0.28
        mat.depthWrite = false
        this.faded.add(mat)
      }
    }
    // …and restore the rest.
    for (const mat of [...this.faded]) {
      if (!nowFaded.has(mat)) {
        mat.opacity = 1
        mat.transparent = mat.alphaTest > 0   // keep MASK materials correct
        mat.depthWrite = true
        this.faded.delete(mat)
      }
    }
  }

  reset() {
    for (const mat of this.faded) {
      mat.opacity = 1
      mat.transparent = mat.alphaTest > 0
      mat.depthWrite = true
    }
    this.faded.clear()
  }
}
