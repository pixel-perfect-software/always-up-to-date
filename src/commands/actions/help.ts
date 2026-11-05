import logger from '@/utils/logger'

/** What `autd help` prints; `../help.ts` loads it when the command runs. */
export const helpAction = async (): Promise<void> => {
  logger.info(' Available commands:')
  logger.clean("  🆕 init - Initialize 'always-up-to-date' with a basic setup.")
  logger.clean('  📋 check - Check the dependencies of the project.')
  logger.clean(
    '  🔄 update - Update the update-able dependencies of the project.',
  )
  logger.clean('  ❓ help - Show this help message.')
  logger.clean('')
  logger.info(" Use 'always-up-to-date <command>' to run a specific command.")
}
