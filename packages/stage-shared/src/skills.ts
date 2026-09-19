/**
 * Runtime skill contract shared by the Electron main process and the renderer.
 *
 * A skill is a directory that contains a `SKILL.md` file: YAML frontmatter with
 * at least a name and a description, plus an optional `references/**` tree that
 * is loaded on demand. The main process discovers skills; the renderer lists
 * them in the system prompt and reads them through a tool.
 */

/** File name every skill directory must provide. */
export const SKILL_FILE_NAME = 'SKILL.md'

/**
 * Directory a skill keeps its on-demand documents in.
 *
 * Reference paths handed to consumers are relative to the skill directory, so
 * they stay valid when a skill root moves.
 */
export const SKILL_REFERENCES_DIRECTORY = 'references'

/**
 * Root that contributed a skill, ordered from lowest to highest precedence.
 *
 * A skill id discovered in a later root replaces the same id from an earlier
 * root, so a workspace skill can override a bundled one without renaming it.
 */
export const SKILL_SOURCE_PRECEDENCE = ['bundled', 'user', 'workspace'] as const

/** Request for one skill body or one of its reference documents. */
export interface SkillReadInput {
  /** Skill id from the listing. */
  id: string
  /**
   * Reference path from {@link SkillSummary.references}. Omit it to read the
   * `SKILL.md` body.
   */
  reference?: string
}

/** Content of one skill body or reference document. */
export interface SkillReadResult {
  /** Body text with frontmatter stripped, or the raw reference document. */
  content: string
  id: string
  /** Whether the content came from the skill body or a reference document. */
  kind: 'reference' | 'skill'
  /** Absolute path that was read. */
  path: string
  /** Present when {@link kind} is `reference`. */
  reference?: string
}

/** Every skill discoverable by the current process, plus the scanned roots. */
export interface SkillSnapshot {
  /** Scanned roots in ascending precedence, whether or not they existed. */
  directories: { path: string, source: SkillSource }[]
  /** Discovered skills, ordered by id. */
  skills: SkillSummary[]
}

/** Root that contributed one discovered skill. */
export type SkillSource = (typeof SKILL_SOURCE_PRECEDENCE)[number]

/** One skill as advertised to the model, without its body. */
export interface SkillSummary {
  /**
   * Frontmatter `description`, falling back to the first non-empty body line
   * so every discovered skill stays usable in a listing.
   */
  description: string
  /** Stable id: the skill directory name. */
  id: string
  /**
   * Frontmatter `name`, falling back to the directory name when the skill
   * omits one.
   */
  name: string
  /** Absolute path of the skill's `SKILL.md`. */
  path: string
  /**
   * Reference documents inside the skill directory, as paths relative to that
   * directory (so they keep the `references/` prefix) and sorted for stable
   * listings.
   */
  references: string[]
  /** Root that contributed this skill. */
  source: SkillSource
}
