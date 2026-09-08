import { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const pages = { menu: ['Menu', '⌂'], offers: ['Offers', '✦'], search: ['Search', '⌕'], categories: ['Categories', '☷'] }

export default function CustomerApp({ session }) {
  const { token } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const page = location.pathname.split('/').at(-1)
  const activePage = pages[page] ? page : 'menu'
  const [menu, setMenu] = useState([])
  const [categories, setCategories] = useState([])
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let alive = true
    const load = async () => {
      const { data, error } = await supabase.rpc('get_scan_menu', { scan_token: token })
      if (!alive) return
      if (error || !data?.valid) { navigate('/scan', { replace: true }); return }
      setCategories(data.categories || [])
      setMenu(data.items || [])
      setLoading(false)
    }
    load()
    return () => { alive = false }
  }, [navigate, token])

  const remainingSeconds = Math.max(0, Math.floor((new Date(session.session_expires_at).getTime() - now) / 1000))
  const minutes = String(Math.floor(remainingSeconds / 60)).padStart(2, '0')
  const seconds = String(remainingSeconds % 60).padStart(2, '0')
  const visible = useMemo(() => menu.filter((item) => {
    const categoryMatches = category === 'all' || item.category_id === category
    return categoryMatches && `${item.name} ${item.description || ''}`.toLowerCase().includes(query.toLowerCase())
  }), [category, menu, query])
  const items = activePage === 'offers' ? visible.filter((item) => item.is_offer && (!item.offer_start_date || new Date(item.offer_start_date) <= new Date()) && (!item.offer_end_date || new Date(item.offer_end_date) > new Date())) : visible
  const go = (target) => navigate(`/scan/${token}/${target === 'menu' ? '' : target}`)

  return <main className="app-shell"><section className="menu-app">
    <header className="topbar"><div className="brand-mark">{session.restaurant_name?.slice(0, 1) || 'P'}</div><div className="brand-copy"><span className="eyebrow">WELCOME TO</span><strong>{session.restaurant_name}</strong></div><div className="table-status"><span className="live-dot" /><span>{session.table_number}</span><small>{minutes}:{seconds}</small></div></header>
    <section className="content-area">
      {activePage === 'search' ? <><div className="section-heading"><div><span className="eyebrow">FIND A DISH</span><h2>Search menu</h2></div></div><label className="search-field page-search"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search dishes or ingredients" /></label></> : <><div className="section-heading"><div><span className="eyebrow">{activePage === 'offers' ? 'AVAILABLE NOW' : 'OUR MENU'}</span><h2>{activePage === 'offers' ? 'Special offers' : 'Made for your table'}</h2></div>{activePage === 'menu' && <button className="search-button" onClick={() => go('search')} aria-label="Open search">⌕</button>}</div>
      {activePage === 'menu' && <div className="category-row">{[{ id: 'all', name: 'All', icon: '✦' }, ...categories].map((item) => <button key={item.id} className={category === item.id ? 'category active' : 'category'} onClick={() => setCategory(item.id)}><span>{item.icon}</span>{item.name}</button>)}</div>}
      {activePage === 'categories' && <div className="category-list">{categories.map((item) => <button key={item.id} className="category" onClick={() => { setCategory(item.id); go('menu') }}><span>{item.icon}</span>{item.name}</button>)}</div>}</>}
      {loading ? <div className="empty-state">Loading menu…</div> : <div className="menu-grid">{items.map((item) => <article className="dish-card" key={item.id}><button className="image-button" onClick={() => setSelected(item)}><>{item.image_url ? <img src={item.image_url} alt="" /> : <div className="image-placeholder">🍽</div>}</>{item.is_offer && <span className="discount-badge">OFFER</span>}</button><div className="dish-info"><h3>{item.name}</h3><p>{item.description}</p><div className="price-line"><strong>{session.currency} {Number(item.is_offer ? item.offer_price : item.price).toLocaleString()}</strong>{item.is_offer && <s>{session.currency} {Number(item.price).toLocaleString()}</s>}</div></div></article>)}</div>}
      {!loading && !items.length && <div className="empty-state">No items found.</div>}
    </section>
    <nav className="bottom-nav">{Object.entries(pages).map(([id, [, icon]]) => <button key={id} className={activePage === id ? 'nav-item active' : 'nav-item'} onClick={() => go(id)}><span>{icon}</span>{pages[id][0]}</button>)}</nav>
  </section>{selected && <div className="overlay" role="dialog"><article className="detail-modal"><button className="close-detail" onClick={() => setSelected(null)}>×</button>{selected.image_url && <img src={selected.image_url} alt={selected.name} />}<div className="detail-content"><h2>{selected.name}</h2><p>{selected.description}</p><strong>{session.currency} {Number(selected.is_offer ? selected.offer_price : selected.price).toLocaleString()}</strong></div></article></div>}</main>
}
