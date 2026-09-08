import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Link, Navigate, useNavigate } from 'react-router-dom'
import { fallbackMenuItems, recentScans } from '../data'
import { supabase } from '../lib/supabase'
import './Admin.css'

const navigation = [
  ['dashboard', '⌂', 'Overview'], ['menu', '◫', 'Menu'], ['offers', '✦', 'Offers'],
  ['qr', '▦', 'QR Codes'], ['live', '◉', 'Live status'], ['settings', '⚙', 'Settings'],
]

function LoginPage() {
  const navigate = useNavigate()
  const [credentials, setCredentials] = useState({ username: '', password: '' })
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const login = async (event) => {
    event.preventDefault()
    setLoading(true)
    setError('')
    if (credentials.username === 'admin' && credentials.password === 'admin') {
      localStorage.setItem('saffron-admin', 'demo')
      navigate('/admin')
      return
    }
    if (supabase && credentials.username.includes('@')) {
      const { error: authError } = await supabase.auth.signInWithPassword({ email: credentials.username, password: credentials.password })
      if (!authError) {
        localStorage.setItem('saffron-admin', 'supabase')
        navigate('/admin')
        return
      }
    }
    setError('Invalid credentials. Use admin / admin for the demo.')
    setLoading(false)
  }

  return <main className="login-page"><section className="login-visual"><Link className="login-brand" to="/"><span>S</span>Saffron Table</Link><div><span className="login-kicker">RESTAURANT COMMAND CENTER</span><h1>Every table.<br /><em>One beautiful view.</em></h1><p>Manage your menu, offers and guest sessions from anywhere.</p></div><small>Premium digital dining, thoughtfully managed.</small></section><section className="login-form-wrap"><form className="login-form" onSubmit={login}><span className="eyebrow">STAFF PORTAL</span><h2>Welcome back</h2><p>Enter your credentials to continue.</p><label>Username or email<input required value={credentials.username} onChange={(event) => setCredentials({ ...credentials, username: event.target.value })} placeholder="admin" /></label><label>Password<input required type="password" value={credentials.password} onChange={(event) => setCredentials({ ...credentials, password: event.target.value })} placeholder="••••••••" /></label>{error && <div className="login-error">{error}</div>}<button className="admin-primary login-submit" disabled={loading}>{loading ? 'Signing in…' : 'Sign in →'}</button><small>Demo access: <strong>admin / admin</strong></small></form></section></main>
}

function Dashboard() {
  const stats = [['Total tables', '24', '+3 this month', '▦'], ['Menu items', '48', '6 categories', '◫'], ['Today’s scans', '186', '+18.2% vs yesterday', '↗'], ['Active offers', '03', '2 ending soon', '✦']]
  return <><div className="admin-heading"><div><span className="admin-kicker">MONDAY, 7 SEPTEMBER</span><h1>Good morning, Ayaan</h1><p>Here’s what’s happening at Saffron Table today.</p></div><button className="admin-primary">＋ Add menu item</button></div><div className="stats-grid">{stats.map(([label, value, detail, icon]) => <article className="stat-card" key={label}><div className="stat-icon">{icon}</div><span>{label}</span><strong>{value}</strong><small>{detail}</small></article>)}</div><div className="dashboard-grid"><article className="admin-card chart-card"><div className="card-heading"><div><span>QR scans</span><strong>Guest activity</strong></div><button>Last 7 days⌄</button></div><div className="chart-total"><strong>1,284</strong><span>↗ 12.4%</span></div><div className="bar-chart">{[42, 58, 48, 76, 65, 92, 72].map((height, index) => <div key={height}><span style={{ height: `${height}%` }} /><small>{['M', 'T', 'W', 'T', 'F', 'S', 'S'][index]}</small></div>)}</div></article><article className="admin-card popular-card"><div className="card-heading"><div><span>This week</span><strong>Popular dishes</strong></div><button>View all</button></div>{fallbackMenuItems.slice(0, 4).map((item, index) => <div className="popular-row" key={item.id}><b>0{index + 1}</b><img src={item.image} alt="" /><span><strong>{item.name}</strong><small>{22 - index * 3}% of views</small></span><em>PKR {item.price}</em></div>)}</article></div><article className="admin-card activity-card"><div className="card-heading"><div><span>Live updates</span><strong>Recent table activity</strong></div><button>See live view →</button></div><div className="activity-table"><div className="activity-head"><span>TABLE</span><span>DEVICE</span><span>SCANNED</span><span>STATUS</span></div>{recentScans.map((scan) => <div className="activity-row" key={`${scan.table}-${scan.time}`}><strong>{scan.table}</strong><span>{scan.device}</span><span>{scan.time}</span><i className={scan.status.toLowerCase()}>{scan.status}</i></div>)}</div></article></>
}

