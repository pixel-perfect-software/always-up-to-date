/**
 * The command that applies a plan, as the report's last line prints it: the
 * run's `--pm` and `--no-cache` come along, since without them the apply
 * would detect or cache differently from the run that planned it.
 * `packages` are the names a targeted run asked for.
 */
export const applyCommand = (
  options: { pm?: string; cache?: boolean },
  packages: string[] = [],
): string =>
  [
    'autd update',
    ...packages,
    ...(options.pm ? ['--pm', options.pm] : []),
    ...(options.cache === false ? ['--no-cache'] : []),
  ].join(' ')
