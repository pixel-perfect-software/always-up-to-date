import BunManager from '@/managers/bun'
import NPMManager from '@/managers/npm'
import PackageManager from '@/managers/packageManager'
import PNPMManager from '@/managers/pnpm'
import YarnManager from '@/managers/yarn'

jest.mock('@/utils', () => ({
  execAsync: jest.fn(),
  logger: {
    command: jest.fn(),
    error: jest.fn(),
    starting: jest.fn(),
    workspace: jest.fn(),
    allUpToDate: jest.fn(),
    outdatedHeader: jest.fn(),
    packageGroupHeader: jest.fn(),
    outdatedPackageInGroup: jest.fn(),
    updatingHeader: jest.fn(),
    info: jest.fn(),
    skippingPackage: jest.fn(),
  },
  loadConfig: jest.fn(() => ({
    allowMinorUpdates: false,
    allowMajorUpdates: false,
    debug: false,
    silent: false,
    updateAllowlist: [],
    updateDenylist: [],
  })),
  updateChecker: jest.fn(),
  groupAndSortPackages: jest.fn(),
  getSortedGroupNames: jest.fn(),
  checkIfFileExists: jest.fn(),
  DEFAULT_CONFIG: {},
  saveJsonConfig: jest.fn(),
}))

jest.mock('@/utils/config', () => ({
  loadConfig: jest.fn(() => ({
    allowMinorUpdates: false,
    allowMajorUpdates: false,
    debug: false,
    silent: false,
    updateAllowlist: [],
    updateDenylist: [],
  })),
}))

jest.mock('@/utils/logger', () => ({
  __esModule: true,
  default: {
    command: jest.fn(),
    error: jest.fn(),
    starting: jest.fn(),
    workspace: jest.fn(),
    allUpToDate: jest.fn(),
    info: jest.fn(),
  },
}))

describe('PackageManager factory', () => {
  it('creates NPMManager for npm', () => {
    const pm = new PackageManager('npm')
    expect(pm.manager).toBeInstanceOf(NPMManager)
  })

  it('creates YarnManager for yarn', () => {
    const pm = new PackageManager('yarn')
    expect(pm.manager).toBeInstanceOf(YarnManager)
  })

  it('creates PNPMManager for pnpm', () => {
    const pm = new PackageManager('pnpm')
    expect(pm.manager).toBeInstanceOf(PNPMManager)
  })

  it('creates BunManager for bun', () => {
    const pm = new PackageManager('bun')
    expect(pm.manager).toBeInstanceOf(BunManager)
  })
})
