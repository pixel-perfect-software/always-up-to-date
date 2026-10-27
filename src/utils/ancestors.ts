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
