import * as THREE from 'three'
import { publicPath } from '~/utils/publicPath'

/**
 * Creature texture variants. EQ npc_types.texture selects a skin variant on
 * the shared creature model — e.g. the orc model is Antonica orcs at
 * variant 0 (the only one baked into the GLB) and Faydwer/Crushbone orcs at
 * variant 1. The non-zero variant bitmaps were pulled out by
 * scripts/build-mob-textures.mjs into /eq-assets/mobtex/.
 *
 * A material's name encodes its slot: `<CODE><PART><variant(2)><frame(2)>_MDF`
 * (e.g. ORCCH0001_MDF = orc chest, variant 00, frame 01). To re-skin we
 * find every variant-00 material and swap its base texture for
 * `<code><part>0<V><frame>.png`.
 *
 * Variant materials are cached per (code, part, variant, frame) and shared
 * across all mobs of that variant — mobs with the same texture id are meant
 * to look identical, and sharing keeps memory flat. Mobs at variant 0 keep
 * the GLB's original (shared) materials untouched.
 */

const variantMat = new Map<string, THREE.MeshStandardMaterial>()
const texCache = new Map<string, THREE.Texture | null>()
const texLoader = new THREE.TextureLoader()

function loadTex(url: string): Promise<THREE.Texture | null> {
  if (texCache.has(url)) return Promise.resolve(texCache.get(url) ?? null)
  return new Promise((res) => {
    texLoader.load(url, (t) => {
      t.flipY = false
      t.colorSpace = THREE.SRGBColorSpace
      t.wrapS = THREE.RepeatWrapping
      t.wrapT = THREE.RepeatWrapping
      texCache.set(url, t)
      res(t)
    }, undefined, () => { texCache.set(url, null); res(null) })
  })
}

/**
 * Re-skin a loaded creature model to texture `variant`. No-op for variant 0
 * (the GLB's baked skin). Parts without a variant texture keep the base.
 */
export function applyMobVariant(root: THREE.Object3D, code: string, variant: number): void {
  if (!variant || variant <= 0) return
  const vv = String(variant).padStart(2, '0')
  const prefix = code.toUpperCase()
  const re = new RegExp(`^${prefix}([A-Z]{2})00(\\d{2})_MDF$`)
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    const mat = mesh.material as THREE.MeshStandardMaterial | undefined
    if (!mat?.name) return
    const m = re.exec(mat.name)
    if (!m) return
    const part = m[1].toLowerCase()
    const frame = m[2]
    const file = `${code}${part}${vv}${frame}`   // e.g. orcch0101
    let vmat = variantMat.get(file)
    if (!vmat) {
      vmat = mat.clone()
      // Clone keeps the base map; swap it once the variant texture loads.
      // (If the variant png is missing, the base skin stays.)
      void loadTex(publicPath(`/eq-assets/mobtex/${file}.png`)).then((tex) => {
        if (tex && vmat) { vmat.map = tex; vmat.needsUpdate = true }
      })
      variantMat.set(file, vmat)
    }
    mesh.material = vmat
  })
}
