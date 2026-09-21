import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import devApiRoutes from './scripts/dev-api.js'

// https://vite.dev/config/
export default defineConfig({
  // devApiRoutes is dev-only; it makes the Vercel functions under api/
  // reachable from `npm run dev` instead of only after a deploy.
  plugins: [react(), tailwindcss(), devApiRoutes()],
})
