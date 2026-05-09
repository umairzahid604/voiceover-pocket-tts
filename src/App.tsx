import {
  type FormEvent,
  startTransition,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from 'react'
import './App.css'
import {
  fetchApiInfo,
  fetchHealth,
  fetchVoices,
  generateVoice,
  normalizeBaseUrl,
  uploadVoice,
  type ApiInfo,
  type AudioResult,
  type VoicesResponse,
} from './lib/api'
import {
  buildPlan,
  countWords,
  estimateDurationSeconds,
  estimateRenderSeconds,
  formatDuration,
  getRenderProgress,
  getRenderRemainingSeconds,
  summarizePlan,
  type PlanItem,
} from './lib/planner'

type TabKey = 'create' | 'voices' | 'settings'
type HealthState = 'idle' | 'checking' | 'healthy' | 'error'
type RequestState = 'idle' | 'running' | 'done' | 'error'

type AudioClip = AudioResult & {
  url: string
}

type RenderProgress = {
  estimateSeconds: number
  progress: number
  remainingSeconds: number
  startedAt: number
}

type PlannedSegment = PlanItem & {
  status: RequestState
  error: string | null
  clip: AudioClip | null
  renderProgress: RenderProgress | null
}

const STORAGE_KEY = 'pocket-tts.base-url'
const FALLBACK_BASE_URL = 'http://localhost:8547'

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'create', label: 'Create' },
  { key: 'voices', label: 'Voices' },
  { key: 'settings', label: 'Settings' },
]

const endpoints = [
  { method: 'GET', path: '/', note: 'API info' },
  { method: 'GET', path: '/health', note: 'Health check' },
  { method: 'GET', path: '/getvoiceslist', note: 'Built-in + custom voices' },
  { method: 'POST', path: '/generate', note: 'JSON { text, voice? } -> WAV' },
  {
    method: 'POST',
    path: '/uploadvoice',
    note: 'multipart form with file and optional name',
  },
]

function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'Unexpected error'
}

function buildSegmentState(items: PlanItem[]): PlannedSegment[] {
  return items.map((item) => ({
    ...item,
    status: 'idle',
    error: null,
    clip: null,
    renderProgress: null,
  }))
}

function getStatusHeadline(state: HealthState) {
  if (state === 'healthy') {
    return 'API ready'
  }

  if (state === 'checking') {
    return 'Checking API'
  }

  if (state === 'error') {
    return 'API unavailable'
  }

  return 'Waiting for API'
}

function createRenderProgress(text: string): RenderProgress {
  const estimateSeconds = estimateRenderSeconds(text)

  return {
    estimateSeconds,
    progress: estimateSeconds ? 6 : 0,
    remainingSeconds: estimateSeconds,
    startedAt: Date.now(),
  }
}

function syncRenderProgress(state: RenderProgress) {
  return {
    ...state,
    progress: getRenderProgress(state.startedAt, state.estimateSeconds),
    remainingSeconds: getRenderRemainingSeconds(state.startedAt, state.estimateSeconds),
  }
}

type ProgressMeterProps = {
  label: string
  value: RenderProgress
  compact?: boolean
}

