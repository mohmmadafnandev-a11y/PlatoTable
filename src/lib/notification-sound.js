// Notification chime.
//
// Both panels poll, so a message the platform sends while someone is working
// arrives silently — and an alert that only appears in a list nobody is watching
// is not really a notification. This is a short two-note chime synthesised with
// the Web Audio API rather than loaded from an audio file: it costs no bytes,
// makes no request, and cannot 404 after a deploy.
//
// The one real constraint is autoplay. Browsers keep an AudioContext suspended
// until the person has interacted with the page, so each panel calls
// `armNotificationSound()` as it mounts: the first gesture anywhere on the page
// — on the admin, that is the sign-in click — unlocks audio. Anything that needs
// to chime before that gesture is remembered and plays the moment the context is
// running, which is what makes "open the admin and hear the message that was
// already waiting" work on a cold load. Without the arming, that first chime
// waited for a second, unrelated click, which reads as no sound at all.

const STORAGE_KEY = 'platotable-admin-notification-sound'
const GESTURES = ['pointerdown', 'keydown', 'touchstart']

// Two notes, the second brighter, which reads as a doorbell rather than an
// alarm. Anything longer gets irritating when a platform sends several
// messages in a row.
const NOTES = [
  { frequency: 880, offset: 0 },
  { frequency: 1174.66, offset: 0.15 },
]

const NOTE_LENGTH = 0.42

let context = null
let pending = false
let armed = false
let enabled = readEnabled()

function readEnabled() {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'off'
  } catch {
    // Private browsing: sound stays on, it just will not be remembered.
    return true
  }
}

function emit() {
  if (!context) return
  const start = context.currentTime
  const master = context.createGain()
  master.gain.value = 0.16
  master.connect(context.destination)

  NOTES.forEach(({ frequency, offset }) => {
    const oscillator = context.createOscillator()
    const envelope = context.createGain()
    oscillator.type = 'sine'
    oscillator.frequency.value = frequency
    // A short attack and an exponential tail: a bare square edge on a sine
    // reads as a click rather than a chime.
    envelope.gain.setValueAtTime(0.0001, start + offset)
    envelope.gain.linearRampToValueAtTime(1, start + offset + 0.02)
    envelope.gain.exponentialRampToValueAtTime(0.0001, start + offset + NOTE_LENGTH)
    oscillator.connect(envelope)
    envelope.connect(master)
    oscillator.start(start + offset)
    oscillator.stop(start + offset + NOTE_LENGTH + 0.02)
  })
}

export function isNotificationSoundEnabled() {
  return enabled
}

export function setNotificationSoundEnabled(next) {
  enabled = Boolean(next)
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off')
  } catch {
    // The choice simply does not persist.
  }
  // Turning it back on is an interaction in itself, so it can unlock audio.
  if (enabled) unlock()
  return enabled
}

/**
 * Arms the unlock listener for the life of the page.
 *
 * Called once by each panel as it mounts, before any notification is known to
 * exist — that ordering is the point. The listeners are not removed after the
 * first gesture because a browser can suspend the context again when a tab sits
 * idle, and resuming on the next click is cheaper than losing a chime.
 */
export function armNotificationSound() {
  if (armed || typeof window === 'undefined' || !enabled) return
  armed = true
  GESTURES.forEach((name) => window.addEventListener(name, unlock, { passive: true }))
}

function unlock() {
  if (typeof window === 'undefined' || !enabled) return
  if (!context) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    if (!AudioContextClass) return
    try {
      context = new AudioContextClass()
    } catch {
      return
    }
  }
  if (context.state === 'suspended') context.resume().catch(() => {})
  if (pending) {
    pending = false
    emit()
  }
}

export function playNotificationSound() {
  if (typeof window === 'undefined' || !enabled) return
  if (!context || context.state !== 'running') {
    // Held until the page has been interacted with. Arming here as well covers
    // the case where the panel mounted while sound was switched off and it was
    // then switched on, so no listener is attached yet.
    pending = true
    armNotificationSound()
    return
  }
  emit()
}
