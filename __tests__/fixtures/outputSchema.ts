import Ajv from 'ajv'
import fs from 'fs'
import path from 'path'

/** schema/output.schema.json, parsed (the drift tests read it too). */
export const outputSchema: Record<string, unknown> = JSON.parse(
  fs.readFileSync(
    path.join(__dirname, '../../schema/output.schema.json'),
    'utf8',
  ),
)

const ajv = new Ajv({ allErrors: true })
const validate = ajv.compile(outputSchema)

/** Throws, naming every violation, when `document` does not match the schema. */
export const validateOutput = (document: unknown): void => {
  if (!validate(document)) {
    throw new Error(
      `${ajv.errorsText(validate.errors)}\n${JSON.stringify(document, null, 2)}`,
    )
  }
}
