import * as THREE from 'three'

/**
 * Cross-race animation retargeting for the converted EQ rigs.
 *
 * Several legacy player models converted with zero (or partial) animation
 * clips, but the rigs themselves are structurally identical across races —
 * every bone is `<RACE><suffix>` (e.g. `ELMPE_DAG` / `DAMPE_DAG`), with at
 * most an attachment point or two of difference (verified by
 * tmp/compare-rigs.mjs). So a fully-animated donor's clips can be applied
 * to a bare rig by renaming each track's 3-letter bone prefix and dropping
 * tracks whose renamed bone doesn't exist on the target.
 */

/** Bone-name prefix for a model code: `elm` → `ELM`, `ogf` → `OGF`. */
function bonePrefix(code: string): string {
  return code.slice(0, 3).toUpperCase()
}

/**
 * Per-model primitive hide list, for conversions that packed multiple
 * texture-variant primitives stacked on top of each other. The hlm
 * (Halas citizen NPC, no longer a player rig) head ships several variants
 * at once — bare head is 0001 (face) + 0002 (hair); 0003-0007 are
 * helmet/white/black variants that render outermost and mask the face.
 * Every player rig audited clean (tmp/inspect-mats.mjs).
 */
const HIDDEN_MATERIALS: Record<string, RegExp> = {
  hlm: /^HLMHE000[3-7]_MDF$/i,
}

/**
 * Repair converter defects on a loaded rig:
 *  1. hide stacked variant primitives (HIDDEN_MATERIALS above);
 *  2. materials that converted with NO texture image (dark elf male chest
 *     `DAMCH0001` + legs `DAMLG0002` — they render flat white) borrow the
 *     map from another material of the same body part (CH/LG/…), whose
 *     cloth reads correctly even if the UV layout isn't an exact match.
 * Idempotent; safe to run on shared/cached models.
 */
export function fixupRig(code: string, root: THREE.Object3D): void {
  const hide = HIDDEN_MATERIALS[code]
  type Mat = THREE.MeshStandardMaterial
  const part = (name: string) => name.slice(3, 5)   // DAMCH0001_MDF → CH

  // Pass 1: collect a textured donor map per body part.
  const partMaps = new Map<string, THREE.Texture>()
  root.traverse((o) => {
    const mat = (o as THREE.Mesh).material as Mat | undefined
    if (!mat?.name?.endsWith('_MDF') || !mat.map) return
    const p = part(mat.name)
    if (!partMaps.has(p)) partMaps.set(p, mat.map)
  })

  // Pass 2: hide variant stacks, patch texture-less materials.
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    const mat = mesh.material as Mat | undefined
    if (!mat?.name?.endsWith('_MDF')) return
    if (hide?.test(mat.name)) {
      mesh.visible = false
      return
    }
    if (!mat.map) {
      const donorMap = partMaps.get(part(mat.name))
      if (donorMap) {
        mat.map = donorMap
        mat.needsUpdate = true
      }
    }
  })
}

/** Clip code for dedupe/lookup: `c05a_elm` → `c05`. */
function clipCode(name: string): string {
  return name.split('_')[0].toLowerCase().replace(/[abg]$/, '')
}

/**
 * Rename `donorCode`'s clips onto the rig under `targetRoot` (a model whose
 * bones use `targetCode`'s prefix). Tracks targeting bones the rig doesn't
 * have are dropped; clips that end up nearly empty are discarded.
 */
export function retargetClips(
  donorClips: THREE.AnimationClip[],
  donorCode: string,
  targetCode: string,
  targetRoot: THREE.Object3D,
): THREE.AnimationClip[] {
  const from = bonePrefix(donorCode)
  const to = bonePrefix(targetCode)
  const targetBones = new Set<string>()
  targetRoot.traverse((o) => targetBones.add(o.name))

  const out: THREE.AnimationClip[] = []
  for (const clip of donorClips) {
    const tracks: THREE.KeyframeTrack[] = []
    for (const t of clip.tracks) {
      const dot = t.name.indexOf('.')
      const node = dot === -1 ? t.name : t.name.slice(0, dot)
      const prop = dot === -1 ? '' : t.name.slice(dot)
      const renamed = node.startsWith(from) ? to + node.slice(from.length) : node
      if (!targetBones.has(renamed)) continue
      const nt = t.clone()
      nt.name = renamed + prop
      tracks.push(nt)
    }
    // Skip clips that lost most of their content in the transfer.
    if (tracks.length >= clip.tracks.length * 0.5 && tracks.length > 3) {
      out.push(new THREE.AnimationClip(clip.name, clip.duration, tracks))
    }
  }
  return out
}

/**
 * Merge a rig's native clips with retargeted donor clips, deduped by EQ
 * clip code. The fuller clip wins — e.g. legacy `hum`'s native `p01` only
 * animates 9 of 51 tracks (T-pose arms), so the donor's complete `p01`
 * replaces it.
 */
export function mergeClips(
  native: THREE.AnimationClip[],
  donated: THREE.AnimationClip[],
): THREE.AnimationClip[] {
  const byCode = new Map<string, THREE.AnimationClip>()
  for (const c of [...native, ...donated]) {
    const code = clipCode(c.name)
    const existing = byCode.get(code)
    if (!existing || c.tracks.length > existing.tracks.length) byCode.set(code, c)
  }
  return [...byCode.values()]
}
