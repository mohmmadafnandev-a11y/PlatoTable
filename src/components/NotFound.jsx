import { Link } from 'react-router-dom'

// Shown for an unknown path or a slug that does not match any restaurant.
// Replaces the old catch-all, which redirected every unknown URL to /scan and
// therefore showed a QR error instead of an honest 404.
export default function NotFound() {
  return (
    <main className="scan-error">
      <div className="brand-mark">P</div>
      <span>⌁</span>
      <h1>Page not found</h1>
      <p>This link does not match a restaurant or an available page.</p>
      <p><Link to="/">Go to Plato Table</Link></p>
    </main>
  )
}