const restaurantId = '11111111-1111-4111-8111-111111111111'
const categoryIds = {
  starters: '21111111-1111-4111-8111-111111111111',
  mains: '21111111-1111-4111-8111-111111111112',
  grills: '21111111-1111-4111-8111-111111111113',
  drinks: '21111111-1111-4111-8111-111111111114',
  desserts: '21111111-1111-4111-8111-111111111115',
}

function getSavedMenu() {
  try {
    const saved = localStorage.getItem('saffron-menu')
    return saved ? JSON.parse(saved) : fallbackMenuItems
  } catch {
    return fallbackMenuItems
  }
}

function MenuManager() {
  const [items, setItems] = useState(getSavedMenu)
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    localStorage.setItem('saffron-menu', JSON.stringify(items))
  }, [items])

  useEffect(() => {
    if (!supabase || localStorage.getItem('saffron-admin') === 'demo') return
    const loadItems = async () => {
      const { data, error } = await supabase.from('menu_items').select('*, categories(name)').order('display_order')
      if (!error && data?.length) setItems(data.map((item) => ({ ...item, image: item.image_url, category: item.categories?.name?.toLowerCase() || 'mains', time: '15–25 min' })))
    }
    loadItems()
  }, [])

  const syncItem = async (item) => {
    if (!supabase || localStorage.getItem('saffron-admin') === 'demo') return
    await supabase.from('menu_items').upsert({
      id: item.id,
      restaurant_id: restaurantId,
      category_id: categoryIds[item.category] || categoryIds.mains,
      name: item.name,
      description: item.description,
      price: item.price,
      image_url: item.image,
      is_available: item.is_available,
    })
  }

  const saveItem = async (event) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const item = {
      id: editing?.id || crypto.randomUUID(),
      name: form.get('name').trim(),
      category: form.get('category'),
      price: Number(form.get('price')),
      image: form.get('image').trim() || fallbackMenuItems[0].image,
      description: form.get('description').trim(),
      time: editing?.time || '15–25 min',
      is_available: editing?.is_available ?? true,
    }
    setItems((current) => current.some((entry) => entry.id === item.id) ? current.map((entry) => entry.id === item.id ? item : entry) : [item, ...current])
    await syncItem(item)
    setEditing(null)
    setMessage(editing?.id ? 'Menu item updated' : 'Menu item created')
  }

  const toggle = async (item) => {
    const updated = { ...item, is_available: !item.is_available }
    setItems((current) => current.map((entry) => entry.id === item.id ? updated : entry))
    await syncItem(updated)
  }

  const remove = async (item) => {
    if (!window.confirm(`Delete ${item.name}?`)) return
    setItems((current) => current.filter((entry) => entry.id !== item.id))
    if (supabase && localStorage.getItem('saffron-admin') !== 'demo') await supabase.from('menu_items').delete().eq('id', item.id)
    setMessage('Menu item deleted')
  }

  const visibleItems = items.filter((item) => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()))
  const emptyItem = { name: '', category: 'mains', price: '', image: '', description: '', is_available: true }

  return <><div className="admin-heading"><div><span className="admin-kicker">{items.length} ITEMS · 6 CATEGORIES</span><h1>Menu management</h1><p>Curate what your guests see on the digital menu.</p></div><button className="admin-primary" onClick={() => setEditing(emptyItem)}>＋ Add new item</button></div>{message && <div className="admin-success">✓ {message}<button onClick={() => setMessage('')}>×</button></div>}<div className="manage-toolbar"><label>⌕ <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search menu items…" /></label><button>All categories⌄</button><button>All statuses⌄</button></div><div className="admin-menu-grid">{visibleItems.map((item) => <article className={`admin-dish ${item.is_available ? '' : 'unavailable'}`} key={item.id}><div className="admin-dish-image"><img src={item.image} alt="" /><div><button onClick={() => setEditing(item)}>Edit</button><button onClick={() => remove(item)}>Delete</button></div></div><div><span className="admin-kicker">{item.category}</span><h3>{item.name}</h3><p>{item.description}</p><footer><strong>PKR {Number(item.price).toLocaleString()}</strong><button onClick={() => toggle(item)} className={item.is_available ? 'toggle on' : 'toggle'}><span />{item.is_available ? 'Available' : 'Sold out'}</button></footer></div></article>)}</div>{!visibleItems.length && <div className="admin-empty">No menu items match your search.</div>}{editing && <div className="admin-modal-backdrop" role="dialog" aria-modal="true" aria-label="Menu item editor"><form className="admin-modal" onSubmit={saveItem}><header><div><span className="admin-kicker">MENU EDITOR</span><h2>{editing.id ? 'Edit menu item' : 'Add new item'}</h2></div><button type="button" onClick={() => setEditing(null)}>×</button></header><div className="admin-form-grid"><label>Item name<input name="name" required defaultValue={editing.name} placeholder="e.g. Smoky Chicken Karahi" /></label><label>Category<select name="category" defaultValue={editing.category}>{Object.keys(categoryIds).map((category) => <option key={category} value={category}>{category[0].toUpperCase() + category.slice(1)}</option>)}</select></label><label>Price (PKR)<input name="price" required min="0" type="number" defaultValue={editing.price} placeholder="1290" /></label><label>Image URL<input name="image" type="url" defaultValue={editing.image} placeholder="https://…" /></label><label className="full">Description<textarea name="description" rows="4" defaultValue={editing.description} placeholder="Describe the flavours and ingredients…" /></label></div><footer><button type="button" onClick={() => setEditing(null)}>Cancel</button><button className="admin-primary">{editing.id ? 'Save changes' : 'Create item'} →</button></footer></form></div>}</>
}

