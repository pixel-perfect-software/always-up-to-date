import Ajv from 'ajv'
import fs from 'fs'
import path from 'path'
import { REASON_CODES } from '@/utils/reasons'

/** schema/output.schema.json as published, parsed (the drift tests read it too). */
export const outputSchema: Record<string, unknown> = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../../schema/output.schema.json'),
    'utf8',
  ),
)

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * The published schema stays open where 4.x may grow (#218): objects allow
 * additional properties and `reason.code` is any string. The suite wants the
 * opposite, so a field the code emits without a schema entry, or a code
 * missing from `REASON_CODES`, fails it. This closes every object that lists
 * `properties` and turns `reason.code` into an enum of `REASON_CODES`,
 * derived at load time so there is no second schema to drift.
 */
const strictened = (node: unknown): unknown => {
  if (Array.isArray(node)) return node.map(strictened)
  if (!isRecord(node)) return node
  const copy: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) copy[key] = strictened(value)
  if (isRecord(copy.properties)) copy.additionalProperties = false
  return copy
}

const strictSchema = strictened(outputSchema) as Record<string, unknown>
const reasonCode = (
  (strictSchema.definitions as Record<string, Record<string, unknown>>).reason
    .properties as Record<string, Record<string, unknown>>
).code
delete reasonCode.examples
reasonCode.enum = [...REASON_CODES]

const check = (schema: Record<string, unknown>) => {
  const ajv = new Ajv({ allErrors: true })
  const validate = ajv.compile(schema)
  return (document: unknown): void => {
    if (!validate(document)) {
      throw new Error(
        `${ajv.errorsText(validate.errors)}\n${JSON.stringify(document, null, 2)}`,
      )
    }
  }
}

/** Throws, naming every violation, when `document` does not match the strict form of the schema. */
export const validateOutput = check(strictSchema)

/** Throws when `document` does not match the schema as published, which a consumer on any 4.x release uses. */
export const validatePublished = check(outputSchema)
