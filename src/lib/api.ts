export type ApiInfo = {
  message: string
  status: string
}

export type HealthInfo = {
  status: string
}

export type VoicesResponse = {
  voices: string[]
  default: string
  total: number
}

export type UploadVoiceResponse = {
  detail: string
  voice: string
  filename: string
  total: number
}

export type AudioResult = {
  blob: Blob
  filename: string
  wordCount: number | null
  chunksCount: number | null
  voiceUsed: string | null
}

type GeneratePayload = {
  text: string
  voice?: string
}

export function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, '')
}

function buildUrl(baseUrl: string, path: string) {
  return `${normalizeBaseUrl(baseUrl)}${path}`
}

function parseHeaderNumber(value: string | null) {
  if (!value) {
    return null
  }

  const parsed = Number.parseInt(value, 10)
  return Number.isNaN(parsed) ? null : parsed
}

function parseFilename(contentDisposition: string | null) {
  if (!contentDisposition) {
    return 'generated.wav'
  }

  const utf8Match = contentDisposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8Match?.[1]) {
    return decodeURIComponent(utf8Match[1])
  }

  const basicMatch = contentDisposition.match(/filename="?([^";]+)"?/i)
  if (basicMatch?.[1]) {
    return basicMatch[1]
  }

  return 'generated.wav'
}

async function readErrorMessage(response: Response) {
  try {
    const payload = (await response.json()) as {
      detail?: unknown
      message?: unknown
    }

    if (typeof payload.detail === 'string') {
      return payload.detail
    }

    if (typeof payload.message === 'string') {
      return payload.message
    }
  } catch {
    // Ignore JSON parsing failures and use the HTTP status instead.
  }

  return `${response.status} ${response.statusText}`
}

async function ensureOk(response: Response) {
  if (response.ok) {
    return response
  }

  throw new Error(await readErrorMessage(response))
}

export async function fetchApiInfo(baseUrl: string) {
  const response = await fetch(buildUrl(baseUrl, '/'))
  await ensureOk(response)
  return (await response.json()) as ApiInfo
}

export async function fetchHealth(baseUrl: string) {
  const response = await fetch(buildUrl(baseUrl, '/health'))
  await ensureOk(response)
  return (await response.json()) as HealthInfo
}

export async function fetchVoices(baseUrl: string) {
  const response = await fetch(buildUrl(baseUrl, '/getvoiceslist'))
  await ensureOk(response)
  return (await response.json()) as VoicesResponse
}

export async function uploadVoice(baseUrl: string, file: File, name: string) {
  const formData = new FormData()
  formData.append('file', file)

  const trimmedName = name.trim()
  if (trimmedName) {
    formData.append('name', trimmedName)
  }

  const response = await fetch(buildUrl(baseUrl, '/uploadvoice'), {
    method: 'POST',
    body: formData,
  })

  await ensureOk(response)
  return (await response.json()) as UploadVoiceResponse
}

export async function generateVoice(baseUrl: string, payload: GeneratePayload) {
  const response = await fetch(buildUrl(baseUrl, '/generate'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'audio/wav',
    },
    body: JSON.stringify(payload),
  })

  await ensureOk(response)

  return {
    blob: await response.blob(),
    filename: parseFilename(response.headers.get('Content-Disposition')),
    wordCount: parseHeaderNumber(response.headers.get('X-Word-Count')),
    chunksCount: parseHeaderNumber(response.headers.get('X-Chunks-Count')),
    voiceUsed: response.headers.get('X-Voice-Used'),
  } satisfies AudioResult
}