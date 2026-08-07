import { defineConfig } from '@moeru/eslint-config'

export default defineConfig({
  masknet: false,
  perfectionist: true,
  preferArrow: false,
  sonarjs: false,
  sortPackageJsonScripts: false,
  typescript: true,
  unocss: true,
  vue: true,
}, {
  ignores: [
    'cspell.config.yaml',
    'cspell.config.yml',
    'crowdin.yaml',
    'crowdin.yml',
    '**/assets/js/**',
    '**/assets/live2d/models/**',
    'apps/stage-tamagotchi/out/**',
    'apps/stage-tamagotchi/src/bindings/**',
    'apps/stage-tamagotchi-electron/out/**',
    'apps/stage-tamagotchi-electron/src/renderer/bindings/**',

    '**/drizzle/**',
    '**/.astro/**',
    'docs/superpowers/**',
    '.agents/**',
    '.github/**',
    'CLAUDE.md', // Skip the symbolic link
    // NOTICE:
    // Debug PRDs and investigation notes are not production code; they contain
    // ad-hoc markdown (images without alt text, inline diffs) that the markdown
    // linter flags. Excluded so pre-commit --fix does not block commits.
    'PRD&debug/**',
  ],
}, {
  rules: {
    'antfu/import-dedupe': 'error',
    // TODO: remove this
    'depend/ban-dependencies': 'warn',
    'import/order': 'off',
    'markdown/require-alt-text': 'off',
    'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
    // Catches the manual `error instanceof Error ? error.message : ...`
    // pattern AGENTS.md forbids. The selector matches a ConditionalExpression
    // whose test is `<x> instanceof Error` and whose consequent is `<x>.message`,
    // so it does NOT false-positive on `error instanceof Error ? error : new Error(...)`
    // (where the consequent is the error itself, not its `.message`). Antfu's
    // default no-restricted-syntax patterns are preserved alongside.
    'no-restricted-syntax': [
      'warn',
      {
        message: 'Avoid `error instanceof Error ? error.message : ...`. Use `errorMessageFrom(error)` from \'@moeru/std\' (or `errorMessageFromUnknown(error, fallback)` from \'@proj-airi/stage-shared\'). Pair with `?? \'fallback\'` when a default is needed.',
        selector: 'ConditionalExpression[test.type=\'BinaryExpression\'][test.operator=\'instanceof\'][test.right.name=\'Error\'][consequent.type=\'MemberExpression\'][consequent.property.name=\'message\']',
      },
      'TSEnumDeclaration[const=true]',
      'TSExportAssignment',
    ],
    'pnpm/json-enforce-catalog': 'off',

    'pnpm/json-valid-catalog': 'off',

    'pnpm/yaml-enforce-settings': 'off',
    // NOTICE:
    // The catalog in pnpm-workspace.yaml serves as a centralized version registry.
    // After apps/server was removed, many catalog entries are no longer referenced
    // by any package.json. This is expected during the transitional period — the
    // entries are kept as version pins for future re-use. Re-enable this rule
    // once the catalog is cleaned up or the backend is restored.
    // Removal condition: apps/server is restored or unused catalog entries are removed.
    'pnpm/yaml-no-unused-catalog-item': 'off',
    // 'sonarjs/cognitive-complexity': 'off',
    // 'sonarjs/no-commented-code': 'off',
    // 'sonarjs/pseudo-random': 'off',
    'style/padding-line-between-statements': 'error',
    'vue/prefer-separate-static-class': 'off',
    'yaml/plain-scalar': 'off',
  },
}, {
  // NOTICE:
  // The `apps/server` backend was removed in a repo restructure. These test
  // hygiene rules (no vi.mock for internal modules, no vi.hoisted) were scoped
  // to that package. They are preserved here as a global guard so the pattern
  // does not reappear in other test files. Remove the `files` filter to apply
  // to all test files; keep it empty to target nothing (dead config).
  // Removal condition: apps/server is restored or these rules are added globally.
  // files: ['apps/server/**/*.ts'],
  ignores: [
    '**/*.md',
  ],
  rules: {
    'perfectionist/sort-imports': [
      'error',
      {
        groups: [
          'type-builtin',
          'type-import',
          'type-internal',
          ['type-parent', 'type-sibling', 'type-index'],
          'default-value-builtin',
          'named-value-builtin',
          'value-builtin',
          'default-value-external',
          'named-value-external',
          'value-external',
          'default-value-internal',
          'named-value-internal',
          'value-internal',
          ['default-value-parent', 'default-value-sibling', 'default-value-index'],
          ['named-value-parent', 'named-value-sibling', 'named-value-index'],
          ['wildcard-value-parent', 'wildcard-value-sibling', 'wildcard-value-index'],
          ['value-parent', 'value-sibling', 'value-index'],
          'side-effect',
          'style',
        ],
        newlinesBetween: 1,
      },
    ],
  },
})
