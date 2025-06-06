import { exec } from "child_process"
import { promisify } from "util"

export const execAsync = promisify(exec)

export { default as logger } from "./logger"
export { default as updateChecker } from "./updateChecker"
