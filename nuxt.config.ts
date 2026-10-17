const publicBaseURL = process.env.NUXT_APP_BASE_URL || '/'

export default defineNuxtConfig({
  compatibilityDate: '2025-05-25',
  devtools: { enabled: false },
  css: ['~/assets/css/main.css'],
  typescript: { strict: true, typeCheck: false },
  modules: ['@nuxtjs/tailwindcss'],
  vite: {
    cacheDir: '.nuxt/vite',
    define: { __PUBLIC_BASE_URL__: JSON.stringify(publicBaseURL) },
  },
  app: {
    baseURL: publicBaseURL,
    head: {
      title: 'Norrath Survivors',
      meta: [
        { charset: 'utf-8' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1' },
        { name: 'description', content: 'An EverQuest survivors-like in the Crushbone orc stronghold.' },
      ],
    },
  },
})
