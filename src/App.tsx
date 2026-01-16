import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

type Player = {
  id: string
  name: string
  baseSeconds: number
  score: number
}

type TonePalette = 'warm' | 'bright' | 'soft'

type Settings = {
  defaultSeconds: number
  handicapEnabled: boolean
  handicapSecondsPerPoint: number
  cueVolume: number
  tonePalette: TonePalette
  muted: boolean
}

type TurnEntry = {
  id: string
  playerId: string
  playerName: string
  usedSeconds: number
  startedAt: number
  endedAt: number
}

type ScoreSnapshot = {
  id: string
  timestamp: number
  scores: Array<{ playerId: string; name: string; score: number }>
}

type TurnSnapshot = {
  activeIndex: number
  timeLeft: number
  currentDuration: number
  startedAt: number
}

type Phase = 'setup' | 'playing' | 'scores' | 'settings' | 'archives'

type SessionArchive = {
  id: string
  savedAt: number
  players: Player[]
  turnHistory: TurnEntry[]
  scoreHistory: ScoreSnapshot[]
  settings: Settings
}

const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value))

const formatClock = (seconds: number) => {
  const sign = seconds < 0 ? '-' : ''
  const abs = Math.abs(seconds)
  const mins = Math.floor(abs / 60)
  const secs = Math.floor(abs % 60)
  return `${sign}${mins.toString().padStart(2, '0')}:${secs
    .toString()
    .padStart(2, '0')}`
}

const STORAGE_KEY = 'rummy-timer-state'
const ARCHIVES_KEY = 'rummy-timer-archives'

const createTonePlayer = () => {
  let ctx: AudioContext | null = null

  const ensure = () => {
    if (!ctx) {
      ctx = new AudioContext()
    }
    return ctx
  }

  const play = (frequency = 660, duration = 0.18, volume = 0.08) => {
    const audio = ensure()
    const now = audio.currentTime
    const oscillator = audio.createOscillator()
    const gain = audio.createGain()

    oscillator.frequency.value = frequency
    oscillator.type = 'sine'
    gain.gain.value = volume

    oscillator.connect(gain)
    gain.connect(audio.destination)

    oscillator.start(now)
    oscillator.stop(now + duration)
  }

  return { play }
}

const paletteTones: Record<TonePalette, Record<string, number>> = {
  warm: { half: 460, quarter: 620, tenth: 760, zero: 320 },
  bright: { half: 540, quarter: 720, tenth: 920, zero: 360 },
  soft: { half: 360, quarter: 480, tenth: 640, zero: 280 },
}

const toneFor = (key: string, palette: TonePalette) => {
  const map = paletteTones[palette] ?? paletteTones.warm
  return map[key] ?? 520
}

const defaultSettings: Settings = {
  defaultSeconds: 60,
  handicapEnabled: true,
  handicapSecondsPerPoint: 1,
  cueVolume: 0.12,
  tonePalette: 'warm',
  muted: false,
}

const defaultPlayers: Player[] = [
  { id: 'p1', name: 'Player 1', baseSeconds: 60, score: 0 },
  { id: 'p2', name: 'Player 2', baseSeconds: 60, score: 0 },
]

