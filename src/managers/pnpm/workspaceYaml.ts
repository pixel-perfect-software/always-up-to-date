import fs from 'fs'
import path from 'path'

import { parseYaml, type YamlNode } from '@/utils/yaml'

/** A parsed pnpm settings file: `pnpm-workspace.yaml` or the global `config.yaml`. */
export type PnpmYaml = Record<string, YamlNode>

/**
 * The one reading of a pnpm settings file (#229): `parseYaml` with flat
 * one-line flow maps, which `registries` may be written as, and anchored
 * values, which the catalog walk read before it. Every consumer
 * (packages, catalogs, overrides, registries, settings, the release-age
 * gate) takes its part from this, so one file is never read two ways.
 * Writing catalog entries keeps its own line walk (`updatePNPMWorkspaceYAML`),
 * which preserves every other byte.
 */
export const parsePnpmYaml = (text: string): PnpmYaml =>
  parseYaml(text, { flowMaps: true, anchors: true })

/** A pnpm settings file at `file`, parsed; empty when it can't be read. */
export const readPnpmYaml = (file: string): PnpmYaml => {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return {}
  }
  return parsePnpmYaml(text)
}

/** `dir`'s pnpm-workspace.yaml, parsed; empty when there is none. */
export const readPnpmWorkspaceYaml = (dir: string): PnpmYaml =>
  readPnpmYaml(path.join(dir, 'pnpm-workspace.yaml'))

const isMap = (node: YamlNode | undefined): node is Record<string, YamlNode> =>
  node !== null && typeof node === 'object' && !Array.isArray(node)

/** A top-level setting's text; undefined when it is absent, empty or not a scalar. */
export const pnpmSetting = (doc: PnpmYaml, key: string): string | undefined => {
  const value = doc[key]
  return typeof value === 'string' ? value : undefined
}

/** A map's string values, the rest left out. */
const stringEntries = (
  node: YamlNode | undefined,
): Record<string, string> | undefined => {
  if (!isMap(node)) return undefined
  const entries: Record<string, string> = {}
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') entries[key] = value
  }
  return entries
}

/**
 * The `packages` patterns, as a block list or a flow list. The file also
 * holds settings (`overrides`, `catalog`, `onlyBuiltDependencies`), so
 * single-package projects often have one; the project is a workspace only
 * when it lists at least one pattern.
 */
export const pnpmPackages = (doc: PnpmYaml): string[] => {
  const packages = doc.packages
  if (!Array.isArray(packages)) return []
  return packages.filter(
    (pattern): pattern is string =>
      typeof pattern === 'string' && pattern !== '',
  )
}

/**
 * The catalogs by name: `catalog:` is `default`, and so is
 * `catalogs: default:`, whose entries come after the top-level ones. An
 * entry whose value is not a string is left out.
 */
export const pnpmCatalogs = (
  doc: PnpmYaml,
): Record<string, Record<string, string>> => {
  const catalogs: Record<string, Record<string, string>> = {}
  const add = (name: string, node: YamlNode | undefined) => {
    const entries = stringEntries(node)
    if (entries && Object.keys(entries).length > 0) {
      catalogs[name] = { ...catalogs[name], ...entries }
    }
  }
  add('default', doc.catalog)
  if (isMap(doc.catalogs)) {
    for (const [name, node] of Object.entries(doc.catalogs)) add(name, node)
  }
  return catalogs
}

/** The `overrides` map: selector → range, string values only. */
export const pnpmOverrides = (doc: PnpmYaml): Record<string, string> =>
  stringEntries(doc.overrides) ?? {}
