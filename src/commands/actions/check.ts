import { check, findOutdated, plan } from '@/pipeline'
import { openProject, type Project } from '@/project'
import { planDocument, printJson } from '@/utils/jsonDocument'
import logger from '@/utils/logger'
import type { CheckOptions } from '../check'
import reportFailure from '../reportFailure'
import { applyCommand } from './applyCommand'

/** What `autd check` does; `../check.ts` loads it when the command runs. */
export const checkAction = async (options: CheckOptions): Promise<void> => {
  if (options.json) logger.setJsonOutput(true)

  let project: Project | undefined
  try {
    project = openProject(process.cwd(), {
      pm: options.pm,
      cache: options.cache,
    })

    if (!options.json) {
      await check(project, { next: applyCommand(options) })
      return
    }

    // The same rows `update --dry-run --json` prints: only a planned row has a reason.
    const outdated = await findOutdated(project)
    const results =
      Object.keys(outdated).length > 0 ? await plan(project, outdated) : []
    printJson(
      planDocument({
        command: 'check',
        phase: 'plan',
        manager: project.adapter.name,
        member: project.member?.path,
        results,
      }),
    )
  } catch (error) {
    reportFailure(error, { json: options.json, command: 'check' })
  } finally {
    project?.registry.close()
  }
}