function App() {
  const [phase, setPhase] = useState<Phase>('setup')
  const [settings, setSettings] = useState<Settings>(defaultSettings)
  const [draftPlayers, setDraftPlayers] = useState<Player[]>(defaultPlayers)
  const [draftSecondsText, setDraftSecondsText] = useState<Record<string, string>>({})
  const [scoreText, setScoreText] = useState<Record<string, string>>({})

  const SCORE_HISTORY_PAGE_SIZE = 3
  const ARCHIVES_PAGE_SIZE = 3
  const [scoreHistoryPage, setScoreHistoryPage] = useState(0)
  const [archivesPage, setArchivesPage] = useState(0)

  const [players, setPlayers] = useState<Player[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const [timeLeft, setTimeLeft] = useState(0)
  const [currentDuration, setCurrentDuration] = useState(0)
  const [running, setRunning] = useState(false)
  const [turnStartedAt, setTurnStartedAt] = useState<number>(Date.now())

  const [turnHistory, setTurnHistory] = useState<TurnEntry[]>([])
  const [scoreHistory, setScoreHistory] = useState<ScoreSnapshot[]>([])
  const [undoStack, setUndoStack] = useState<TurnSnapshot[]>([])
  const [archives, setArchives] = useState<SessionArchive[]>([])

  const cuesRef = useRef<Set<string>>(new Set())
  const startPerfRef = useRef<number>(0)
  const elapsedBeforeRunRef = useRef<number>(0)
  const toneRef = useRef(createTonePlayer())
  const appScaleRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const updateScale = () => {
      const width = window.innerWidth
      const height = window.innerHeight
      const el = appScaleRef.current
      if (!el) return

      const root = document.documentElement
      // Reset scale to measure the natural size of the UI.
      root.style.setProperty('--ui-scale', '1')

      const designWidth = Math.max(1, el.scrollWidth)
      const designHeight = Math.max(1, el.scrollHeight)
      const scale = Math.min(width / designWidth, height / designHeight)
      const clamped = Math.min(1.2, Math.max(0.45, scale))
      root.style.setProperty('--ui-scale', String(clamped))
    }

    const raf = window.requestAnimationFrame(updateScale)
    window.addEventListener('resize', updateScale)
    return () => {
      window.cancelAnimationFrame(raf)
      window.removeEventListener('resize', updateScale)
    }
  }, [phase, players.length, scoreHistory.length, archives.length])

  const longPressTimerRef = useRef<number | null>(null)

  const activePlayer = useMemo(() => players[activeIndex], [players, activeIndex])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw)
      if (parsed.settings) setSettings((prev) => ({ ...prev, ...parsed.settings }))
      if (parsed.draftPlayers) setDraftPlayers(parsed.draftPlayers)
      if (parsed.players) setPlayers(parsed.players)
      if (typeof parsed.activeIndex === 'number') setActiveIndex(parsed.activeIndex)
      if (typeof parsed.timeLeft === 'number') setTimeLeft(parsed.timeLeft)
      if (typeof parsed.currentDuration === 'number') setCurrentDuration(parsed.currentDuration)
      if (parsed.turnHistory) setTurnHistory(parsed.turnHistory)
      if (parsed.scoreHistory) setScoreHistory(parsed.scoreHistory)
      if (parsed.phase === 'playing' || parsed.phase === 'setup' || parsed.phase === 'settings') setPhase(parsed.phase)
      if (parsed.turnStartedAt) setTurnStartedAt(parsed.turnStartedAt)
      setRunning(false)
      startPerfRef.current = 0
      elapsedBeforeRunRef.current = 0
    } catch (err) {
      console.warn('Could not load saved timer state', err)
    }
    try {
      const rawArchives = localStorage.getItem(ARCHIVES_KEY)
      if (rawArchives) {
        const parsedArchives = JSON.parse(rawArchives)
        if (Array.isArray(parsedArchives)) setArchives(parsedArchives)
      }
    } catch (err) {
      console.warn('Could not load archives', err)
    }
  }, [])

  useEffect(() => {
    const snapshot = {
      settings,
      draftPlayers,
      players,
      activeIndex,
      timeLeft,
      currentDuration,
      turnHistory,
      scoreHistory,
      phase,
      turnStartedAt,
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot))
    } catch (err) {
      console.warn('Could not persist timer state', err)
    }
  }, [settings, draftPlayers, players, activeIndex, timeLeft, currentDuration, turnHistory, scoreHistory, phase, turnStartedAt])

  useEffect(() => {
    try {
      localStorage.setItem(ARCHIVES_KEY, JSON.stringify(archives))
    } catch (err) {
      console.warn('Could not persist archives', err)
    }
  }, [archives])

  const computeEffectiveTime = (player: Player) => {
    if (!settings.handicapEnabled) return player.baseSeconds
    const adjusted = player.baseSeconds - settings.handicapSecondsPerPoint * player.score
    return clamp(adjusted, 10, 900)
  }

  const resetCues = () => {
    cuesRef.current = new Set()
  }

  const pauseTimer = () => {
    if (!running) return
    const elapsed = (performance.now() - startPerfRef.current) / 1000
    elapsedBeforeRunRef.current += Math.max(0, elapsed)
    setRunning(false)
  }

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current != null) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  const getLongPressProps = (action: () => void, enabled: boolean) => {
    if (!enabled) {
      return {
        onClick: (e: React.MouseEvent) => {
          e.stopPropagation()
          action()
        },
      }
    }

    const start = (e: React.PointerEvent) => {
      e.stopPropagation()
      clearLongPressTimer()
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = null
        action()
      }, 650)
    }

    const cancel = (e: React.PointerEvent) => {
      e.stopPropagation()
      clearLongPressTimer()
    }

    return {
      onPointerDown: start,
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      onClick: (e: React.MouseEvent) => {
        // Prevent accidental taps/clicks when long-press is required.
        e.preventDefault()
        e.stopPropagation()
      },
    }
  }

  const resumeTimer = () => {
    if (running) return
    startPerfRef.current = performance.now()
    setRunning(true)
  }

  const startTurn = (index: number) => {
    if (!players.length) return
    const safeIndex = (index + players.length) % players.length
    const target = players[safeIndex]
    const duration = computeEffectiveTime(target)
    setActiveIndex(safeIndex)
    setCurrentDuration(duration)
    setTimeLeft(duration)
    elapsedBeforeRunRef.current = 0
    startPerfRef.current = performance.now()
    setTurnStartedAt(Date.now())
    resetCues()
    setRunning(true)
  }

  useEffect(() => {
    if (!running) return

    let raf = 0
    const tick = () => {
      const elapsed =
        elapsedBeforeRunRef.current +
        Math.max(0, (performance.now() - startPerfRef.current) / 1000)
      const next = currentDuration - elapsed
      setTimeLeft(next)
      fireCues(next)
      raf = window.requestAnimationFrame(tick)
    }

    raf = window.requestAnimationFrame(tick)
    return () => window.cancelAnimationFrame(raf)
  }, [running, currentDuration, settings.tonePalette, settings.cueVolume, settings.muted])

  const fireCues = (nextTime: number) => {
    const duration = currentDuration || 1
    const thresholds = [
      { key: 'half', time: duration * 0.5 },
      { key: 'quarter', time: duration * 0.25 },
      { key: 'tenth', time: duration * 0.1 },
      { key: 'zero', time: 0 },
    ]

    thresholds.forEach((cue) => {
      if (nextTime <= cue.time && !cuesRef.current.has(cue.key)) {
        cuesRef.current.add(cue.key)
        const freq = toneFor(cue.key, settings.tonePalette)
        const vol = settings.muted ? 0 : settings.cueVolume
        toneRef.current.play(freq, cue.key === 'zero' ? 0.28 : 0.18, vol)
      }
    })
  }

  const handleStartSession = () => {
    if (!draftPlayers.length) return
    const prepared = [...draftPlayers]
    const first = prepared[0]
    const duration = first ? computeEffectiveTime(first) : 0
    setPlayers(prepared)
    setActiveIndex(0)
    setCurrentDuration(duration)
    setTimeLeft(duration)
    elapsedBeforeRunRef.current = 0
    startPerfRef.current = performance.now()
    setTurnStartedAt(Date.now())
    resetCues()
    setRunning(true)
    setPhase('playing')

    setDraftSecondsText({})
    setScoreText(Object.fromEntries(prepared.map((p) => [p.id, String(p.score)])))
  }

  const handleAddPlayer = () => {
    const nextIndex = draftPlayers.length + 1
    const nextId = `p${nextIndex}`
    setDraftPlayers((prev) => [
      ...prev,
      {
        id: nextId,
        name: `Player ${nextIndex}`,
        baseSeconds: settings.defaultSeconds,
        score: 0,
      },
    ])

    setDraftSecondsText((prev) => ({ ...prev, [nextId]: String(settings.defaultSeconds) }))
  }

  const handleUpdateDraft = (id: string, field: keyof Player, value: string | number) => {
    setDraftPlayers((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p
        if (field === 'id') return p
        if (field === 'name') return { ...p, name: String(value) }
        const numValue = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(numValue)) return p
        const numeric = clamp(numValue, 10, 900)
        if (field === 'baseSeconds') return { ...p, baseSeconds: numeric }
        if (field === 'score') return { ...p, score: numeric }
        return p
      }),
    )
  }

  const commitDraftSeconds = (playerId: string) => {
    const raw = (draftSecondsText[playerId] ?? '').trim()
    const parsed = Number(raw)
    const next = Number.isFinite(parsed) ? clamp(Math.round(parsed), 10, 900) : 10
    handleUpdateDraft(playerId, 'baseSeconds', next)
    setDraftSecondsText((prev) => ({ ...prev, [playerId]: String(next) }))
  }

  const commitScore = (playerId: string) => {
    const raw = (scoreText[playerId] ?? '').trim()
    const parsed = Number(raw)
    const next = Number.isFinite(parsed) ? Math.trunc(parsed) : 0
    handleScoreChange(playerId, next)
    setScoreText((prev) => ({ ...prev, [playerId]: String(next) }))
  }

  const handleRemoveDraft = (id: string) => {
    setDraftPlayers((prev) => (prev.length > 1 ? prev.filter((p) => p.id !== id) : prev))
    setDraftSecondsText((prev) => {
      const copy = { ...prev }
      delete copy[id]
      return copy
    })
  }

  const handleScoreChange = (id: string, value: number) => {
    setPlayers((prev) => prev.map((p) => (p.id === id ? { ...p, score: value } : p)))
  }

  // Snapshot recording is now handled inline via buildScoreSnapshot()

  const applyScoresFromInputs = (currentPlayers: Player[]) =>
    currentPlayers.map((p) => {
      const raw = (scoreText[p.id] ?? '').trim()
      const parsed = Number(raw)
      const next = Number.isFinite(parsed) ? Math.trunc(parsed) : p.score
      return { ...p, score: next }
    })

  const buildScoreSnapshot = (snapshotPlayers: Player[]): ScoreSnapshot | null => {
    if (!snapshotPlayers.length) return null
    return {
      id: `${Date.now()}-scores`,
      timestamp: Date.now(),
      scores: snapshotPlayers.map((p) => ({ playerId: p.id, name: p.name, score: p.score })),
    }
  }

  const handleContinueGame = () => {
    // Commit inputs, record snapshot, then resume timer
    const nextPlayers = applyScoresFromInputs(players)
    setPlayers(nextPlayers)
    setScoreText(Object.fromEntries(nextPlayers.map((p) => [p.id, String(p.score)])))
    const snap = buildScoreSnapshot(nextPlayers)
    if (snap) setScoreHistory((prev) => [snap, ...prev].slice(0, 50))
    setScoreHistoryPage(0)
    setPhase('playing')
    resumeTimer()
  }

  const handleEndSession = () => {
    // Commit inputs and record final snapshot
    const nextPlayers = applyScoresFromInputs(players)
    setPlayers(nextPlayers)
    setScoreText(Object.fromEntries(nextPlayers.map((p) => [p.id, String(p.score)])))
    const finalSnap = buildScoreSnapshot(nextPlayers)
    const finalHistory = finalSnap ? [finalSnap, ...scoreHistory] : scoreHistory

    const archive: SessionArchive = {
      id: `${Date.now()}-session`,
      savedAt: Date.now(),
      players: nextPlayers.map((p) => ({ ...p })),
      turnHistory: [...turnHistory],
      scoreHistory: finalHistory,
      settings: { ...settings },
    }
    setArchives((prev) => [archive, ...prev].slice(0, 50))
    setArchivesPage(0)

    // Reset back to setup
    handleReset()
  }

  const handleReset = () => {
    setPhase('setup')
    setPlayers([])
    setRunning(false)
    setTimeLeft(0)
    setCurrentDuration(0)
    setActiveIndex(0)
    setTurnHistory([])
    setScoreHistory([])
    setUndoStack([])
    startPerfRef.current = 0
    elapsedBeforeRunRef.current = 0
    setDraftSecondsText({})
    setScoreText({})
    resetCues()
  }

  const logTurnEntry = (usedSeconds: number, endedAt: number) => {
    const player = activePlayer
    if (!player) return
    const entry: TurnEntry = {
      id: `${endedAt}-${player.id}`,
      playerId: player.id,
      playerName: player.name,
      usedSeconds,
      startedAt: turnStartedAt,
      endedAt,
    }
    setTurnHistory((prev) => [entry, ...prev].slice(0, 50))
  }

  const nextTurn = () => {
    if (!players.length) return

    // Prevent unintended turn switches while adjusting scores.
    if (phase !== 'playing') return

    setUndoStack((prev) => [...prev.slice(-19), { activeIndex, timeLeft, currentDuration, startedAt: turnStartedAt }])

    const usedSeconds = Math.max(0, currentDuration - timeLeft)
    logTurnEntry(usedSeconds, Date.now())
    startTurn(activeIndex + 1)
  }

  const undoTurn = () => {
    setUndoStack((prev) => {
      if (!prev.length) return prev
      const copy = [...prev]
      const last = copy.pop()!
      setTurnHistory((hist) => hist.slice(1))
      setActiveIndex(last.activeIndex)
      setCurrentDuration(last.currentDuration)
      setTimeLeft(last.timeLeft)
      setTurnStartedAt(Date.now())
      elapsedBeforeRunRef.current = Math.max(0, last.currentDuration - last.timeLeft)
      startPerfRef.current = performance.now()
      resetCues()
      setRunning(true)
      return copy
    })
  }

  const handleRummi = () => {
    pauseTimer()
    setPhase('scores')
  }

  // Back to timer handled by handleContinueGame

  const timerState = (() => {
    if (timeLeft <= 0) return 'overtime'
    if (timeLeft <= currentDuration * 0.1) return 'critical'
    if (timeLeft <= currentDuration * 0.25) return 'warn'
    if (timeLeft <= currentDuration * 0.5) return 'mid'
    return 'fresh'
  })()

  return (
    <div
      className={`page ${phase}`}
      onClick={phase === 'playing' ? nextTurn : undefined}
      style={phase === 'playing' ? { cursor: 'pointer' } : undefined}
    >
      <div className="app-scale" ref={appScaleRef}>
      {phase === 'setup' ? (
        <>
          <div className="centered-layout">
            <div className="header-centered">
              <h1>Rummikub Timer</h1>
            </div>

            <div className="content-centered">
              <div className="players-section">
                <p className="field-label-global">Seconds per turn</p>

                <div className="players-grid-horizontal">
                  {draftPlayers.map((player) => (
                    <div className="player-box" key={player.id}>
                      <input
                        className="player-name-box"
                        value={player.name}
                        onChange={(e) => handleUpdateDraft(player.id, 'name', e.target.value)}
                        placeholder="Player name"
                      />
                      <div className="number-control-box">
                        <button
                          className="big-btn"
                          onClick={() => {
                            const next = Math.max(10, player.baseSeconds - 1)
                            handleUpdateDraft(player.id, 'baseSeconds', next)
                            setDraftSecondsText((prev) => ({ ...prev, [player.id]: String(next) }))
                          }}
                        >
                          −
                        </button>
                        <input 
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          className="big-number-input"
                          value={draftSecondsText[player.id] ?? String(player.baseSeconds)}
                          onChange={(e) => {
                            const raw = e.target.value
                            const cleaned = raw.replace(/[^0-9]/g, '')
                            setDraftSecondsText((prev) => ({ ...prev, [player.id]: cleaned }))
                          }}
                          onBlur={() => commitDraftSeconds(player.id)}
                        />
                        <button
                          className="big-btn"
                          onClick={() => {
                            const next = Math.min(900, player.baseSeconds + 1)
                            handleUpdateDraft(player.id, 'baseSeconds', next)
                            setDraftSecondsText((prev) => ({ ...prev, [player.id]: String(next) }))
                          }}
                        >
                          +
                        </button>
                      </div>
                      <button className="big-btn remove-btn" onClick={() => handleRemoveDraft(player.id)} title="Remove player">
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </div>

              <div className="actions-centered">
                <button className="action-button" onClick={handleAddPlayer}>
                  Add player
                </button>
                <button className="primary" disabled={!draftPlayers.length} onClick={handleStartSession}>
                  Start match
                </button>
                <button className="action-button" onClick={() => setPhase('settings')}>
                  ⚙
                </button>
              </div>
            </div>
          </div>
        </>
      ) : phase === 'playing' ? (
        <>
          <div className="fullscreen-timer">
            <div className="timer-header-centered">
              <h2 className="player-name-centered">{activePlayer?.name ?? 'No player'}</h2>
              <div className="corner-controls">
                <button
                  className={`mini-btn ${running ? 'hold-required' : ''}`}
                  disabled={!undoStack.length}
                  title={running ? 'Hold to use' : 'Undo'}
                  {...getLongPressProps(undoTurn, running)}
                >
                  ↶
                </button>
                <button
                  className={`mini-btn ${running ? 'hold-required' : ''}`}
                  title={running ? 'Hold to open settings' : 'Settings'}
                  {...getLongPressProps(() => setPhase('settings'), running)}
                >
                  ⚙
                </button>
              </div>
            </div>

            <div className={`timer-main ${timerState}`}>
              <div className="timer-display">
                <div className={`big-time ${timerState === 'critical' || timerState === 'overtime' ? 'magnify' : ''}`}>{formatClock(timeLeft)}</div>
              </div>
            </div>

            <div className="action-bar" onClick={(e) => e.stopPropagation()}>
              <button
                className={`rummi-btn ${running ? 'hold-required' : ''}`}
                title={running ? 'Hold to open scores' : 'RUMMI'}
                {...getLongPressProps(handleRummi, running)}
              >
                RUMMI
              </button>
              <button
                className="pause-btn"
                onClick={(e) => {
                  e.stopPropagation()
                  if (running) pauseTimer()
                  else resumeTimer()
                }}
              >
                {running ? '⏸' : '▶'}
              </button>
            </div>
          </div>
        </>
      ) : phase === 'scores' ? (
        <>
          <div className="centered-layout">
            <div className="header-centered">
              <h1>Adjust Scores</h1>
            </div>

            <div className="content-centered">
              <div className="scores-grid">
                {players.map((player, idx) => {
                  const effective = computeEffectiveTime(player)
                  const delta = effective - player.baseSeconds
                  return (
                    <div key={player.id} className={`score-box ${idx === activeIndex ? 'active' : ''}`}>
                      <h3>{player.name}</h3>
                      <div className="badge-time">{formatClock(effective)}</div>
                      <div className="number-control-box">
                        <button
                          className="big-btn"
                          onClick={() => {
                            const next = player.score - 1
                            handleScoreChange(player.id, next)
                            setScoreText((prev) => ({ ...prev, [player.id]: String(next) }))
                          }}
                        >
                          −
                        </button>
                        <input 
                          type="text"
                          inputMode="numeric"
                          className="big-number-input"
                          value={scoreText[player.id] ?? String(player.score)}
                          onChange={(e) => {
                            const raw = e.target.value
                            // Allow direct negative typing like "-10" while avoiding multiple dashes
                            const cleaned = raw.replace(/[^0-9-]/g, '')
                            const normalized = cleaned.startsWith('-')
                              ? `-${cleaned.slice(1).replace(/-/g, '')}`
                              : cleaned.replace(/-/g, '')
                            setScoreText((prev) => ({ ...prev, [player.id]: normalized }))
                          }}
                          onBlur={() => commitScore(player.id)}
                        />
                        <button
                          className="big-btn"
                          onClick={() => {
                            const next = player.score + 1
                            handleScoreChange(player.id, next)
                            setScoreText((prev) => ({ ...prev, [player.id]: String(next) }))
                          }}
                        >
                          +
                        </button>
                      </div>
                      <p className="help-text">{delta === 0 ? 'No handicap' : delta > 0 ? `+${delta.toFixed(1)}s` : `${delta.toFixed(1)}s`}</p>
                    </div>
                  )
                })}
              </div>

              <div className="actions-centered">
                <button className="primary" onClick={handleContinueGame} disabled={!players.length}>
                  Continue game
                </button>
                <button className="secondary" onClick={handleEndSession} disabled={!players.length}>
                  End session
                </button>
              </div>

              {!!scoreHistory.length && (
                <div className="history-panel">
                  <div className="panel-header">
                    <h3>Score History</h3>
                    <div className="history-pagination">
                      <button
                        className="mini-btn"
                        onClick={() => setScoreHistoryPage((p) => Math.max(0, p - 1))}
                        disabled={scoreHistoryPage === 0}
                        title="Newer"
                      >
                        ‹
                      </button>
                      <button
                        className="mini-btn"
                        onClick={() =>
                          setScoreHistoryPage((p) =>
                            (p + 1) * SCORE_HISTORY_PAGE_SIZE < scoreHistory.length ? p + 1 : p,
                          )
                        }
                        disabled={(scoreHistoryPage + 1) * SCORE_HISTORY_PAGE_SIZE >= scoreHistory.length}
                        title="Older"
                      >
                        ›
                      </button>
                    </div>
                  </div>
                  <div className="history-grid">
                    {scoreHistory
                      .slice(
                        scoreHistoryPage * SCORE_HISTORY_PAGE_SIZE,
                        scoreHistoryPage * SCORE_HISTORY_PAGE_SIZE + SCORE_HISTORY_PAGE_SIZE,
                      )
                      .map((snap) => (
                      <div key={snap.id} className="history-card">
                        <div className="history-card-header">
                          <span className="badge-time">{new Date(snap.timestamp).toLocaleString()}</span>
                        </div>
                        <div className="history-scores-grid">
                          {snap.scores.map((s) => (
                            <div key={`${snap.id}-${s.playerId}`} className="history-score-tile">
                              <div className="history-player">{s.name}</div>
                              <div className="history-score">{s.score}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      ) : phase === 'archives' ? (
        <>
          <div className="centered-layout">
            <div className="header-centered">
              <h1>Previous sessions</h1>
              <button className="icon-only-btn" onClick={() => setPhase('settings')}>
                ✕
              </button>
            </div>

            <div className="content-centered">
              {!archives.length ? (
                <div className="panel">
                  <div className="panel-header">
                    <h3>No archives yet</h3>
                  </div>
                  <p className="help">Finish a session with “End session” to save it here.</p>
                </div>
              ) : (
                <div className="archive-grid">
                  {archives
                    .slice(archivesPage * ARCHIVES_PAGE_SIZE, archivesPage * ARCHIVES_PAGE_SIZE + ARCHIVES_PAGE_SIZE)
                    .map((a) => (
                    <div key={a.id} className="archive-card">
                      <div className="archive-card-header">
                        <span className="badge-time">{new Date(a.savedAt).toLocaleString()}</span>
                        <span className="archive-meta">
                          {a.players.length} players · {a.turnHistory.length} turns · {a.scoreHistory.length} snapshots
                        </span>
                      </div>

                      <div className="archive-scores-grid">
                        {a.players.map((p) => (
                          <div key={`${a.id}-${p.id}`} className="history-score-tile">
                            <div className="history-player">{p.name}</div>
                            <div className="history-score">{p.score}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {!!archives.length && (
                <div className="archive-pagination">
                  <button
                    className="secondary"
                    onClick={() => setArchivesPage((p) => Math.max(0, p - 1))}
                    disabled={archivesPage === 0}
                  >
                    Newer
                  </button>
                  <button
                    className="secondary"
                    onClick={() =>
                      setArchivesPage((p) => ((p + 1) * ARCHIVES_PAGE_SIZE < archives.length ? p + 1 : p))
                    }
                    disabled={(archivesPage + 1) * ARCHIVES_PAGE_SIZE >= archives.length}
                  >
                    Older
                  </button>
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        <>
          <div className="centered-layout">
            <div className="header-centered">
              <h1>Settings</h1>
              <button className="icon-only-btn" onClick={() => setPhase(players.length ? 'playing' : 'setup')}>
                ✕
              </button>
            </div>

            <div className="content-centered">
              <div className="settings-grid">
                <section className="settings-section">
                  <div className="panel-header">
                    <h3>Handicap</h3>
                  </div>

                  <div className="settings-center">
                    <p className="help">Positive scores lose time; negative scores gain time.</p>
                    <label className="switch-large">
                      <input
                        type="checkbox"
                        checked={settings.handicapEnabled}
                        onChange={(e) => setSettings((s) => ({ ...s, handicapEnabled: e.target.checked }))}
                      />
                      <span>{settings.handicapEnabled ? 'On' : 'Off'}</span>
                    </label>
                  </div>

                  {settings.handicapEnabled && (
                    <div className="settings-control">
                      <span>Seconds per point</span>
                      <div className="number-control">
                        <button className="big-btn" onClick={() => setSettings((s) => ({ ...s, handicapSecondsPerPoint: Math.max(0, s.handicapSecondsPerPoint - 0.1) }))}>−</button>
                        <span className="big-number">{settings.handicapSecondsPerPoint.toFixed(1)}</span>
                        <button className="big-btn" onClick={() => setSettings((s) => ({ ...s, handicapSecondsPerPoint: s.handicapSecondsPerPoint + 0.1 }))}>+</button>
                      </div>
                    </div>
                  )}
                </section>

                  <section className="settings-section">
                  <div className="panel-header">
                    <h3>Audio</h3>
                  </div>

                  <div className="settings-control">
                    <span>Cue volume</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={settings.cueVolume}
                      onChange={(e) => setSettings((s) => ({ ...s, cueVolume: Number(e.target.value) }))}
                    />
                    <p className="help">Current: {(settings.cueVolume * 100).toFixed(0)}%</p>
                  </div>

                  <div className="settings-center">
                    <span>Mute all sounds</span>
                    <label className="switch-large">
                      <input
                        type="checkbox"
                        checked={settings.muted}
                        onChange={(e) => setSettings((s) => ({ ...s, muted: e.target.checked }))}
                      />
                      <span>{settings.muted ? 'On' : 'Off'}</span>
                    </label>
                  </div>
                </section>

                  <section className="settings-section">
                  <div className="panel-header">
                    <h3>Game</h3>
                  </div>

                  <div className="settings-center">
                    <button className="secondary" onClick={handleReset}>
                      Restart game
                    </button>
                  </div>
                </section>

                <section className="settings-section">
                  <div className="settings-center">
                    <button className="secondary" onClick={() => setPhase('archives')}>
                      Previous sessions
                    </button>
                  </div>
                </section>
              </div>
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  )
}

export default App
