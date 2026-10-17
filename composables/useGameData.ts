import { setMobs } from '~/data/mobs'
import { setZones } from '~/data/zones'
import { publicPath } from '~/utils/publicPath'

let loadPromise: Promise<void> | null = null

async function loadRunData() {
  const fetchData = async <T>(name: string): Promise<T> => {
    const response = await fetch(publicPath(`/gamedata/${name}.json`))
    if (!response.ok) throw new Error(`Could not load ${name}.json (${response.status}).`)
    const payload = await response.json() as { data: T }
    return payload.data
  }

  const [mobs, zones] = await Promise.all([
    fetchData<Parameters<typeof setMobs>[0]>('mobs'),
    fetchData<Parameters<typeof setZones>[0]>('zones'),
  ])
  setMobs(mobs)
  setZones(zones)
}

export function useGameData() {
  return {
    ready(): Promise<void> {
      if (!loadPromise) loadPromise = loadRunData()
      return loadPromise
    },
  }
}
