import { Link } from 'react-router-dom'

// Placeholder platform landing page. Deliberately bare: it reuses the existing
// scan-error/brand-mark styles so it ships without touching the design system.
// The real marketing page is later work.
export default function Landing() {
  return (
    <main className="scan-error">
      <div className="brand-mark">P</div>
      <h1>Plato Table</h1>
      <p>Digital menus for restaurants. Customers scan the QR code on their table and the menu opens on their phone.</p>
      <p><Link to="/admin">Platform sign in</Link></p>
    </main>
  )
}
