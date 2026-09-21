import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import QRCode from 'qrcode'
import { supabase } from '../lib/supabase'
import {
  BadgePercent,
  CircleSlash,
  Clock3,
  Globe2,
  Mail,
  MessageCircle,
  Phone,
  QrCode,
  Check,
  UtensilsCrossed,
} from 'lucide-react'
import './Landing.css'

// Fallbacks, used only when platform_settings cannot be read. The live values
// come from Super Admin → System settings so the published contact details have
// a single source of truth.
const FALLBACK_SUPPORT = {
  platformName: 'Plato Table',
  phone: '0300 5443434',
  email: 'mohmmadafnan.dev@gmail.com',
}
const WHATSAPP_MESSAGE = encodeURIComponent('Hi Plato Table — I would like a digital menu for my restaurant.')

/**
 * Turn a stored phone number into link-safe forms.
 * Our own support number is a Pakistani mobile, so a leading zero with eleven
 * digits expands to the +92 country code. Anything already international (a
 * leading plus) is used as-is, and anything else yields no WhatsApp link rather
 * than a broken one.
 */
function phoneParts(raw) {
  const display = (raw || FALLBACK_SUPPORT.phone).trim()
  const digits = display.replace(/[^\d+]/g, '')
  let international = ''
  if (digits.startsWith('+')) international = digits.slice(1)
  else if (digits.startsWith('0') && digits.length === 11) international = `92${digits.slice(1)}`
  else if (digits.length >= 10) international = digits
  return {
    display,
    tel: international ? `+${international}` : '',
    whatsapp: international ? `https://wa.me/${international}?text=${WHATSAPP_MESSAGE}` : '',
  }
}

function usePlatformContact() {
  const [contact, setContact] = useState(null)
  useEffect(() => {
    let active = true
    if (!supabase) return undefined
    supabase.rpc('public_platform_contact').then(({ data }) => {
      if (active && data) setContact(Array.isArray(data) ? data[0] : data)
    })
    return () => { active = false }
  }, [])
  return contact
}

const STEPS = [
  {
    title: 'Add your menu',
    body: 'Categories, items, prices, and photos. Change a price or mark something as sold out and every table sees it immediately.',
  },
  {
    title: 'Print your table codes',
    body: 'Generate one QR code per table from your dashboard, then download or print them. They stay valid until you replace them.',
  },
  {
    title: 'Guests scan and browse',
    body: 'The menu opens in the phone browser — no app, no download. You watch tables come alive from the live status screen.',
  },
]

const FEATURES = [
  {
    icon: QrCode,
    title: 'One code per table',
    body: 'A permanent, printable code for every table. Regenerate it any time and the old one stops working instantly.',
  },
  {
    icon: Clock3,
    title: 'Live table sessions',
    body: 'See which table is browsing, which device, and how long they have been seated — in real time.',
  },
  {
    icon: UtensilsCrossed,
    title: 'A menu you control',
    body: 'Reorder categories, hide items, and update prices without reprinting a single sheet of paper.',
  },
  {
    icon: BadgePercent,
    title: 'Offers that sell',
    body: 'Put a discount on any item with a start and end date. Guests see the saving right on the menu.',
  },
  {
    icon: CircleSlash,
    title: 'Sold out in one tap',
    body: 'Something runs out mid-service? Hide it in a second so guests are never shown what you cannot serve.',
  },
  {
    icon: Globe2,
    title: 'Priced in your currency',
    body: 'Pakistani rupees, dirhams, dollars, pounds, or riyals — the menu shows prices the way your guests expect.',
  },
]

const PRICING = [
  '7 days free — full access, no card required',
  'Unlimited tables, QR codes, and menu items',
  'Offers, categories, and live table monitoring',
  'Billing starts after the trial, cancel any time',
]

function useScrollReveal(rootRef) {
  useEffect(() => {
    const nodes = rootRef.current?.querySelectorAll('.lp-reveal')
    if (!nodes?.length) return undefined
    // Without IntersectionObserver every section stays hidden, so show them.
    if (!('IntersectionObserver' in window)) {
      nodes.forEach((node) => node.classList.add('is-visible'))
      return undefined
    }
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return
          entry.target.classList.add('is-visible')
          observer.unobserve(entry.target)
        })
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
    )
    nodes.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [rootRef])
}

