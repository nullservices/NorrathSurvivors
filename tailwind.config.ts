import type { Config } from 'tailwindcss'

export default <Partial<Config>>{
  content: ['./app.vue', './pages/**/*.{vue,ts}'],
  theme: { extend: {} },
}
