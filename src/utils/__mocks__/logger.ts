const logger = {
  info: jest.fn(),
  success: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  command: jest.fn(),
  workspace: jest.fn(),
  allUpToDate: jest.fn(),
  outdatedHeader: jest.fn(),
  packageGroupHeader: jest.fn(),
  printOutdatedRows: jest.fn(),
  printUpdatingRows: jest.fn(),
  printSkippedRows: jest.fn(),
  updatingHeader: jest.fn(),
  noPackagesToUpdate: jest.fn(),
  cooldownSummary: jest.fn(),
  starting: jest.fn(),
  clean: jest.fn(),
  debug: jest.fn(),
  setQuiet: jest.fn(),
}

export const pluralize = jest.fn(
  (n: number, sing: string, plural?: string) =>
    `${n} ${n === 1 ? sing : (plural ?? `${sing}s`)}`,
)

export default logger