function HeroQr({ whatsappLink }) {
  const [dataUrl, setDataUrl] = useState('')

  useEffect(() => {
    let active = true
    if (!whatsappLink) return undefined
    QRCode.toDataURL(whatsappLink, {
      width: 360,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#1b1a18', light: '#ffffff' },
    })
      .then((url) => { if (active) setDataUrl(url) })
      .catch(() => { if (active) setDataUrl('') })
    return () => { active = false }
  }, [whatsappLink])

  return (
    <div className="lp-qr-card lp-rise" style={{ '--lp-delay': '.18s' }}>
      <span className="lp-qr-chip">Try this</span>
      <div className="lp-qr-frame">
        {dataUrl
          ? <img src={dataUrl} alt="QR code that opens a WhatsApp chat with Plato Table" className="lp-pop" />
          : <div className="lp-qr-skeleton" aria-hidden="true" />}
      </div>
      <div className="lp-qr-cap">
        <strong>Scan it — this is the whole product</strong>
        <p>Point your camera here and it opens a WhatsApp chat. Your guests get the same instant experience, except it opens your menu.</p>
      </div>
    </div>
  )
}

export default function Landing() {
  const rootRef = useRef(null)
  const [stuck, setStuck] = useState(false)
  const contact = usePlatformContact()
  useScrollReveal(rootRef)

  // Published values come from Super Admin → System settings; the fallbacks
  // keep the page intact if that lookup is unavailable.
  const platformName = contact?.platform_name || FALLBACK_SUPPORT.platformName
  const phone = phoneParts(contact?.support_phone)
  const email = contact?.support_email || FALLBACK_SUPPORT.email
  const whatsappLink = phone.whatsapp

  useEffect(() => {
    const onScroll = () => setStuck(window.scrollY > 12)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [])

  return (
    <div className="lp-root" ref={rootRef}>
      <header className={`lp-header${stuck ? ' is-stuck' : ''}`}>
        <div className="lp-shell">
          <Link className="lp-brand" to="/">
            <span className="lp-mark">P</span>
            <span>
              <strong>{platformName}</strong>
              <small>Digital menus</small>
            </span>
          </Link>
          <nav className="lp-nav">
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href="#contact">Contact</a>
          </nav>
          <div className="lp-header-cta">
            <Link className="lp-btn lp-btn-ghost lp-btn-sm" to="/admin">Platform sign in</Link>
          </div>
        </div>
      </header>

      <main>
        {contact?.maintenance_mode && (
          <div className="lp-shell" style={{ paddingTop: 18 }}>
            <div className="lp-maintenance" role="status">
              {contact.maintenance_message || 'We are doing a short maintenance and will be back shortly.'}
            </div>
          </div>
        )}

        <section className="lp-hero">
          <div className="lp-shell lp-hero-grid">
            <div>
              <span className="lp-eyebrow lp-rise"><i />Digital menus for restaurants</span>
              <h1 className="lp-rise" style={{ '--lp-delay': '.06s' }}>
                Your menu, on every table,<br />the moment they <em>sit down</em>.
              </h1>
              <p className="lp-lede lp-rise" style={{ '--lp-delay': '.12s' }}>
                Guests scan the QR code on their table and your menu opens instantly on their phone.
                No app to install, nothing to reprint, and every price you change shows up straight away.
              </p>
              <div className="lp-hero-actions lp-rise" style={{ '--lp-delay': '.18s' }}>
                {whatsappLink && (
                  <a className="lp-btn lp-btn-accent" href={whatsappLink} target="_blank" rel="noreferrer">
                    <MessageCircle size={17} />Start your free trial
                  </a>
                )}
                <a className="lp-btn lp-btn-ghost" href="#how">See how it works</a>
              </div>
              <div className="lp-note lp-rise" style={{ '--lp-delay': '.24s' }}>
                <span><Check size={14} />7-day free trial</span>
                <span><Check size={14} />No setup fee</span>
                <span><Check size={14} />Works on any phone</span>
              </div>
            </div>
            <HeroQr whatsappLink={whatsappLink} />
          </div>
        </section>

        <section className="lp-section" id="how">
          <div className="lp-shell">
            <div className="lp-section-head lp-reveal">
              <span className="lp-eyebrow"><i />How it works</span>
              <h2>Three steps from paper to phone</h2>
              <p>You do not need a developer, an app, or a new printer. Most restaurants are live the same afternoon.</p>
            </div>
            <div className="lp-steps">
              {STEPS.map((step, index) => (
                <article className="lp-step lp-reveal" key={step.title} style={{ transitionDelay: `${index * 90}ms` }}>
                  <span className="lp-step-num">{index + 1}</span>
                  <h3>{step.title}</h3>
                  <p>{step.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="lp-section" id="features">
          <div className="lp-shell">
            <div className="lp-section-head lp-reveal">
              <span className="lp-eyebrow"><i />What you get</span>
              <h2>Everything a busy service needs</h2>
              <p>Built for the middle of a dinner rush, not for a demo. Fast on a cheap phone and a weak signal.</p>
            </div>
            <div className="lp-grid">
              {FEATURES.map((feature, index) => {
                const Icon = feature.icon
                return (
                  <article className="lp-feature lp-reveal" key={feature.title} style={{ transitionDelay: `${(index % 3) * 90}ms` }}>
                    <Icon size={22} />
                    <h3>{feature.title}</h3>
                    <p>{feature.body}</p>
                  </article>
                )
              })}
            </div>
          </div>
        </section>

        <section className="lp-section" id="pricing">
          <div className="lp-shell">
            <div className="lp-section-head lp-reveal">
              <span className="lp-eyebrow"><i />Pricing</span>
              <h2>One plan, everything included</h2>
              <p>Start free. Keep it only if it earns its place in your service.</p>
            </div>
            <div className="lp-price-card lp-reveal">
              <div>
                <span className="lp-price-tag">Standard plan</span>
                <div className="lp-price-amount"><strong>$19</strong><span>per month</span></div>
                <p className="lp-price-alt">Also billed as around AED 79 or PKR 2,000. No setup fee, cancel whenever you like.</p>
              </div>
              <ul className="lp-price-list">
                {PRICING.map((line) => (
                  <li key={line}><Check size={16} />{line}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <section className="lp-contact" id="contact">
          <div className="lp-shell">
            <div className="lp-section-head lp-reveal">
              <span className="lp-eyebrow"><i />Contact</span>
              <h2>Talk to us directly</h2>
              <p>Message us and we will set your restaurant up with you — menu, prices, and printed table codes.</p>
            </div>
            <div className="lp-contact-grid">
              {whatsappLink && (
                <a className="lp-contact-item lp-reveal" href={whatsappLink} target="_blank" rel="noreferrer">
                  <span className="lp-contact-icon"><MessageCircle size={20} /></span>
                  <span>
                    <small>WhatsApp</small>
                    <strong>{phone.display}</strong>
                    <em>Fastest reply — tap to chat</em>
                  </span>
                </a>
              )}
              {phone.tel && (
                <a className="lp-contact-item lp-reveal" href={`tel:${phone.tel}`} style={{ transitionDelay: '90ms' }}>
                  <span className="lp-contact-icon"><Phone size={20} /></span>
                  <span>
                    <small>Phone</small>
                    <strong>{phone.display}</strong>
                    <em>{phone.tel}</em>
                  </span>
                </a>
              )}
              <a className="lp-contact-item lp-reveal" href={`mailto:${email}`} style={{ transitionDelay: '180ms' }}>
                <span className="lp-contact-icon"><Mail size={20} /></span>
                <span>
                  <small>Email</small>
                  <strong>{email}</strong>
                  <em>For invoices and onboarding</em>
                </span>
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="lp-footer">
        <div className="lp-shell">
          <p>© {new Date().getFullYear()} {platformName} · QR digital menus for restaurants</p>
          <nav>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
            <a href="#contact">Contact</a>
            <Link to="/admin">Platform sign in</Link>
          </nav>
        </div>
      </footer>
    </div>
  )
}