function ProgressMeter({ label, value, compact = false }: ProgressMeterProps) {
  return (
    <div className={`progress-meter ${compact ? 'is-compact' : ''}`} role="status" aria-live="polite">
      <div className="progress-head">
        <strong>{label}</strong>
        <span className="badge mono">{value.progress}%</span>
      </div>

      <div className="progress-track" aria-hidden="true">
        <span className="progress-fill" style={{ width: `${value.progress}%` }} />
      </div>

      <div className="progress-stats">
        <span>Est. {formatDuration(value.estimateSeconds)}</span>
        <span>{value.remainingSeconds ? `${formatDuration(value.remainingSeconds)} left` : 'Finishing'}</span>
      </div>
    </div>
  )
}

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('create')
  const [baseUrl, setBaseUrl] = useState(() => {
    if (typeof window === 'undefined') {
      return FALLBACK_BASE_URL
    }

    return normalizeBaseUrl(
      window.localStorage.getItem(STORAGE_KEY) || FALLBACK_BASE_URL,
    )
  })
  const [baseUrlDraft, setBaseUrlDraft] = useState(baseUrl)
  const [apiInfo, setApiInfo] = useState<ApiInfo | null>(null)
  const [healthState, setHealthState] = useState<HealthState>('idle')
  const [connectionMessage, setConnectionMessage] = useState('Set the API URL')
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [voicesData, setVoicesData] = useState<VoicesResponse | null>(null)
  const [voicesState, setVoicesState] = useState<RequestState>('idle')
  const [voicesMessage, setVoicesMessage] = useState('No voices loaded')
  const [selectedVoice, setSelectedVoice] = useState('alba')
  const [script, setScript] = useState('')
  const [plan, setPlan] = useState<PlannedSegment[]>([])
  const [planMessage, setPlanMessage] = useState('Build a plan from the script')
  const [isPlanning, setIsPlanning] = useState(false)
  const [fullAudioState, setFullAudioState] = useState<RequestState>('idle')
  const [fullAudioError, setFullAudioError] = useState<string | null>(null)
  const [fullAudio, setFullAudio] = useState<AudioClip | null>(null)
  const [fullRenderProgress, setFullRenderProgress] = useState<RenderProgress | null>(null)
  const [uploadState, setUploadState] = useState<RequestState>('idle')
  const [uploadMessage, setUploadMessage] = useState('Ready for upload')
  const [uploadName, setUploadName] = useState('')
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const uploadInputRef = useRef<HTMLInputElement | null>(null)
  const objectUrlsRef = useRef<string[]>([])

  const voices = voicesData?.voices ?? []
  const defaultVoice = voicesData?.default ?? 'alba'
  const voiceOptions = voices.length ? voices : [selectedVoice]
  const scriptWords = countWords(script)
  const scriptDuration = estimateDurationSeconds(script)
  const renderEstimate = estimateRenderSeconds(script)
  const planSummary = summarizePlan(plan)
  const hasRunningBeat = plan.some(
    (item) => item.status === 'running' && item.renderProgress !== null,
  )

  useEffect(() => {
    setBaseUrlDraft(baseUrl)
  }, [baseUrl])

  useEffect(() => {
    return () => {
      objectUrlsRef.current.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [])

  const runConnectionCheck = useEffectEvent(async (targetBaseUrl = baseUrl) => {
    const resolvedBaseUrl = normalizeBaseUrl(targetBaseUrl)
    if (!resolvedBaseUrl) {
      setHealthState('error')
      setConnectionMessage('Base URL is required')
      return
    }

    setHealthState('checking')
    setConnectionMessage('Checking connection')

    try {
      const [info, health] = await Promise.all([
        fetchApiInfo(resolvedBaseUrl),
        fetchHealth(resolvedBaseUrl),
      ])

      setApiInfo(info)
      setHealthState(health.status === 'healthy' ? 'healthy' : 'error')
      setConnectionMessage(`${info.message} · ${health.status}`)
      setCheckedAt(
        new Date().toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
      )
    } catch (error) {
      setHealthState('error')
      setConnectionMessage(getErrorMessage(error))
    }
  })

  const runVoicesRefresh = useEffectEvent(async (targetBaseUrl = baseUrl) => {
    const resolvedBaseUrl = normalizeBaseUrl(targetBaseUrl)
    if (!resolvedBaseUrl) {
      setVoicesState('error')
      setVoicesMessage('Base URL is required')
      return
    }

    setVoicesState('running')
    setVoicesMessage('Loading voices')

    try {
      const nextVoices = await fetchVoices(resolvedBaseUrl)
      setVoicesData(nextVoices)
      setVoicesState('done')
      setVoicesMessage(`${nextVoices.total} voices ready`)
      setSelectedVoice((currentVoice) => {
        if (nextVoices.voices.includes(currentVoice)) {
          return currentVoice
        }

        return nextVoices.default || nextVoices.voices[0] || currentVoice
      })
    } catch (error) {
      setVoicesState('error')
      setVoicesMessage(getErrorMessage(error))
    }
  })

  useEffect(() => {
    void runConnectionCheck(baseUrl)
    void runVoicesRefresh(baseUrl)
  }, [baseUrl])

  useEffect(() => {
    if (fullAudioState !== 'running' || !fullRenderProgress) {
      return
    }

    const timer = window.setInterval(() => {
      setFullRenderProgress((current) => {
        if (!current) {
          return current
        }

        return syncRenderProgress(current)
      })
    }, 250)

    return () => window.clearInterval(timer)
  }, [fullAudioState, fullRenderProgress?.startedAt])

  useEffect(() => {
    if (!hasRunningBeat) {
      return
    }

    const timer = window.setInterval(() => {
      setPlan((currentPlan) =>
        currentPlan.map((item) => {
          if (item.status !== 'running' || !item.renderProgress) {
            return item
          }

          return {
            ...item,
            renderProgress: syncRenderProgress(item.renderProgress),
          }
        }),
      )
    }, 250)

    return () => window.clearInterval(timer)
  }, [hasRunningBeat])

  function trackObjectUrl(url: string) {
    objectUrlsRef.current.push(url)
    return url
  }

  function revokeObjectUrl(url?: string | null) {
    if (!url) {
      return
    }

    URL.revokeObjectURL(url)
    objectUrlsRef.current = objectUrlsRef.current.filter((entry) => entry !== url)
  }

  function clearPlanAudio(items: PlannedSegment[]) {
    items.forEach((item) => revokeObjectUrl(item.clip?.url))
  }

  function handleScriptChange(value: string) {
    if (fullAudio?.url) {
      revokeObjectUrl(fullAudio.url)
      setFullAudio(null)
      setFullAudioState('idle')
      setFullAudioError(null)
    }

    setFullRenderProgress(null)

    setScript(value)

    if (plan.length) {
      setPlanMessage('Script changed. Rebuild the plan')
    }
  }

  function handleBuildPlan() {
    const nextScript = script.trim()
    if (!nextScript) {
      clearPlanAudio(plan)
      setPlan([])
      setPlanMessage('Add script first')
      return
    }

    clearPlanAudio(plan)
    setPlan([])
    setIsPlanning(true)
    setPlanMessage('Building plan')

    startTransition(() => {
      const nextPlan = buildSegmentState(buildPlan(nextScript))
      setPlan(nextPlan)
      setPlanMessage(`${nextPlan.length} beats ready`)
      setIsPlanning(false)
    })
  }

  function handleSegmentTextChange(id: string, value: string) {
    const currentClip = plan.find((item) => item.id === id)?.clip
    revokeObjectUrl(currentClip?.url)

    setPlan((currentPlan) =>
      currentPlan.map((item) => {
        if (item.id !== id) {
          return item
        }

        return {
          ...item,
          text: value,
          words: countWords(value),
          seconds: estimateDurationSeconds(value),
          status: 'idle',
          error: null,
          clip: null,
          renderProgress: null,
        }
      }),
    )
  }

  async function createAudioClip(text: string) {
    const response = await generateVoice(baseUrl, {
      text,
      voice: selectedVoice,
    })

    return {
      ...response,
      url: trackObjectUrl(URL.createObjectURL(response.blob)),
    } satisfies AudioClip
  }

  async function handleGenerateFull() {
    const nextScript = script.trim()
    if (!nextScript) {
      setFullAudioState('error')
      setFullAudioError('Add script first')
      return
    }

    setFullAudioState('running')
    setFullAudioError(null)
    setFullRenderProgress(createRenderProgress(nextScript))

    try {
      const clip = await createAudioClip(nextScript)
      revokeObjectUrl(fullAudio?.url)
      setFullAudio(clip)
      setFullAudioState('done')
      setFullRenderProgress(null)
    } catch (error) {
      setFullAudioState('error')
      setFullAudioError(getErrorMessage(error))
      setFullRenderProgress(null)
    }
  }

  async function handleGenerateSegment(id: string) {
    const segment = plan.find((item) => item.id === id)
    if (!segment) {
      return
    }

    setPlan((currentPlan) =>
      currentPlan.map((item) =>
        item.id === id
          ? {
              ...item,
              status: 'running',
              error: null,
              renderProgress: createRenderProgress(item.text),
            }
          : item,
      ),
    )

    try {
      const clip = await createAudioClip(segment.text)
      revokeObjectUrl(segment.clip?.url)

      setPlan((currentPlan) =>
        currentPlan.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'done',
                error: null,
                clip,
                renderProgress: null,
              }
            : item,
        ),
      )
    } catch (error) {
      setPlan((currentPlan) =>
        currentPlan.map((item) =>
          item.id === id
            ? {
                ...item,
                status: 'error',
                error: getErrorMessage(error),
                renderProgress: null,
              }
            : item,
        ),
      )
    }
  }

  async function handleUploadVoice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!uploadFile) {
      setUploadState('error')
      setUploadMessage('Pick an audio file')
      return
    }

    setUploadState('running')
    setUploadMessage('Uploading voice')

    try {
      const response = await uploadVoice(baseUrl, uploadFile, uploadName)
      setUploadState('done')
      setUploadMessage(response.detail)
      setUploadName(response.voice)
      setUploadFile(null)
      setSelectedVoice(response.voice)

      if (uploadInputRef.current) {
        uploadInputRef.current.value = ''
      }

      await runVoicesRefresh(baseUrl)
    } catch (error) {
      setUploadState('error')
      setUploadMessage(getErrorMessage(error))
    }
  }

  function handleSaveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()

    const nextBaseUrl = normalizeBaseUrl(baseUrlDraft)
    if (!nextBaseUrl) {
      setHealthState('error')
      setConnectionMessage('Base URL is required')
      return
    }

    window.localStorage.setItem(STORAGE_KEY, nextBaseUrl)

    if (nextBaseUrl === baseUrl) {
      void runConnectionCheck(nextBaseUrl)
      void runVoicesRefresh(nextBaseUrl)
      return
    }

    setBaseUrl(nextBaseUrl)
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="kicker">Pocket TTS</p>
          <h1>Voiceover studio</h1>
        </div>

        <div className={`status-pill is-${healthState}`}>
          <span className="status-dot" aria-hidden="true" />
          <div>
            <strong>{getStatusHeadline(healthState)}</strong>
            <p>{connectionMessage}</p>
          </div>
        </div>
      </header>

      <nav className="tabs" aria-label="Sections">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={`tab ${activeTab === tab.key ? 'is-active' : ''}`}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'create' ? (
        <>
          <section className="workspace">
            <div className="panel composer-panel">
              <div className="panel-head">
                <div>
                  <p className="panel-label">Script</p>
                  <h2 className="panel-title">Build + render</h2>
                </div>

                <div className="inline-meta">
                  <span className="badge">{voiceOptions.length} voices</span>
                  <span className="badge mono">{selectedVoice}</span>
                </div>
              </div>

              <textarea
                className="script-input"
                value={script}
                onChange={(event) => handleScriptChange(event.target.value)}
                placeholder="Paste the script"
              />

              <div className="control-grid">
                <label className="field">
                  <span>Voice</span>
                  <select
                    value={selectedVoice}
                    onChange={(event) => setSelectedVoice(event.target.value)}
                  >
                    {voiceOptions.map((voice) => (
                      <option key={voice} value={voice}>
                        {voice}
                      </option>
                    ))}
                  </select>
                </label>

                <button
                  type="button"
                  className="button secondary"
                  onClick={() => void runVoicesRefresh(baseUrl)}
                  disabled={voicesState === 'running'}
                >
                  {voicesState === 'running' ? 'Refreshing' : 'Refresh voices'}
                </button>

                <button
                  type="button"
                  className="button ghost"
                  onClick={handleBuildPlan}
                  disabled={isPlanning}
                >
                  {isPlanning ? 'Building' : 'Build plan'}
                </button>

                <button
                  type="button"
                  className="button primary"
                  onClick={() => void handleGenerateFull()}
                  disabled={fullAudioState === 'running'}
                >
                  {fullAudioState === 'running' ? 'Rendering' : 'Generate WAV'}
                </button>
              </div>

              <p className="note">{voicesMessage}</p>

              {fullAudioState === 'running' && fullRenderProgress ? (
                <ProgressMeter label="Rendering full audio" value={fullRenderProgress} />
              ) : null}

              {fullAudioError ? <div className="message is-error">{fullAudioError}</div> : null}

              {fullAudio ? (
                <div className="audio-card">
                  <div className="segment-head">
                    <strong>Full render</strong>
                    <div className="segment-meta">
                      <span className="badge mono">{fullAudio.voiceUsed ?? selectedVoice}</span>
                      <span className="badge">{fullAudio.wordCount ?? scriptWords} words</span>
                      <span className="badge">{fullAudio.chunksCount ?? 1} chunk</span>
                    </div>
                  </div>

                  <audio controls src={fullAudio.url} />

                  <a
                    className="button-link button secondary"
                    href={fullAudio.url}
                    download={fullAudio.filename}
                  >
                    Download
                  </a>
                </div>
              ) : null}
            </div>

            <aside className="stack">
              <section className="panel">
                <p className="panel-label">Overview</p>
                <div className="metrics-grid">
                  <article className="metric">
                    <span className="metric-label">Words</span>
                    <strong className="metric-value">{scriptWords}</strong>
                  </article>

                  <article className="metric">
                    <span className="metric-label">Runtime</span>
                    <strong className="metric-value">{formatDuration(scriptDuration)}</strong>
                    <span className="metric-note">
                      {scriptWords
                        ? `Render est. ${formatDuration(renderEstimate)}`
                        : 'Add script to estimate render time'}
                    </span>
                  </article>

                  <article className="metric">
                    <span className="metric-label">Beats</span>
                    <strong className="metric-value">{planSummary.totalSegments}</strong>
                  </article>

                  <article className="metric">
                    <span className="metric-label">API</span>
                    <strong className="metric-value">
                      {healthState === 'healthy' ? 'Live' : healthState === 'checking' ? 'Ping' : 'Hold'}
                    </strong>
                    <span className="metric-note">
                      {checkedAt ? `Checked ${checkedAt}` : connectionMessage}
                    </span>
                  </article>
                </div>
              </section>

              <section className="panel">
                <p className="panel-label">Target</p>
                <div className="detail-stack">
                  <div className="detail-row">
                    <span>Base URL</span>
                    <strong className="mono">{baseUrl}</strong>
                  </div>

                  <div className="detail-row">
                    <span>Root</span>
                    <strong>{apiInfo?.message ?? 'Unavailable'}</strong>
                  </div>

                  <div className="detail-row">
                    <span>Default</span>
                    <strong className="mono">{defaultVoice}</strong>
                  </div>
                </div>
              </section>
            </aside>
          </section>

          <section className="panel">
            <div className="section-header">
              <div>
                <p className="panel-label">Plan</p>
                <h2 className="panel-title">Beats</h2>
              </div>

              <div className="inline-meta">
                <span className="badge">{planSummary.totalSegments} beats</span>
                <span className="badge">{planSummary.totalWords} words</span>
                <span className="badge">{formatDuration(planSummary.totalSeconds)}</span>
              </div>
            </div>

            {plan.length ? (
              <div className="plan-grid">
                {plan.map((item) => (
                  <article key={item.id} className="segment-card">
                    <div className="segment-head">
                      <strong className="segment-id">{item.label}</strong>

                      <div className="segment-meta">
                        <span className="badge">{item.words} w</span>
                        <span className="badge">{formatDuration(item.seconds)}</span>
                      </div>
                    </div>

                    <textarea
                      className="script-input segment-text"
                      value={item.text}
                      onChange={(event) =>
                        handleSegmentTextChange(item.id, event.target.value)
                      }
                    />

                    {item.status === 'running' && item.renderProgress ? (
                      <ProgressMeter
                        compact
                        label={`${item.label} rendering`}
                        value={item.renderProgress}
                      />
                    ) : null}

                    {item.error ? <div className="message is-error">{item.error}</div> : null}

                    <div className="segment-actions">
                      <button
                        type="button"
                        className="button primary"
                        onClick={() => void handleGenerateSegment(item.id)}
                        disabled={item.status === 'running'}
                      >
                        {item.status === 'running' ? 'Rendering' : 'Render beat'}
                      </button>

                      {item.clip ? (
                        <a
                          className="button-link button secondary"
                          href={item.clip.url}
                          download={item.clip.filename}
                        >
                          Download
                        </a>
                      ) : null}
                    </div>

                    {item.clip ? <audio controls src={item.clip.url} /> : null}
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">{isPlanning ? 'Building plan...' : planMessage}</div>
            )}
          </section>
        </>
      ) : null}

      {activeTab === 'voices' ? (
        <section className="voices-layout">
          <section className="panel">
            <div className="section-header">
              <div>
                <p className="panel-label">Voices</p>
                <h2 className="panel-title">Library</h2>
              </div>

              <button
                type="button"
                className="button secondary"
                onClick={() => void runVoicesRefresh(baseUrl)}
                disabled={voicesState === 'running'}
              >
                {voicesState === 'running' ? 'Refreshing' : 'Refresh'}
              </button>
            </div>

            {voices.length ? (
              <div className="chip-grid">
                {voices.map((voice) => (
                  <button
                    key={voice}
                    type="button"
                    className={`voice-chip ${voice === selectedVoice ? 'is-selected' : ''}`}
                    onClick={() => setSelectedVoice(voice)}
                  >
                    <span>{voice}</span>
                    {voice === defaultVoice ? <span className="sub-badge">default</span> : null}
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state">{voicesMessage}</div>
            )}
          </section>

          <form className="panel upload-form" onSubmit={handleUploadVoice}>
            <div>
              <p className="panel-label">Upload</p>
              <h2 className="panel-title">Custom voice</h2>
            </div>

            <label className="field">
              <span>Name</span>
              <input
                value={uploadName}
                onChange={(event) => setUploadName(event.target.value)}
                placeholder="Optional"
              />
            </label>

            <label className="field">
              <span>File</span>
              <input
                ref={uploadInputRef}
                className="file-input"
                type="file"
                accept="audio/*,.wav,.mp3,.m4a,.ogg,.flac"
                onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
              />
            </label>

            <button
              type="submit"
              className="button primary"
              disabled={uploadState === 'running'}
            >
              {uploadState === 'running' ? 'Uploading' : 'Upload voice'}
            </button>

            <div
              className={`message ${uploadState === 'error' ? 'is-error' : ''} ${uploadState === 'done' ? 'is-success' : ''}`}
            >
              {uploadMessage}
            </div>

            <p className="note">
              Uses <span className="mono">file</span> and optional{' '}
              <span className="mono">name</span> in multipart form data.
            </p>
          </form>
        </section>
      ) : null}

      {activeTab === 'settings' ? (
        <section className="settings-layout">
          <form className="panel settings-form" onSubmit={handleSaveSettings}>
            <div>
              <p className="panel-label">Settings</p>
              <h2 className="panel-title">Connection</h2>
            </div>

            <label className="field">
              <span>Base URL</span>
              <input
                value={baseUrlDraft}
                onChange={(event) => setBaseUrlDraft(event.target.value)}
                placeholder="http://localhost:8547"
              />
            </label>

            <div className="segment-actions">
              <button type="submit" className="button primary">
                Save
              </button>

              <button
                type="button"
                className="button secondary"
                onClick={() => void runConnectionCheck(normalizeBaseUrl(baseUrlDraft) || baseUrl)}
              >
                Check API
              </button>

              <button
                type="button"
                className="button ghost"
                onClick={() => void runVoicesRefresh(normalizeBaseUrl(baseUrlDraft) || baseUrl)}
              >
                Refresh voices
              </button>
            </div>

            <div
              className={`message ${healthState === 'error' ? 'is-error' : ''} ${healthState === 'healthy' ? 'is-success' : ''}`}
            >
              {connectionMessage}
            </div>

            <div className="detail-stack">
              <div className="detail-row">
                <span>Root</span>
                <strong>{apiInfo?.message ?? 'Unavailable'}</strong>
              </div>

              <div className="detail-row">
                <span>Status</span>
                <strong>{healthState === 'healthy' ? 'healthy' : 'unknown'}</strong>
              </div>

              <div className="detail-row">
                <span>Voices</span>
                <strong>{voices.length}</strong>
              </div>

              <div className="detail-row">
                <span>Last check</span>
                <strong>{checkedAt ?? 'Never'}</strong>
              </div>
            </div>
          </form>

          <section className="panel">
            <div>
              <p className="panel-label">API</p>
              <h2 className="panel-title">Endpoints</h2>
            </div>

            <div className="endpoint-list">
              {endpoints.map((endpoint) => (
                <article key={endpoint.path} className="endpoint-row">
                  <span className="endpoint-method">{endpoint.method}</span>
                  <div>
                    <div className="endpoint-path">{endpoint.path}</div>
                    <div className="endpoint-note">{endpoint.note}</div>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </section>
      ) : null}
    </div>
  )
}

export default App
