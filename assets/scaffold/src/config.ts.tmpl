import Schema from '@deepseek-ai/schemastery'

export const MODES = ['upper', 'lower', 'title'] as const
export type Mode = (typeof MODES)[number]

export interface Config {
  defaultMode: Mode
  maxLength: number
}

/** Cordis receives a real Standard Schema, not a TypeScript-only type. */
export const Config: Schema<Config> = Schema.object({
  defaultMode: Schema.union(MODES)
    .default('upper')
    .description('Transformation used when a tool call omits mode.'),
  maxLength: Schema.number()
    .min(1)
    .max(100_000)
    .default(10_000)
    .description('Maximum input Unicode code points; longer text is explicitly reported as truncated.'),
})

const CONFIG_KEYS = new Set(['defaultMode', 'maxLength'])

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Direct tests and programmatic callers can bypass Loader validation. Recheck
 * the small security boundary and reject unknown keys instead of retaining them.
 */
export function normalizeConfig(value: unknown): Config {
  const candidate = value ?? {}
  if (!plainRecord(candidate)) throw new TypeError('config must be a plain object')
  const unknown = Object.keys(candidate).filter(key => !CONFIG_KEYS.has(key)).sort()
  if (unknown.length > 0) throw new TypeError(`unknown config key(s): ${unknown.join(', ')}`)
  // Schemastery's callable type expects the post-default interface even though
  // the runtime schema accepts a partial object and supplies both defaults.
  const parsed = Config(candidate as unknown as Config)
  return { defaultMode: parsed.defaultMode, maxLength: parsed.maxLength }
}
