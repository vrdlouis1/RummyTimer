import { useEffect, useRef, useCallback, useState } from 'react'

// Sound profile learned from calibration samples
export type SoundProfile = {
  // Volume characteristics
  peakLevel: number
  avgLevel: number
  minTriggerLevel: number
  
  // Frequency characteristics (which frequency bands are dominant)
  frequencySignature: number[] // normalized weights for frequency bands
  
  // Timing characteristics
  attackTimeMs: number // how fast the sound rises
  durationMs: number // how long the sound lasts
  
  // Computed from samples
  sampleCount: number
}

type SoundSample = {
  peakLevel: number
  avgLevel: number
  frequencyData: number[]
  attackTimeMs: number
  durationMs: number
}

type SoundTriggerOptions = {
  enabled: boolean
  threshold: number // 0-1, base sensitivity (used if no profile)
  cooldownMs: number
  soundProfile: SoundProfile | null
  onTrigger: () => void
}

type CalibrationState = 'idle' | 'listening' | 'recording' | 'processing'

const DEFAULT_PROFILE: SoundProfile = {
  peakLevel: 0.5,
  avgLevel: 0.3,
  minTriggerLevel: 0.4,
  frequencySignature: [],
  attackTimeMs: 50,
  durationMs: 150,
  sampleCount: 0,
}

// Compute similarity between current sound and profile (0-1)
function computeSimilarity(
  currentLevel: number,
  currentFreqData: number[],
  profile: SoundProfile
): number {
  if (profile.sampleCount === 0) {
    // No calibration, just use level
    return currentLevel >= profile.minTriggerLevel ? 1 : 0
  }

  // Level similarity (must be at least minTriggerLevel)
  if (currentLevel < profile.minTriggerLevel * 0.7) {
    return 0
  }
  
  const levelScore = Math.min(1, currentLevel / profile.peakLevel)
  
  // Frequency similarity (cosine similarity)
  let freqScore = 1
  if (profile.frequencySignature.length > 0 && currentFreqData.length > 0) {
    const minLen = Math.min(profile.frequencySignature.length, currentFreqData.length)
    let dotProduct = 0
    let normA = 0
    let normB = 0
    
    for (let i = 0; i < minLen; i++) {
      dotProduct += profile.frequencySignature[i] * currentFreqData[i]
      normA += profile.frequencySignature[i] ** 2
      normB += currentFreqData[i] ** 2
    }
    
    const denom = Math.sqrt(normA) * Math.sqrt(normB)
    freqScore = denom > 0 ? dotProduct / denom : 0
  }
  
  // Combined score (level matters more than frequency pattern)
  return levelScore * 0.6 + freqScore * 0.4
}

