import { check } from '@/pipeline'
import { openProject, type Project } from '@/project'
import logger from '@/utils/logger'
import type { CheckOptions } from '../check'
import reportFailure from '../reportFailure'

/** What `autd check` does; `../check.ts` loads it when the command runs. */
export const checkAction = async (options: CheckOptions): Promise<void> => {
  if (options.json) logger.setJsonOutput(true)

  let project: Project | undefined
  try {
    project = openProject(process.cwd(), {
      pm: options.pm,
      cache: options.cache,
    })

    const result = await check(project, { report: !options.json })
    if (options.json) console.log(JSON.stringify(result, null, 2))
  } catch (error) {
    reportFailure(error, options.json)
  } finally {
    project?.registry.close()
  }
}
