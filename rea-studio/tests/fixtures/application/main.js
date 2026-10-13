import { decodeRecord } from "./parser.js";
import { formatRecord } from "./format.js";
export function inspectRecord(value) {
  return formatRecord(decodeRecord(value));
}