export function useSoundTrigger({
  enabled,
  threshold = 0.5,
  cooldownMs = 500,
  soundProfile,
  onTrigger,
}: SoundTriggerOptions) {
  const [isListening, setIsListening] = useState(false)
  const [hasPermission, setHasPermission] = useState<boolean | null>(null)
  const [audioLevel, setAudioLevel] = useState(0)
  const [similarity, setSimilarity] = useState(0)

  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)
  const lastTriggerRef = useRef<number>(0)
  const onTriggerRef = useRef(onTrigger)
  const profileRef = useRef(soundProfile)

  // Track for transient detection
  const prevLevelRef = useRef(0)
  const risingEdgeStartRef = useRef<number | null>(null)

  useEffect(() => {
    onTriggerRef.current = onTrigger
  }, [onTrigger])

  useEffect(() => {
    profileRef.current = soundProfile
  }, [soundProfile])

  const startListening = useCallback(async () => {
    if (isListening) return

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.2
      source.connect(analyser)
      analyserRef.current = analyser

      setHasPermission(true)
      setIsListening(true)
    } catch (err) {
      console.error('Microphone access denied:', err)
      setHasPermission(false)
    }
  }, [isListening])

  const stopListening = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }

    analyserRef.current = null
    setIsListening(false)
    setAudioLevel(0)
    setSimilarity(0)
  }, [])

  // Main audio analysis loop
  useEffect(() => {
    if (!enabled || !isListening || !analyserRef.current) return

    const analyser = analyserRef.current
    const freqData = new Uint8Array(analyser.frequencyBinCount)
    const profile = profileRef.current || DEFAULT_PROFILE

    const analyze = () => {
      analyser.getByteFrequencyData(freqData)

      // Calculate current level
      const sum = freqData.reduce((a, b) => a + b, 0)
      const currentLevel = sum / (freqData.length * 255)
      setAudioLevel(currentLevel)

      // Normalize frequency data for comparison
      const normalizedFreq = Array.from(freqData).map(v => v / 255)

      // Detect rising edge (transient)
      const now = performance.now()
      const levelDelta = currentLevel - prevLevelRef.current
      
      if (levelDelta > 0.05 && risingEdgeStartRef.current === null) {
        // Sound is rising rapidly - potential trigger start
        risingEdgeStartRef.current = now
      }

      // Check if this could be a valid trigger
      const effectiveThreshold = profile.sampleCount > 0 
        ? profile.minTriggerLevel 
        : threshold

      if (currentLevel > effectiveThreshold) {
        const sim = computeSimilarity(currentLevel, normalizedFreq, profile)
        setSimilarity(sim)

        const timeSinceLastTrigger = Date.now() - lastTriggerRef.current
        
        // Trigger conditions:
        // 1. Similarity above 0.5 (or level above threshold if no profile)
        // 2. Cooldown elapsed
        // 3. This is a rising transient (not sustained loud noise)
        const isTransient = risingEdgeStartRef.current !== null && 
          (now - risingEdgeStartRef.current) < 200 // Must be quick attack
        
        const shouldTrigger = profile.sampleCount > 0
          ? sim > 0.5 && isTransient
          : currentLevel > threshold && levelDelta > 0.02

        if (shouldTrigger && timeSinceLastTrigger > cooldownMs) {
          lastTriggerRef.current = Date.now()
          onTriggerRef.current()
          risingEdgeStartRef.current = null
        }
      } else {
        setSimilarity(0)
        // Reset rising edge if level dropped
        if (currentLevel < effectiveThreshold * 0.5) {
          risingEdgeStartRef.current = null
        }
      }

      prevLevelRef.current = currentLevel
      rafRef.current = requestAnimationFrame(analyze)
    }

    rafRef.current = requestAnimationFrame(analyze)

    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current)
      }
    }
  }, [enabled, isListening, threshold, cooldownMs])

  useEffect(() => {
    return () => {
      stopListening()
    }
  }, [stopListening])

  useEffect(() => {
    if (enabled && !isListening) {
      startListening()
    } else if (!enabled && isListening) {
      stopListening()
    }
  }, [enabled, isListening, startListening, stopListening])

  return {
    isListening,
    hasPermission,
    audioLevel,
    similarity,
    startListening,
    stopListening,
  }
}

