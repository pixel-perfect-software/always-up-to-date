import path from 'path'

/** The file `name` of `cwd` and of each parent, nearest first, the filesystem root last. */
export const ancestorFiles = (cwd: string, name: string): string[] => {
  const files: string[] = []
  let dir = path.resolve(cwd)
  for (;;) {
    files.push(path.join(dir, name))
    const parent = path.dirname(dir)
    if (parent === dir) return files
    dir = parent
  }
}

/**
 * `from` and each parent up to and including `to`, nearest first. When `to`
 * is not `from` or one of its ancestors, only `from`.
 */
export const ancestorDirs = (from: string, to: string): string[] => {
  const end = path.resolve(to)
  const dirs: string[] = []
  let dir = path.resolve(from)
  for (;;) {
    dirs.push(dir)
    if (dir === end) return dirs
    const parent = path.dirname(dir)
    if (parent === dir) return [path.resolve(from)]
    dir = parent
  }
}
