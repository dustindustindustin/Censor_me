module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  rules: {
    // Allow explicit any sparingly; prefer typed alternatives
    '@typescript-eslint/no-explicit-any': 'warn',
    // Unused vars are already caught by tsconfig noUnusedLocals
    '@typescript-eslint/no-unused-vars': 'off',
  },
}