// Separate hook for calibration
export function useSoundCalibration() {
  const [calibrationState, setCalibrationState] = useState<CalibrationState>('idle')
  const [samples, setSamples] = useState<SoundSample[]>([])
  const [currentLevel, setCurrentLevel] = useState(0)

  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const rafRef = useRef<number>(0)
  const recordingRef = useRef(false)
  const sampleBufferRef = useRef<{ level: number; freqData: number[]; time: number }[]>([])

  const startCalibration = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream

      const audioContext = new AudioContext()
      audioContextRef.current = audioContext

      const source = audioContext.createMediaStreamSource(stream)
      const analyser = audioContext.createAnalyser()
      analyser.fftSize = 512
      analyser.smoothingTimeConstant = 0.1
      source.connect(analyser)
      analyserRef.current = analyser

      setSamples([])
      setCalibrationState('listening')
      
      // Start monitoring
      const freqData = new Uint8Array(analyser.frequencyBinCount)
      let baselineLevel = 0
      let baselineFrames = 0
      const BASELINE_FRAMES = 30

      const monitor = () => {
        if (!analyserRef.current) return

        analyserRef.current.getByteFrequencyData(freqData)
        const sum = freqData.reduce((a, b) => a + b, 0)
        const level = sum / (freqData.length * 255)
        setCurrentLevel(level)

        // Build baseline for first frames
        if (baselineFrames < BASELINE_FRAMES) {
          baselineLevel += level
          baselineFrames++
        }

        const avgBaseline = baselineLevel / Math.max(1, baselineFrames)
        const threshold = Math.max(0.15, avgBaseline * 2)

        // Auto-detect sound and record
        if (recordingRef.current) {
          sampleBufferRef.current.push({
            level,
            freqData: Array.from(freqData).map(v => v / 255),
            time: performance.now(),
          })

          // Stop recording after sound ends (level drops)
          if (sampleBufferRef.current.length > 5) {
            const recentLevels = sampleBufferRef.current.slice(-5).map(s => s.level)
            const avgRecent = recentLevels.reduce((a, b) => a + b, 0) / recentLevels.length
            
            if (avgRecent < threshold * 0.5 || sampleBufferRef.current.length > 60) {
              // End of sound - process sample
              processSample()
              recordingRef.current = false
              setCalibrationState('listening')
            }
          }
        } else if (level > threshold && baselineFrames >= BASELINE_FRAMES) {
          // Sound detected - start recording
          recordingRef.current = true
          sampleBufferRef.current = [{ level, freqData: Array.from(freqData).map(v => v / 255), time: performance.now() }]
          setCalibrationState('recording')
        }

        rafRef.current = requestAnimationFrame(monitor)
      }

      rafRef.current = requestAnimationFrame(monitor)
    } catch (err) {
      console.error('Microphone access denied:', err)
      setCalibrationState('idle')
    }
  }, [])

  const processSample = useCallback(() => {
    const buffer = sampleBufferRef.current
    if (buffer.length < 3) return

    // Find peak
    const peakLevel = Math.max(...buffer.map(s => s.level))
    const avgLevel = buffer.reduce((a, s) => a + s.level, 0) / buffer.length

    // Average frequency signature
    const freqLength = buffer[0].freqData.length
    const avgFreq = new Array(freqLength).fill(0)
    buffer.forEach(s => {
      s.freqData.forEach((v, i) => {
        avgFreq[i] += v / buffer.length
      })
    })

    // Compute attack time (time to reach 80% of peak)
    const threshold80 = peakLevel * 0.8
    const attackFrame = buffer.findIndex(s => s.level >= threshold80)
    const attackTimeMs = attackFrame > 0 
      ? buffer[attackFrame].time - buffer[0].time 
      : 50

    // Duration
    const durationMs = buffer[buffer.length - 1].time - buffer[0].time

    const sample: SoundSample = {
      peakLevel,
      avgLevel,
      frequencyData: avgFreq,
      attackTimeMs,
      durationMs,
    }

    setSamples(prev => [...prev, sample])
    sampleBufferRef.current = []
  }, [])

  const stopCalibration = useCallback(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }

    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }

    analyserRef.current = null
    recordingRef.current = false
    setCalibrationState('idle')
    setCurrentLevel(0)
  }, [])

  const buildProfile = useCallback((): SoundProfile | null => {
    if (samples.length === 0) return null

    // Average all samples
    const avgPeakLevel = samples.reduce((a, s) => a + s.peakLevel, 0) / samples.length
    const avgAvgLevel = samples.reduce((a, s) => a + s.avgLevel, 0) / samples.length
    const avgAttackTime = samples.reduce((a, s) => a + s.attackTimeMs, 0) / samples.length
    const avgDuration = samples.reduce((a, s) => a + s.durationMs, 0) / samples.length

    // Average frequency signature
    const freqLength = samples[0].frequencyData.length
    const avgFreq = new Array(freqLength).fill(0)
    samples.forEach(s => {
      s.frequencyData.forEach((v, i) => {
        avgFreq[i] += v / samples.length
      })
    })

    // Normalize frequency signature
    const maxFreq = Math.max(...avgFreq)
    const normalizedFreq = maxFreq > 0 ? avgFreq.map(v => v / maxFreq) : avgFreq

    // Set trigger threshold at 70% of average peak (allows some variation)
    const minTriggerLevel = avgPeakLevel * 0.6

    return {
      peakLevel: avgPeakLevel,
      avgLevel: avgAvgLevel,
      minTriggerLevel,
      frequencySignature: normalizedFreq,
      attackTimeMs: avgAttackTime,
      durationMs: avgDuration,
      sampleCount: samples.length,
    }
  }, [samples])

  const clearSamples = useCallback(() => {
    setSamples([])
  }, [])

  return {
    calibrationState,
    samples,
    currentLevel,
    startCalibration,
    stopCalibration,
    buildProfile,
    clearSamples,
  }
}

