const logger = {
  info: jest.fn(),
  success: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  command: jest.fn(),
  workspace: jest.fn(),
  memberRun: jest.fn(),
  allUpToDate: jest.fn(),
  updatingHeader: jest.fn(),
  report: jest.fn(),
  starting: jest.fn(),
  clean: jest.fn(),
  debug: jest.fn(),
  configure: jest.fn(),
  setQuiet: jest.fn(),
  setJsonOutput: jest.fn(),
}

export const pluralize = jest.fn(
  (n: number, sing: string, plural?: string) =>
    `${n} ${n === 1 ? sing : (plural ?? `${sing}s`)}`,
)

export default logger
