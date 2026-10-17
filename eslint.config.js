import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // The serverless handlers (server/), the catch-all function that dispatches
    // to them (api/), and the dev API middleware run in Node, not in the browser.
    files: ['api/**/*.js', 'server/**/*.js', 'scripts/**/*.js'],
    languageOptions: { globals: globals.node },
  },
])
