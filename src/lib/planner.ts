export type PlanItem = {
  id: string
  label: string
  text: string
  words: number
  seconds: number
}

const WORDS_PER_MINUTE = 145
const IDEAL_SEGMENT_WORDS = 34
const MAX_SEGMENT_WORDS = 52

export function countWords(text: string) {
  const normalized = text.trim()
  if (!normalized) {
    return 0
  }

  return normalized.split(/\s+/).filter(Boolean).length
}

export function estimateDurationSeconds(text: string) {
  const words = countWords(text)
  if (!words) {
    return 0
  }

  return Math.max(1, Math.round((words / WORDS_PER_MINUTE) * 60))
}

export function formatDuration(totalSeconds: number) {
  if (totalSeconds <= 0) {
    return '0s'
  }

  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  if (!minutes) {
    return `${seconds}s`
  }

  if (!seconds) {
    return `${minutes}m`
  }

  return `${minutes}m ${seconds}s`
}

export function summarizePlan<T extends { words: number; seconds: number }>(items: T[]) {
  return items.reduce(
    (summary, item) => ({
      totalSegments: summary.totalSegments + 1,
      totalWords: summary.totalWords + item.words,
      totalSeconds: summary.totalSeconds + item.seconds,
    }),
    {
      totalSegments: 0,
      totalWords: 0,
      totalSeconds: 0,
    },
  )
}

function normalizeText(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function splitLongUnit(text: string) {
  const normalized = normalizeText(text)
  if (!normalized) {
    return []
  }

  if (countWords(normalized) <= MAX_SEGMENT_WORDS) {
    return [normalized]
  }

  const parts = normalized.split(/(?<=[,;:])\s+/).map(normalizeText).filter(Boolean)
  if (parts.length <= 1) {
    return [normalized]
  }

  const chunks: string[] = []
  let current = ''

  for (const part of parts) {
    const candidate = current ? `${current} ${part}` : part
    if (current && countWords(candidate) > MAX_SEGMENT_WORDS) {
      chunks.push(current)
      current = part
      continue
    }

    current = candidate
  }

  if (current) {
    chunks.push(current)
  }

  return chunks
}

function splitParagraph(text: string) {
  return normalizeText(text)
    .split(/(?<=[.!?])\s+/)
    .map(normalizeText)
    .filter(Boolean)
    .flatMap(splitLongUnit)
}

function toPlanItem(text: string, index: number): PlanItem {
  const words = countWords(text)
  const labelIndex = String(index).padStart(2, '0')

  return {
    id: `beat-${labelIndex}`,
    label: `Beat ${labelIndex}`,
    text,
    words,
    seconds: estimateDurationSeconds(text),
  }
}

export function buildPlan(script: string) {
  const paragraphs = script
    .replace(/\r/g, '')
    .split(/\n{2,}/)
    .map(normalizeText)
    .filter(Boolean)

  if (!paragraphs.length) {
    return []
  }

  const items: PlanItem[] = []
  let buffer = ''

  const flush = () => {
    const text = normalizeText(buffer)
    if (!text) {
      return
    }

    items.push(toPlanItem(text, items.length + 1))
    buffer = ''
  }

  const appendUnit = (unit: string) => {
    const candidate = normalizeText(buffer ? `${buffer} ${unit}` : unit)

    if (buffer && countWords(candidate) > MAX_SEGMENT_WORDS) {
      flush()
    }

    buffer = normalizeText(buffer ? `${buffer} ${unit}` : unit)

    if (countWords(buffer) >= IDEAL_SEGMENT_WORDS) {
      flush()
    }
  }

  for (const paragraph of paragraphs) {
    const units = splitParagraph(paragraph)
    if (!units.length) {
      continue
    }

    for (const unit of units) {
      appendUnit(unit)
    }

    flush()
  }

  return items.length ? items : [toPlanItem(normalizeText(script), 1)]
}