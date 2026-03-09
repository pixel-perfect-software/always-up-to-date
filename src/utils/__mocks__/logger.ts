const logger = {
  info: jest.fn(),
  success: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  packageOperation: jest.fn(),
  command: jest.fn(),
  workspace: jest.fn(),
  allUpToDate: jest.fn(),
  outdatedHeader: jest.fn(),
  outdatedPackage: jest.fn(),
  packageGroupHeader: jest.fn(),
  outdatedPackageInGroup: jest.fn(),
  updatingHeader: jest.fn(),
  updatingPackage: jest.fn(),
  skippingPackage: jest.fn(),
  starting: jest.fn(),
  clean: jest.fn(),
  debug: jest.fn(),
  setQuiet: jest.fn(),
}

export default logger
