export const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const parseJsonObject = (source: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(source)
  if (!isJsonObject(parsed)) throw new TypeError('Expected a JSON object.')
  return parsed
}

export const parseJsonArray = (source: string): unknown[] => {
  const parsed: unknown = JSON.parse(source)
  if (!Array.isArray(parsed)) throw new TypeError('Expected a JSON array.')
  return Array.from(parsed, (value: unknown) => value)
}

export const parseJsonObjectArray = (source: string): Array<Record<string, unknown>> =>
  parseJsonArray(source).map((value) => {
    if (!isJsonObject(value)) throw new TypeError('Expected a JSON object array.')
    return value
  })