function QrCard({ table, token, active = true }) {
  const [source, setSource] = useState('')
  useEffect(() => {
    QRCode.toDataURL(`${window.location.origin}/scan/${token}`, { width: 420, margin: 2, color: { dark: '#35271C', light: '#FFFDF9' } }).then(setSource)
  }, [token])
  return <article className="qr-card"><div className="qr-top"><span className={active ? 'qr-state active' : 'qr-state'}>{active ? '● Active' : '○ Inactive'}</span><button>•••</button></div>{source && <img src={source} alt={`QR code for ${table}`} />}<h3>{table}</h3><p>{token}</p><div><a href={source} download={`${table.replace(' ', '-')}-qr.png`}>↓ Download</a><button onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/scan/${token}`)}>Copy link</button></div></article>
}

function QRManager() {
  return <><div className="admin-heading"><div><span className="admin-kicker">24 ACTIVE TABLES</span><h1>QR code management</h1><p>Create, download and monitor your table QR codes.</p></div><button className="admin-primary">＋ Generate new QR</button></div><div className="manage-toolbar"><label>⌕ <input placeholder="Search tables or tokens…" /></label><button>All QR codes⌄</button><button>↓ Export all</button></div><div className="qr-grid"><QrCard table="Table 01" token="SFR-TBL-001" /><QrCard table="Table 02" token="SFR-TBL-002" /><QrCard table="Garden 01" token="SFR-GDN-001" /><QrCard table="VIP Lounge" token="SFR-VIP-001" active={false} /></div></>
}

function Offers() {
  return <><div className="admin-heading"><div><span className="admin-kicker">03 ACTIVE OFFERS</span><h1>Special offers</h1><p>Create memorable reasons for guests to try something new.</p></div><button className="admin-primary">＋ Create offer</button></div><div className="offer-admin-grid">{fallbackMenuItems.filter((item) => item.is_offer).map((item) => <article className="admin-offer" key={item.id}><img src={item.image} alt="" /><span className="offer-status">ACTIVE</span><div><span className="admin-kicker">ENDS IN 2 DAYS</span><h2>{item.name}</h2><p>Chef’s special offer for dine-in guests.</p><footer><span><s>PKR {item.price}</s><strong>PKR {item.offer_price}</strong></span><button>Edit offer →</button></footer></div></article>)}</div></>
}

function LiveStatus() {
  return <><div className="admin-heading"><div><span className="admin-kicker">AUTO-REFRESHING</span><h1>Live restaurant status</h1><p>See active guest sessions and scans as they happen.</p></div><button className="admin-secondary"><span className="live-dot" /> Sound alerts on</button></div><article className="admin-card activity-card live-card"><div className="live-count"><strong>03</strong><span>Active sessions right now</span></div><div className="activity-table"><div className="activity-head"><span>TABLE</span><span>DEVICE</span><span>SCANNED</span><span>TIME LEFT</span></div>{recentScans.slice(0, 3).map((scan, index) => <div className="activity-row" key={scan.table}><strong>{scan.table}</strong><span>{scan.device}</span><span>{scan.time}</span><i className="active">{14 - index * 3}:32</i></div>)}</div></article></>
}

function Settings() {
  return <><div className="admin-heading"><div><span className="admin-kicker">RESTAURANT PROFILE</span><h1>Settings</h1><p>Manage your restaurant identity and menu preferences.</p></div><button className="admin-primary">Save changes</button></div><div className="settings-grid"><article className="admin-card settings-form"><h2>Restaurant details</h2><label>Restaurant name<input defaultValue="Saffron Table" /></label><label>Contact email<input defaultValue="hello@saffrontable.pk" /></label><label>Phone<input defaultValue="+92 300 123 4567" /></label><label>Address<textarea defaultValue="12 Main Boulevard, Lahore" /></label></article><article className="admin-card settings-form"><h2>Menu preferences</h2><label>Currency<select defaultValue="PKR"><option>PKR</option><option>USD</option><option>EUR</option></select></label><label>QR session duration<select defaultValue="15 minutes"><option>15 minutes</option><option>30 minutes</option><option>60 minutes</option></select></label><label>Menu style<select defaultValue="Premium grid"><option>Premium grid</option><option>Compact list</option></select></label><div className="setting-note">Supabase connection is configured. Live data appears once the PRD database schema is applied.</div></article></div></>
}

function AdminShell() {
  const navigate = useNavigate()
  const [page, setPage] = useState('dashboard')
  const views = { dashboard: <Dashboard />, menu: <MenuManager />, offers: <Offers />, qr: <QRManager />, live: <LiveStatus />, settings: <Settings /> }
  const logout = async () => { if (supabase) await supabase.auth.signOut(); localStorage.removeItem('saffron-admin'); navigate('/') }
  return <main className="admin-shell"><aside className="admin-sidebar"><Link to="/" className="admin-brand"><span>S</span><div><strong>Saffron</strong><small>RESTAURANT OS</small></div></Link><nav>{navigation.map(([id, icon, label]) => <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}><span>{icon}</span>{label}{id === 'live' && <i />}</button>)}</nav><div className="sidebar-footer"><div className="restaurant-chip"><span>ST</span><div><strong>Saffron Table</strong><small>Administrator</small></div></div><button onClick={logout}>↪ Log out</button></div></aside><section className="admin-workspace"><header className="admin-topbar"><button className="mobile-menu">☰</button><label>⌕ <input placeholder="Search anything…" /></label><Link to="/">View guest menu ↗</Link><button className="notification">♢<i /></button><div className="avatar">AK</div></header><div className="admin-content">{views[page]}</div></section></main>
}

export default function AdminApp({ login = false }) {
  if (login) return <LoginPage />
  if (!localStorage.getItem('saffron-admin')) return <Navigate to="/admin/login" replace />
  return <AdminShell />
}
