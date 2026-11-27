import { fn } from 'provino'

const logger = {
  info: fn(),
  success: fn(),
  warn: fn(),
  error: fn(),
  command: fn(),
  workspace: fn(),
  memberRun: fn(),
  allUpToDate: fn(),
  updatingHeader: fn(),
  report: fn(),
  starting: fn(),
  clean: fn(),
  debug: fn(),
  configure: fn(),
  setQuiet: fn(),
  setJsonOutput: fn(),
}

export const pluralize = fn(
  (n: number, sing: string, plural?: string) =>
    `${n} ${n === 1 ? sing : (plural ?? `${sing}s`)}`,
)

export default logger
