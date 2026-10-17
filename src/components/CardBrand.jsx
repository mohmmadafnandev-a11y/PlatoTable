// The card marks, drawn rather than spelled.
//
// "VISA" printed in the same typeface as the surrounding labels is a word, not a
// logo, and it makes the place where money is handled read like a settings form.
// These are the actual network marks in their own colours: recognising the card is
// the entire job here, and a person checking whether their card saved correctly
// reads a shape long before they read a word.
//
// Every mark is drawn on one 64x40 chip so that a row of them carries the same
// optical weight, and so that swapping a brand never moves the layout around it.
// The wordmarks are set in the system sans rather than in the brands' own fonts —
// those are licensed and would not ship — but in the brand's own colour, which is
// what does the recognising.

const CHIP = { width: 64, height: 40 }
const SANS = "'Helvetica Neue', Helvetica, Arial, sans-serif"

/** The chip every mark sits in, so they are all the same size and edge. */
const Chip = ({ fill = '#fff', stroke = 'rgba(24,20,16,.10)', children }) => (
  <svg className="card-mark" viewBox={`0 0 ${CHIP.width} ${CHIP.height}`} aria-hidden="true" focusable="false">
    <rect x=".5" y=".5" width={CHIP.width - 1} height={CHIP.height - 1} rx="6.5" fill={fill} stroke={stroke} />
    {children}
  </svg>
)

const Wordmark = ({ children, fill, size = 13.5, weight = 800, spacing = 0.4, y = 24.4 }) => (
  <text
    x={CHIP.width / 2}
    y={y}
    textAnchor="middle"
    fill={fill}
    fontFamily={SANS}
    fontSize={size}
    fontWeight={weight}
    letterSpacing={spacing}
  >
    {children}
  </text>
)

// The blue wordmark with the gold flag over the V. The flag is clipped to the V
// alone, which is the whole trick of the mark — a gold band across all four
// letters would just look like a printing fault.
const Visa = () => (
  <Chip>
    <defs>
      <clipPath id="pt-mark-visa-v"><rect x="9" y="7" width="15" height="26" /></clipPath>
      <linearGradient id="pt-mark-visa-flag" x1="0" y1="1" x2="1" y2="0">
        <stop offset="0%" stopColor="#F4A400" />
        <stop offset="55%" stopColor="#F7B600" />
        <stop offset="100%" stopColor="#F19A2E" />
      </linearGradient>
    </defs>
    <text
      x={CHIP.width / 2}
      y="27"
      textAnchor="middle"
      fill="#1A1F71"
      fontFamily={SANS}
      fontSize="19"
      fontStyle="italic"
      fontWeight="800"
      letterSpacing="0.2"
    >
      VISA
    </text>
    <g clipPath="url(#pt-mark-visa-v)">
      <rect x="8" y="-6" width="6.5" height="52" fill="url(#pt-mark-visa-flag)" transform="rotate(20 11 20)" />
    </g>
  </Chip>
)

// Two discs and the lens where they cross. The lens is drawn by clipping the
// second disc to the first rather than by working out the intersection path:
// the geometry is exact, and it stays exact when the radius changes.
const Mastercard = () => (
  <Chip fill="#16161A" stroke="rgba(255,255,255,.14)">
    <defs>
      <clipPath id="pt-mark-mc-first"><circle cx="26" cy="20" r="11.5" /></clipPath>
    </defs>
    <circle cx="26" cy="20" r="11.5" fill="#EB001B" />
    <circle cx="38" cy="20" r="11.5" fill="#F79E1B" />
    <g clipPath="url(#pt-mark-mc-first)"><circle cx="38" cy="20" r="11.5" fill="#FF5F00" /></g>
  </Chip>
)

const Amex = () => (
  <Chip fill="#006FCF" stroke="rgba(255,255,255,.16)">
    <Wordmark fill="#fff" size="12.5" spacing="0.6">AMEX</Wordmark>
  </Chip>
)

const Discover = () => (
  <Chip>
    <path d="M44 33.5c6.4-1.6 9.6-4.6 10.6-8.4.7 2.9.4 5.6-.7 8.4z" fill="#F48120" />
    <Wordmark fill="#4D4D4D" size="8.6" spacing="0.1" y="23.6">DISCOVER</Wordmark>
    <circle cx="52.4" cy="27.4" r="3" fill="#F48120" />
  </Chip>
)

// Anything not drawn above — Diners, JCB, UnionPay, Maestro, a network this
// build has never heard of. A neutral chip with the brand's initial keeps the row
// even and still says "a card", which is the honest amount of information.
const Generic = ({ label = 'Card' }) => (
  <Chip>
    <rect x="10" y="12" width="44" height="16" rx="3" fill="#EFE7DE" />
    <rect x="10" y="15.5" width="44" height="4" fill="#C9B7A5" />
    <text x={CHIP.width / 2} y={CHIP.height - 6} textAnchor="middle" fill="#8A7A6C" fontFamily={SANS} fontSize="7.5" fontWeight="700" letterSpacing="0.4">
      {String(label).toUpperCase().slice(0, 10)}
    </text>
  </Chip>
)

const MARKS = { visa: Visa, mastercard: Mastercard, amex: Amex, discover: Discover }

/**
 * The mark for a brand, or a neutral chip naming it.
 *
 * `label` is used only for the accessible name; the drawing is what does the
 * work on screen.
 */
export default function CardBrand({ brand, label }) {
  const Mark = MARKS[String(brand || '').toLowerCase()] || Generic
  return (
    <span className="card-mark-chip" role="img" aria-label={label || brand || 'Card'}>
      <Mark label={label || brand} />
    </span>
  )
}
