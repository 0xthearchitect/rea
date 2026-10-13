export function decodeRecord(value) {
  return { name: String(value.name), length: Number(value.length) };
}
