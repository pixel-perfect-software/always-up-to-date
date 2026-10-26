import fs from 'fs'

/** How the project's package manager writes a new spec: exact, or with a prefix. */
export interface SaveStyle {
  exact: boolean
  prefix: string
}

export const DEFAULT_SAVE_STYLE: SaveStyle = { exact: false, prefix: '^' }

/** A text file's content, or '' when it can't be read. */
export const readTextFile = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** A value without its surrounding quotes (`"` or `'`). */
export const unquote = (value: string): string =>
  value.trim().replace(/^(['"])(.*)\1$/, '$2')

/** A top-level `key: value` from a YAML file, quotes removed. */
export const yamlValue = (content: string, key: string): string | undefined => {
  const match = new RegExp(`^${key}:\\s*(['"]?)(.*?)\\1\\s*(#.*)?$`, 'm').exec(
    content,
  )
  return match?.[2]
}
