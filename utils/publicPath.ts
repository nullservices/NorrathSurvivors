/** Resolve files copied from `public/` under Nuxt's configured site base path. */
declare const __PUBLIC_BASE_URL__: string

export function publicPath(path: string): string {
  const relative = path.replace(/^\/+/, '')
  const base = __PUBLIC_BASE_URL__.endsWith('/') ? __PUBLIC_BASE_URL__ : `${__PUBLIC_BASE_URL__}/`
  return `${base}${relative}`
}
