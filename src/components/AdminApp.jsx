import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

import { menuImageBucket, restaurantSlug, scanLink } from '../lib/restaurant-config'
import { CURRENCY, resolvePlanPrice } from '../../shared/plans.js'
import { billingPhases } from '../../shared/periods.js'
import { passwordError } from '../../shared/slug.js'
import { resolveAccountDestination } from '../lib/account-role'
import { SUPER_ADMIN_BASE } from '../lib/tenant'
import { describeAuthError } from '../lib/auth-errors'
import { useTheme } from '../lib/theme'
import { MAX_LOGIN_ATTEMPTS, clearLoginLock, registerFailedAttempt, useLoginLock } from '../lib/login-lock'
import { isRecoveryLink, sendPasswordReset } from '../lib/password-recovery'
import { armNotificationSound, isNotificationSoundEnabled, playNotificationSound, setNotificationSoundEnabled } from '../lib/notification-sound'
import { notificationTarget } from '../lib/notification-links'
import BrandMark from './BrandMark'
import CardBrand from './CardBrand'
import ResetPassword from './ResetPassword'
// Icons as components, not as characters. The workspace used to draw its
// navigation out of glyphs like ⌂ and ▦ — whatever the reader's system font
// happened to have, at whatever weight and optical size it chose, which is why
// two rows of the same list could look like two different products. These are one
// family at one stroke weight, so the sidebar reads as a set.
import {
  ArrowRight,
  BadgePercent,
  Bell,
  ChartColumn,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheckBig,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  FileText,
  Info,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Moon,
  Palette,
  Pencil,
  Plus,
  QrCode,
  Receipt,
  RefreshCw,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Store,
  Sun,
  Trash2,
  TriangleAlert,
  Upload,
  UtensilsCrossed,
  X,
} from 'lucide-react'
import './Admin.css'
// Imported after Admin.css so the dark layer is the later of the two for equal
// specificity. Every rule in it is also more specific than what it overrides.
import './AdminTheme.css'

// The workspace's own navigation, each entry carrying its icon component rather
// than a character.
const nav = [
  ['dashboard', LayoutDashboard, 'Overview'],
  ['menu', UtensilsCrossed, 'Menu'],
  ['offers', BadgePercent, 'Offers'],
  ['categories', LayoutGrid, 'Categories'],
  ['qr', QrCode, 'QR Codes'],
  ['subscription', CreditCard, 'Subscription'],
  ['usage', ChartColumn, 'Usage'],
  ['settings', SettingsIcon, 'Settings'],
]
// One stroke weight everywhere, so an icon never looks heavier than its
// neighbour because a different code path drew it.
const iconProps = { size: 18, strokeWidth: 1.8, 'aria-hidden': true, focusable: 'false' }
const subscriptionPages = ['subscription', 'payment', 'billing', 'notifications']
const Field = ({ label, children }) => <label>{label}{children}</label>
const PageLoader = ({ label = 'Loading data' }) => <div className="page-loader"><div className="loader-orbit"><i /><i /><i /></div><strong>{label}</strong><span>Please wait a moment</span></div>
const notify = (message, tone = 'success') => window.dispatchEvent(new CustomEvent('admin-feedback', { detail: { message, tone } }))
// A notification's call to action points either at a page inside this app or at
// a document Safepay hosts (a receipt). A router Link would treat the second as a
// path inside the app and render nothing useful, so the two are rendered
// differently — and a click on either must not also open the notification modal.
function ActionLink({ to, label, className, onFollow }) { const external = /^https?:\/\//i.test(to || ''); const follow = (event) => { event.stopPropagation(); onFollow?.() }; return external ? <a className={className} href={to} target="_blank" rel="noreferrer" onClick={follow}>{label}</a> : <Link className={className} to={to} onClick={follow}>{label}</Link> }
function Feedback() { const [notice, setNotice] = useState(null); useEffect(() => { const show = (event) => { setNotice(event.detail); window.setTimeout(() => setNotice(null), 3200) }; window.addEventListener('admin-feedback', show); return () => window.removeEventListener('admin-feedback', show) }, []); return notice && <div className={`admin-toast ${notice.tone}`} role="status">{notice.tone === 'success' ? <CircleCheckBig size={17} strokeWidth={2.1} aria-hidden="true" /> : <CircleAlert size={17} strokeWidth={2.1} aria-hidden="true" />}<span>{notice.message}</span></div> }

// The device lock is per restaurant, so one tenant fumbling their password does
// not lock the platform panel — or another restaurant — for anybody else.
const loginSurface = `restaurant:${restaurantSlug}`

function Login() {
  const navigate = useNavigate(); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(false); const [notice, setNotice] = useState(''); const [tenant, setTenant] = useState(() => (supabase && restaurantSlug ? undefined : null))
  // Shared with the platform panel: same three attempts, same hour, same copy.
  const { lock, clock: lockTime } = useLoginLock(loginSurface)
  // The sign-in screen names the restaurant it belongs to, and a slug with no
  // restaurant is reported here instead of showing a form that can never work.
  // The name above the form comes from a lookup that answers even while the
  // restaurant is suspended. public_tenant_by_slug() deliberately only resolves an
  // active restaurant — right for the public page, wrong here: it left exactly the
  // owners who needed to sign in, to add a card and renew, staring at "Restaurant
  // not found" with no form to sign in to.
  useEffect(() => { let active = true; if (!supabase || !restaurantSlug) return undefined; supabase.rpc('public_tenant_login', { p_slug: restaurantSlug }).then(({ data, error: lookupError }) => { if (!active) return; const record = typeof data === 'string' ? { name: data } : Array.isArray(data) ? data[0] : data; setTenant(lookupError || !record ? null : record) }); return () => { active = false } }, [])
  const submit = async (e) => { e.preventDefault(); if (lock) return; if (!supabase) return setError('Add Supabase environment variables first.'); setLoading(true); setNotice(''); const { data: signIn, error: authError } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password }); if (authError) { const described = describeAuthError(authError); if (!described.isCredentialFailure) { setError(described.message); setLoading(false); return } const { lock: nextLock, remaining } = registerFailedAttempt(loginSurface); setError(nextLock ? `This device is locked for one hour after ${MAX_LOGIN_ATTEMPTS} failed attempts.` : `${described.message} ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`); setPassword(''); setLoading(false) } else { clearLoginLock(loginSurface); const destination = await resolveAccountDestination(supabase, signIn?.user?.id); if (destination.kind === 'staff') { window.location.assign(SUPER_ADMIN_BASE); return } if (destination.kind === 'owner') { if (destination.slug === restaurantSlug) navigate(`/admin/${restaurantSlug}`); else window.location.assign(`/admin/${destination.slug}`); return } await supabase.auth.signOut(); setError('This sign-in is valid but the account manages no restaurant yet. Ask the platform team to activate your workspace.'); setLoading(false) } }
  // Sending the reset email needs an address, and this form is where it is
  // already typed. The redirect target is this restaurant's own login page,
  // because that is where the "set a new password" screen lives.
  const forgot = async () => { if (!email.trim()) return setError('Enter your email address first, then choose “Forgot password”.'); setLoading(true); setError(''); const { error: failure } = await sendPasswordReset(email.trim().toLowerCase(), `${window.location.origin}/admin/${restaurantSlug}/login`); setLoading(false); setNotice(failure ? `The reset email could not be sent: ${failure}` : 'If that address has an account, a reset link is on its way. Check the spam folder too.'); }
  // A reset link lands here. Showing the ordinary form instead is what made
  // "reset the password" appear to do nothing at all.
  if (isRecoveryLink()) return <ResetPassword loginPath={`/admin/${restaurantSlug}/login`} surface="restaurant" />
  if (tenant === null) return <main className="scan-error"><BrandMark size={42} /><h1>Restaurant not found</h1><p>No restaurant is registered at <strong>/{restaurantSlug}</strong>. Check the address, or ask the platform team for the correct link.</p><Link className="admin-primary" to="/">Back to platform home</Link></main>
  return <main className="login-page"><section className="login-visual"><Link className="login-brand" to={`/${restaurantSlug}`}><BrandMark size={37} />Plato Table</Link><div><span className="login-kicker">RESTAURANT COMMAND CENTER</span><h1>Your menu.<br /><em>Managed simply.</em></h1><p>A focused workspace for your menu, table QR codes, and restaurant details.</p><ul className="login-points"><li><UtensilsCrossed size={15} strokeWidth={2} aria-hidden="true" />Update the menu in seconds</li><li><QrCode size={15} strokeWidth={2} aria-hidden="true" />One QR code for every table</li><li><BadgePercent size={15} strokeWidth={2} aria-hidden="true" />Offers your guests actually notice</li></ul></div></section><section className="login-form-wrap"><form className="login-form login-card" onSubmit={submit} autoComplete="off"><div className="login-mobile-brand"><BrandMark size={38} /><strong>Plato Table</strong></div><span className="eyebrow">STAFF PORTAL</span><h2>{lock ? 'Access paused' : 'Welcome back'}</h2><p>{lock ? `Try again when the device lock ends in ${lockTime}.` : (tenant?.name ? `Sign in to manage ${tenant.name}.` : 'Sign in to manage your restaurant workspace.')}</p><Field label="Admin email"><input required type="email" name="staff-email" autoComplete="email" placeholder="owner@yourrestaurant.com" value={email} onChange={(e) => setEmail(e.target.value)} /></Field><Field label="Password"><input required disabled={Boolean(lock)} type="password" name="staff-password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>{(error || lock) && <div className="login-error">{lock ? `Too many failed attempts. This device is locked for ${lockTime}.` : error}</div>}{notice && <div className="login-notice" role="status">{notice}</div>}<div className="login-links"><button type="button" className="login-link" onClick={forgot} disabled={loading || Boolean(lock)}>Forgot password?</button></div><button className="admin-primary login-submit" disabled={loading || Boolean(lock)}>{loading ? 'Signing in…' : lock ? `Try again in ${lockTime}` : 'Sign in securely'}<ArrowRight size={15} strokeWidth={2.2} aria-hidden="true" /></button><small>{MAX_LOGIN_ATTEMPTS} incorrect passwords lock this browser for one hour. Ask the platform team for a reset link if you are stuck.</small></form></section></main>
}

function useData(table, restaurantId, order = 'display_order') {
  const [data, setData] = useState([]); const [error, setError] = useState(''); const [loading, setLoading] = useState(true)
  const reload = async () => { if (!restaurantId) return; setLoading(true); const result = await supabase.from(table).select('*').eq('restaurant_id', restaurantId).order(order, { ascending: order === 'display_order' }); if (result.error) setError(result.error.message); else setData(result.data || []); setLoading(false) }
  useEffect(() => { if (!restaurantId) return; supabase.from(table).select('*').eq('restaurant_id', restaurantId).order(order, { ascending: order === 'display_order' }).then((result) => { if (result.error) setError(result.error.message); else setData(result.data || []); setLoading(false) }) }, [restaurantId, table, order])
  return { data, error, loading, reload }
}

function Dashboard({ restaurantId, openPage, restaurantName }) {
  const { data: menu, loading: menuLoading } = useData('menu_items', restaurantId); const { data: categories, loading: categoryLoading } = useData('categories', restaurantId); const { data: tables, loading: tableLoading } = useData('qr_tokens', restaurantId, 'created_at')
  if (menuLoading || categoryLoading || tableLoading) return <PageLoader label="Loading dashboard" />
  const stats = [['Tables', tables.length, QrCode, 'qr'], ['Menu items', menu.length, UtensilsCrossed, 'menu'], ['Categories', categories.length, LayoutGrid, 'categories']]
  return <><Header kicker={`${(restaurantName || 'Your restaurant').toUpperCase()} WORKSPACE`} title="Good to see you" /><section className="admin-welcome"><div><span>YOUR RESTAURANT IS READY</span><strong>Keep your menu accurate and your table QR codes ready for guests.</strong></div><button onClick={() => openPage('qr')}>Manage table QRs <ArrowRight size={15} strokeWidth={2} aria-hidden="true" /></button></section><div className="stats-grid">{stats.map(([label, value, StatIcon, page]) => <button className="stat-card" key={label} onClick={() => openPage(page)}><div className="stat-icon"><StatIcon size={17} strokeWidth={1.9} aria-hidden="true" /></div><span>{label}</span><strong>{value}</strong><small>Manage {label.toLowerCase()}<ArrowRight size={12} strokeWidth={2.2} aria-hidden="true" /></small></button>)}</div><section className="quick-actions"><div><span className="admin-kicker">QUICK ACTIONS</span><h2>What do you need to do?</h2></div><button onClick={() => openPage('menu')}><b><Plus size={18} strokeWidth={2.1} aria-hidden="true" /></b><span><strong>Add a food item</strong><small>Add a dish, price, photo and category</small></span></button><button onClick={() => openPage('categories')}><b><LayoutGrid size={17} strokeWidth={1.9} aria-hidden="true" /></b><span><strong>Organize categories</strong><small>Keep your digital menu easy to browse</small></span></button></section></>
}

function Categories({ restaurantId }) {
  const { data, error, loading, reload } = useData('categories', restaurantId); const { data: menuItems, loading: menuLoading } = useData('menu_items', restaurantId); const [editing, setEditing] = useState(null); const save = async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const record = { restaurant_id: restaurantId, name: f.get('name').trim(), display_order: editing?.display_order ?? data.length, is_active: true }; const result = editing?.id ? await supabase.from('categories').update(record).eq('id', editing.id) : await supabase.from('categories').insert(record); if (result.error) return alert(result.error.message); setEditing(null); reload() }
  const remove = async (row) => { if (confirm(`Delete ${row.name}?`)) { const { error: deleteError } = await supabase.from('categories').delete().eq('id', row.id); if (deleteError) alert(deleteError.message); else reload() } }
  if (loading || menuLoading) return <PageLoader label="Loading categories" />
    return <><Header kicker={`${data.length} CATEGORIES`} title="Category management" action="Add category" onAction={() => setEditing({ name: '' })} />{error && <div className="login-error">{error}</div>}{data.length ? <div className="category-admin-list">{data.map((row) => <article className="category-admin-row" key={row.id}><div><strong>{row.name}</strong><small>{menuItems.filter((item) => item.category_id === row.id).length} item(s)</small></div><div><button className="admin-secondary" onClick={() => setEditing(row)}><Pencil size={14} strokeWidth={2} aria-hidden="true" />Edit</button><button className="danger-button" onClick={() => remove(row)}><Trash2 size={14} strokeWidth={2} aria-hidden="true" />Delete</button></div></article>)}</div> : <div className="empty-collection"><span><LayoutGrid size={26} strokeWidth={1.6} aria-hidden="true" /></span><h2>No categories yet</h2><p>Categories group your menu so guests can browse it quickly — Burgers, Drinks, Desserts.</p><button className="admin-primary" onClick={() => setEditing({ name: '' })}><Plus size={15} strokeWidth={2.2} aria-hidden="true" />Add your first category</button></div>}{editing && <Modal title={editing.id ? 'Edit category' : 'Add category'} close={() => setEditing(null)}><form onSubmit={save} className="admin-form-grid"><Field label="Category name"><input name="name" required defaultValue={editing.name} placeholder="e.g. Burgers" /></Field><button className="admin-primary">Save category</button></form></Modal>}</>
}

function MenuItemForm({ editing, categories, onSave }) {
  const initialImages = editing?.image_urls?.length ? editing.image_urls : editing?.image_url ? [editing.image_url] : []
  const [images, setImages] = useState(() => initialImages.map((url) => ({ id: crypto.randomUUID(), type: 'url', url, preview: url })))
  const [imageLink, setImageLink] = useState('')
  const addFiles = (event) => { const files = Array.from(event.target.files || []); const tooLarge = files.find((file) => file.size > 5242880); if (tooLarge) return notify('Each image must be 5 MB or smaller.', 'error'); setImages((current) => [...current, ...files.map((file) => ({ id: crypto.randomUUID(), type: 'file', file, preview: URL.createObjectURL(file) }))]); event.target.value = '' }
  const addLink = () => { const url = imageLink.trim(); if (!url) return; try { new URL(url) } catch { notify('Enter a complete public image URL.', 'error'); return } setImages((current) => [...current, { id: crypto.randomUUID(), type: 'url', url, preview: url }]); setImageLink('') }
  return <form onSubmit={(event) => { event.preventDefault(); onSave(new FormData(event.currentTarget), images) }} className="admin-form-grid"><Field label="Item name"><input name="name" required defaultValue={editing.name || ''} /></Field><Field label="Category"><select name="category" defaultValue={editing.category_id || ''}><option value="">No category</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field><Field label="Price"><input name="price" type="number" min="0" required defaultValue={editing.price || ''} /></Field><Field label="Available"><input name="available" type="checkbox" defaultChecked={editing.is_available ?? true} /></Field><Field label="Description"><textarea name="description" defaultValue={editing.description || ''} placeholder="Describe this dish" /></Field><section className="image-manager"><div className="image-manager-head"><div><strong>Product images</strong><small>Add photos from your device or public image links.</small></div><span>{images.length} image{images.length === 1 ? '' : 's'}</span></div><div className="image-actions"><label className="image-upload-button"><Upload size={14} strokeWidth={2} aria-hidden="true" />Upload images<input type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" onChange={addFiles} /></label><div className="image-link-add"><input value={imageLink} onChange={(event) => setImageLink(event.target.value)} placeholder="Paste image URL" /><button type="button" onClick={addLink}>Add link</button></div></div>{images.length > 0 && <div className="image-preview-grid">{images.map((image, index) => <article key={image.id}><img src={image.preview} alt="" decoding="async" /><span>{index === 0 ? 'Cover image' : `Image ${index + 1}`}</span><button type="button" onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} aria-label="Remove image"><X size={13} strokeWidth={2.4} aria-hidden="true" /></button></article>)}</div>}</section><button className="admin-primary">{editing.id ? 'Save changes' : 'Add menu item'}</button></form>
}

function Menu({ restaurantId }) {
  const { data: items, error, loading, reload } = useData('menu_items', restaurantId); const { data: categories, loading: categoriesLoading } = useData('categories', restaurantId); const [editing, setEditing] = useState(null); const [query, setQuery] = useState(''); const [categoryFilter, setCategoryFilter] = useState(''); const [minPrice, setMinPrice] = useState(''); const [maxPrice, setMaxPrice] = useState(''); const [availability, setAvailability] = useState('all'); const [filtersOpen, setFiltersOpen] = useState(false)
  const save = async (formData, images) => { const files = images.filter((image) => image.type === 'file').map((image) => image.file); const linkedImages = images.filter((image) => image.type === 'url').map((image) => image.url); const uploadedImages = []; for (const file of files) { const path = `${restaurantId}/${crypto.randomUUID()}-${file.name.replaceAll(' ', '-')}`; const { error: uploadError } = await supabase.storage.from(menuImageBucket).upload(path, file, { upsert: false }); if (uploadError) return notify(uploadError.message, 'error'); uploadedImages.push(supabase.storage.from(menuImageBucket).getPublicUrl(path).data.publicUrl) } const imageUrls = [...linkedImages, ...uploadedImages]; const record = { restaurant_id: restaurantId, category_id: formData.get('category') || null, name: formData.get('name').trim(), description: formData.get('description').trim() || null, price: Number(formData.get('price')), image_url: imageUrls[0] || null, image_urls: imageUrls, is_available: formData.get('available') === 'on' }; const result = editing?.id ? await supabase.from('menu_items').update(record).eq('id', editing.id) : await supabase.from('menu_items').insert(record); if (result.error) return notify(result.error.message, 'error'); setEditing(null); reload(); notify(editing?.id ? 'Menu item updated.' : 'Menu item added.') }
  const toggle = async (row) => { const { error: updateError } = await supabase.from('menu_items').update({ is_available: !row.is_available }).eq('id', row.id); if (updateError) alert(updateError.message); else reload() }
  const remove = async (row) => { if (confirm(`Delete ${row.name}?`)) { const { error: deleteError } = await supabase.from('menu_items').delete().eq('id', row.id); if (deleteError) alert(deleteError.message); else reload() } }
  const visibleItems = items.filter((row) => (!categoryFilter || row.category_id === categoryFilter) && (!minPrice || Number(row.price) >= Number(minPrice)) && (!maxPrice || Number(row.price) <= Number(maxPrice)) && (availability === 'all' || (availability === 'available' && row.is_available) || (availability === 'sold-out' && !row.is_available)) && `${row.name} ${row.description || ''}`.toLowerCase().includes(query.toLowerCase()))
  const resetFilters = () => { setCategoryFilter(''); setMinPrice(''); setMaxPrice(''); setAvailability('all') }
  if (loading || categoriesLoading) return <PageLoader label="Loading menu" />
  return <><Header kicker={`${items.length} MENU ITEMS`} title="Menu management" action="Add item" onAction={() => setEditing({})} />{error && <div className="login-error">{error}</div>}<div className="content-toolbar"><label className="toolbar-search"><Search size={16} strokeWidth={1.9} aria-hidden="true" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search food items" /></label><button className="admin-secondary" onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={15} strokeWidth={1.9} aria-hidden="true" />Filters</button></div><p className="result-summary">Showing {visibleItems.length} of {items.length} menu items</p>{filtersOpen && <div className="filter-backdrop" onClick={() => setFiltersOpen(false)}><aside className="filter-drawer" onClick={(e) => e.stopPropagation()}><header><div><span className="admin-kicker">MENU FILTERS</span><h2>Refine menu</h2></div><button onClick={() => setFiltersOpen(false)} aria-label="Close filters"><X size={18} strokeWidth={1.9} aria-hidden="true" /></button></header><Field label="Category"><select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)}><option value="">All categories</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></Field><div className="price-range"><Field label="Minimum price"><input value={minPrice} onChange={(e) => setMinPrice(e.target.value)} type="number" min="0" placeholder="0" /></Field><Field label="Maximum price"><input value={maxPrice} onChange={(e) => setMaxPrice(e.target.value)} type="number" min="0" placeholder="No limit" /></Field></div><Field label="Availability"><select value={availability} onChange={(e) => setAvailability(e.target.value)}><option value="all">All items</option><option value="available">Available</option><option value="sold-out">Sold out</option></select></Field><footer><button className="admin-secondary" onClick={resetFilters}>Reset</button><button className="admin-primary" onClick={() => setFiltersOpen(false)}>Apply filters</button></footer></aside></div>}{/* A first-run empty grid and a filtered-to-nothing grid are different
      situations and read differently: one needs an invitation, the other needs a
      way back. */}
{items.length === 0 ? <div className="empty-collection"><span><UtensilsCrossed size={26} strokeWidth={1.6} aria-hidden="true" /></span><h2>Your menu is empty</h2><p>Add a dish with a name, price and photo — guests see it the moment you save it.</p><button className="admin-primary" onClick={() => setEditing({})}><Plus size={15} strokeWidth={2.2} aria-hidden="true" />Add your first item</button></div> : !visibleItems.length ? <div className="empty-collection"><span><SlidersHorizontal size={26} strokeWidth={1.6} aria-hidden="true" /></span><h2>No items match these filters</h2><p>Try a different search, category or price range.</p><button className="admin-secondary" onClick={resetFilters}>Clear all filters</button></div> : <div className="admin-menu-grid">{visibleItems.map((row) => <article className={`admin-dish ${row.is_available ? '' : 'unavailable'}`} key={row.id}>{row.image_url && <img src={row.image_url} alt="" loading="lazy" decoding="async" />}<div><h3>{row.name}</h3><p>{row.description}</p><footer><strong>{formatMoney(row.price)}</strong><button className={row.is_available ? 'toggle on' : 'toggle'} onClick={() => toggle(row)}><span />{row.is_available ? 'Available' : 'Sold out'}</button><button className="admin-secondary" onClick={() => setEditing(row)}><Pencil size={14} strokeWidth={2} aria-hidden="true" />Edit</button><button className="admin-secondary" onClick={() => remove(row)}><Trash2 size={14} strokeWidth={2} aria-hidden="true" />Delete</button></footer></div></article>)}</div>}{editing && <Modal title={editing.id ? 'Edit menu item' : 'Add menu item'} close={() => setEditing(null)}><MenuItemForm editing={editing} categories={categories} onSave={save} /></Modal>}</>
}


function offerStatus(offer) { const now = Date.now(); if (!offer.is_active) return 'Off'; if (offer.end_at && new Date(offer.end_at).getTime() <= now) return 'Ended'; if (offer.start_at && new Date(offer.start_at).getTime() > now) return 'Scheduled'; return 'Live' }
function OfferCollage({ images = [], title, className = '' }) { const photos = images.filter(Boolean).slice(0, 4); return <div className={`offer-collage ${className} count-${Math.max(photos.length, 1)}`}>{photos.length ? photos.map((src, index) => <img key={`${src}-${index}`} src={src} alt={`${title} ${index + 1}`} loading="lazy" decoding="async" />) : <span><Sparkles size={26} strokeWidth={1.6} aria-hidden="true" /></span>}</div> }
function OfferForm({ editing, menuItems, onSave }) {
  const initialIds = editing?.items?.map((item) => item.menu_item_id || item.id) || []
  const initialImages = editing?.image_urls?.length ? editing.image_urls : editing?.image_url ? [editing.image_url] : []
  const [type, setType] = useState(editing?.type || 'auto'); const [selectedIds, setSelectedIds] = useState(initialIds); const [title, setTitle] = useState(editing?.title || ''); const [titleEdited, setTitleEdited] = useState(Boolean(editing?.id)); const [images, setImages] = useState(() => initialImages.map((url) => ({ id: crypto.randomUUID(), type: 'url', url, preview: url }))); const [imageLink, setImageLink] = useState('')
  const selectedItems = menuItems.filter((item) => selectedIds.includes(item.id)); const generatedTitle = selectedItems.map((item) => item.name).join(' + ')
  const chooseItem = (id) => { const next = selectedIds.includes(id) ? selectedIds.filter((itemId) => itemId !== id) : [...selectedIds, id]; setSelectedIds(next); if (!titleEdited) setTitle(menuItems.filter((item) => next.includes(item.id)).map((item) => item.name).join(' + ')) }
  const addFiles = (event) => { const files = Array.from(event.target.files || []); const invalid = files.find((file) => file.size > 5242880); if (invalid) return notify('Each image must be 5 MB or smaller.', 'error'); setImages((current) => [...current, ...files.map((file) => ({ id: crypto.randomUUID(), type: 'file', file, preview: URL.createObjectURL(file) }))]); event.target.value = '' }
  const addLink = () => { const url = imageLink.trim(); if (!url) return; try { new URL(url) } catch { notify('Enter a complete public image URL.', 'error'); return }; setImages((current) => [...current, { id: crypto.randomUUID(), type: 'url', url, preview: url }]); setImageLink('') }
  const collageImages = selectedItems.flatMap((item) => item.image_urls?.length ? item.image_urls.slice(0, 1) : item.image_url ? [item.image_url] : [])
  return <form className="offer-form" onSubmit={(event) => { event.preventDefault(); if (type === 'auto' && selectedIds.length < 2) return notify('Select at least two menu items for a bundle.', 'error'); onSave(new FormData(event.currentTarget), { type, selectedIds, images }) }}><div className="offer-type-tabs"><button type="button" className={type === 'auto' ? 'active' : ''} onClick={() => setType('auto')}><b><Sparkles size={14} strokeWidth={2} aria-hidden="true" /> Smart bundle</b><span>Build from menu items</span></button><button type="button" className={type === 'manual' ? 'active' : ''} onClick={() => setType('manual')}><b><BadgePercent size={14} strokeWidth={2} aria-hidden="true" /> Manual offer</b><span>Create your own promotion</span></button></div><input type="hidden" name="type" value={type} />{type === 'auto' && <section className="bundle-builder"><div className="bundle-builder-head"><div><strong>Choose bundle items</strong><small>Select two or more dishes. The title and visual update instantly.</small></div><span>{selectedItems.length} selected</span></div><div className="bundle-item-list">{menuItems.map((item) => <button type="button" className={selectedIds.includes(item.id) ? 'selected' : ''} key={item.id} onClick={() => chooseItem(item.id)}><span>{selectedIds.includes(item.id) ? <Check size={12} strokeWidth={3} aria-hidden="true" /> : <Plus size={12} strokeWidth={2.6} aria-hidden="true" />}</span>{item.image_url ? <img src={item.image_url} alt="" /> : <i><UtensilsCrossed size={15} strokeWidth={1.8} aria-hidden="true" /></i>}<div><b>{item.name}</b><small>{formatMoney(item.price)}</small></div></button>)}</div>{selectedItems.length > 0 && <div className="bundle-preview"><OfferCollage images={collageImages} title={title || generatedTitle} /><div><span>AUTOMATIC BUNDLE</span><strong>{generatedTitle || 'Select menu items'}</strong><small>Change the title below if you want a custom name.</small></div></div>}</section>}<div className="offer-form-grid"><Field label="Offer title"><input name="title" required value={title} onChange={(event) => { setTitle(event.target.value); setTitleEdited(true) }} placeholder={type === 'auto' ? 'Generated from selected items' : 'e.g. Weekend special'} /></Field><Field label={`Bundle price (${CURRENCY})`}><input name="price" required type="number" min="0" step="0.01" defaultValue={editing?.price || ''} placeholder="e.g. 200" /></Field><Field label="Starts on"><input name="start_at" type="datetime-local" defaultValue={editing?.start_at ? new Date(editing.start_at).toISOString().slice(0, 16) : ''} /></Field><Field label="Ends on"><input name="end_at" type="datetime-local" defaultValue={editing?.end_at ? new Date(editing.end_at).toISOString().slice(0, 16) : ''} /></Field><Field label="Offer is active"><input name="is_active" type="checkbox" defaultChecked={editing?.is_active ?? true} /></Field><Field label="Description"><textarea name="description" defaultValue={editing?.description || ''} placeholder="Tell guests why this offer is special" /></Field></div>{type === 'manual' && <section className="image-manager"><div className="image-manager-head"><div><strong>Offer images</strong><small>Add dedicated promotion photos from your device or public links.</small></div><span>{images.length} image{images.length === 1 ? '' : 's'}</span></div><div className="image-actions"><label className="image-upload-button"><Upload size={14} strokeWidth={2} aria-hidden="true" />Upload images<input type="file" multiple accept="image/jpeg,image/png,image/webp,image/gif" onChange={addFiles} /></label><div className="image-link-add"><input value={imageLink} onChange={(event) => setImageLink(event.target.value)} placeholder="Paste image URL" /><button type="button" onClick={addLink}>Add link</button></div></div>{images.length > 0 && <div className="image-preview-grid">{images.map((image, index) => <article key={image.id}><img src={image.preview} alt="" /><span>{index === 0 ? 'Cover image' : `Image ${index + 1}`}</span><button type="button" onClick={() => setImages((current) => current.filter((item) => item.id !== image.id))} aria-label="Remove image"><X size={13} strokeWidth={2.4} aria-hidden="true" /></button></article>)}</div>}</section>}<button className="admin-primary">{editing?.id ? 'Save offer changes' : 'Create offer'}</button></form>
}
function Offers({ restaurantId }) {
  const { data: menuItems, loading: menuLoading } = useData('menu_items', restaurantId); const [offers, setOffers] = useState([]); const [loading, setLoading] = useState(true); const [editing, setEditing] = useState(null); const [query, setQuery] = useState(''); const [status, setStatus] = useState('all')
  const reload = async () => { setLoading(true); const { data, error } = await supabase.from('offers').select('*, offer_items(menu_item_id, display_order, menu_items(id, name, image_url, image_urls))').eq('restaurant_id', restaurantId).order('display_order'); if (error) notify(error.message, 'error'); else setOffers((data || []).map((offer) => ({ ...offer, items: (offer.offer_items || []).sort((a, b) => a.display_order - b.display_order).map((link) => ({ ...link.menu_items, menu_item_id: link.menu_item_id })) }))); setLoading(false) }
  useEffect(() => { supabase.from('offers').select('*, offer_items(menu_item_id, display_order, menu_items(id, name, image_url, image_urls))').eq('restaurant_id', restaurantId).order('display_order').then(({ data, error }) => { if (error) notify(error.message, 'error'); else setOffers((data || []).map((offer) => ({ ...offer, items: (offer.offer_items || []).sort((a, b) => a.display_order - b.display_order).map((link) => ({ ...link.menu_items, menu_item_id: link.menu_item_id })) }))); setLoading(false) }) }, [restaurantId])
  const save = async (form, values) => { const files = values.images.filter((image) => image.type === 'file').map((image) => image.file); const links = values.images.filter((image) => image.type === 'url').map((image) => image.url); const uploaded = []; for (const file of files) { const path = `${restaurantId}/${crypto.randomUUID()}-${file.name.replaceAll(' ', '-')}`; const { error } = await supabase.storage.from(menuImageBucket).upload(path, file); if (error) return notify(error.message, 'error'); uploaded.push(supabase.storage.from(menuImageBucket).getPublicUrl(path).data.publicUrl) }; const imageUrls = [...links, ...uploaded]; const startAt = form.get('start_at'); const endAt = form.get('end_at'); if (startAt && endAt && new Date(endAt) <= new Date(startAt)) return notify('The end date must be after the start date.', 'error'); const record = { restaurant_id: restaurantId, type: values.type, title: form.get('title').trim(), description: form.get('description').trim() || null, price: Number(form.get('price')), image_url: values.type === 'manual' ? imageUrls[0] || null : null, image_urls: values.type === 'manual' ? imageUrls : [], start_at: startAt ? new Date(startAt).toISOString() : null, end_at: endAt ? new Date(endAt).toISOString() : null, is_active: form.get('is_active') === 'on', display_order: editing?.display_order ?? offers.length }; const result = editing?.id ? await supabase.from('offers').update(record).eq('id', editing.id).select('id').single() : await supabase.from('offers').insert(record).select('id').single(); if (result.error) return notify(result.error.message, 'error'); const offerId = result.data.id; const { error: clearError } = await supabase.from('offer_items').delete().eq('offer_id', offerId); if (clearError) return notify(clearError.message, 'error'); if (values.type === 'auto' && values.selectedIds.length) { const { error } = await supabase.from('offer_items').insert(values.selectedIds.map((menu_item_id, display_order) => ({ offer_id: offerId, menu_item_id, display_order }))); if (error) return notify(error.message, 'error') }; setEditing(null); reload(); notify(editing?.id ? 'Offer updated.' : 'Offer created.') }
  const toggle = async (offer) => { const { error } = await supabase.from('offers').update({ is_active: !offer.is_active }).eq('id', offer.id); if (error) notify(error.message, 'error'); else { reload(); notify(offer.is_active ? 'Offer turned off.' : 'Offer activated.') } }
  const remove = async (offer) => { if (!confirm(`Delete ${offer.title}?`)) return; const { error } = await supabase.from('offers').delete().eq('id', offer.id); if (error) notify(error.message, 'error'); else { reload(); notify('Offer deleted.') } }
  const visible = offers.filter((offer) => (status === 'all' || offerStatus(offer).toLowerCase() === status) && `${offer.title} ${offer.description || ''}`.toLowerCase().includes(query.toLowerCase()))
  if (loading || menuLoading) return <PageLoader label="Loading offers" />
  return <><Header kicker={`${offers.length} PROMOTIONS`} title="Offer management" action="Create offer" onAction={() => setEditing({})} /><section className="offers-intro"><div><span>SMART PROMOTIONS</span><strong>Bundle menu favourites or launch a custom deal.</strong></div><p>Guests only see active offers. Scheduled and ended offers are clearly labelled.</p></section><div className="qr-toolbar"><label className="toolbar-search"><Search size={16} strokeWidth={1.9} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search offers" /></label><select value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">All offers</option><option value="live">Live</option><option value="scheduled">Scheduled</option><option value="ended">Ended</option><option value="off">Off</option></select></div>{visible.length ? <div className="offers-admin-grid">{visible.map((offer) => { const images = offer.type === 'auto' ? offer.items.flatMap((item) => item.image_urls?.slice(0, 1) || (item.image_url ? [item.image_url] : [])) : (offer.image_urls?.length ? offer.image_urls : [offer.image_url]); return <article className={`admin-offer-card ${offerStatus(offer).toLowerCase()}`} key={offer.id}><OfferCollage images={images} title={offer.title} /><div className="admin-offer-body"><header><span className={`offer-state ${offerStatus(offer).toLowerCase()}`}>{offerStatus(offer)}</span><span>{offer.type === 'auto' ? 'Smart bundle' : 'Manual offer'}</span></header><h3>{offer.title}</h3><p>{offer.description || 'A special offer for your guests.'}</p><strong>{formatMoney(offer.price)}</strong><small>{offer.end_at ? `Ends ${new Date(offer.end_at).toLocaleDateString()}` : 'No end date'}</small><footer><button className={offer.is_active ? 'toggle on' : 'toggle'} onClick={() => toggle(offer)}><span />{offer.is_active ? 'On' : 'Off'}</button><button className="admin-secondary" onClick={() => setEditing(offer)}><Pencil size={14} strokeWidth={2} aria-hidden="true" />Edit</button><button className="danger-button" onClick={() => remove(offer)}><Trash2 size={14} strokeWidth={2} aria-hidden="true" />Delete</button></footer></div></article> })}</div> : <div className="empty-collection"><span><Sparkles size={26} strokeWidth={1.6} aria-hidden="true" /></span><h2>{offers.length ? 'No offers match these filters' : 'Create your first offer'}</h2><p>Bundle popular menu items or make a custom deal for your guests.</p><button className="admin-primary" onClick={() => setEditing({})}>Create offer</button></div>}{editing && <Modal title={editing.id ? 'Edit offer' : 'Create offer'} close={() => setEditing(null)}><OfferForm editing={editing} menuItems={menuItems} onSave={save} /></Modal>}</>
}

function QR({ restaurantId }) {
  const { data, loading, reload } = useData('qr_tokens', restaurantId, 'created_at'); const [table, setTable] = useState(''); const [expiry, setExpiry] = useState(''); const [query, setQuery] = useState(''); const [status, setStatus] = useState('all'); const [createOpen, setCreateOpen] = useState(false)
  const create = async (e) => { e.preventDefault(); const { error } = await supabase.from('qr_tokens').insert({ restaurant_id: restaurantId, table_number: table.trim(), expires_at: expiry ? new Date(expiry).toISOString() : null }); if (error) return notify(`Could not create QR code: ${error.message}`, 'error'); setTable(''); setExpiry(''); setCreateOpen(false); reload(); notify('QR code created successfully.') }
  const now = new Date(); const isExpired = (row) => row.expires_at && new Date(row.expires_at) <= now; const visible = data.filter((row) => (status === 'all' || (status === 'active' ? row.is_active && !isExpired(row) : status === 'inactive' ? !row.is_active : isExpired(row))) && `${row.table_number} ${row.token}`.toLowerCase().includes(query.toLowerCase())); const activeCount = data.filter((row) => row.is_active && !isExpired(row)).length
  if (loading) return <PageLoader label="Loading table QR codes" />
  return <><Header kicker="TABLE ACCESS" title="QR code management" action="Create QR" onAction={() => setCreateOpen(true)} /><section className="qr-overview"><div><strong>{activeCount}</strong><span>Active QR codes</span></div><p>Each table QR is permanent unless you deactivate, delete, regenerate, or give it an expiry time.</p></section><div className="qr-toolbar"><label className="toolbar-search"><Search size={16} strokeWidth={1.9} aria-hidden="true" /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search table name or QR token" /></label><select value={status} onChange={(e) => setStatus(e.target.value)}><option value="all">All status</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="expired">Expired</option></select></div>{visible.length ? <div className="qr-grid">{visible.map((row) => <QRCard key={row.id} row={row} reload={reload} />)}</div> : <div className="empty-collection"><span><QrCode size={26} strokeWidth={1.6} aria-hidden="true" /></span><h2>{data.length ? 'No QR codes match these filters' : 'Create your first table QR'}</h2><p>{data.length ? 'Try a different table name or status.' : 'Create one QR code per table, then download or print it.'}</p>{!data.length && <button className="admin-primary" onClick={() => setCreateOpen(true)}>Create table QR</button>}</div>}{createOpen && <Modal title="Create table QR" close={() => setCreateOpen(false)}><form className="admin-form-grid" onSubmit={create}><Field label="Table name"><input required value={table} onChange={(e) => setTable(e.target.value)} placeholder="e.g. Table 3" /></Field><Field label="QR expiry (optional)"><input value={expiry} onChange={(e) => setExpiry(e.target.value)} type="datetime-local" /><small>Leave blank to keep this QR permanent.</small></Field><button className="admin-primary">Generate QR code</button></form></Modal>}</>
}
function QRCard({ row, reload }) {
  const [url, setUrl] = useState(''); const link = scanLink(row.token)
  useEffect(() => { QRCode.toDataURL(link, { width: 360, margin: 2 }).then(setUrl) }, [link])
  const update = async (values, successMessage) => { const { error } = await supabase.from('qr_tokens').update(values).eq('id', row.id); if (error) notify(error.message, 'error'); else { reload(); notify(successMessage) } }
  const regenerate = () => { if (confirm(`Generate a new QR link for ${row.table_number}? The old QR will stop working.`)) update({ token: crypto.randomUUID().replaceAll('-', '') }, 'New QR link generated. The old link no longer works.') }
  const remove = () => { if (confirm(`Delete QR code for ${row.table_number}?`)) supabase.from('qr_tokens').delete().eq('id', row.id).then(({ error }) => { if (error) notify(error.message, 'error'); else { reload(); notify('QR code deleted.') } }) }
  const copy = async () => { try { await navigator.clipboard.writeText(link); notify('QR link copied to clipboard.') } catch { notify('Could not copy the QR link.', 'error') } }
  return <article className="qr-card"><header className="qr-card-head"><div><span className={row.is_active ? 'qr-state active' : 'qr-state'}>{row.is_active ? 'Active' : 'Inactive'}</span><h3>{row.table_number}</h3></div><button className="danger-button" onClick={remove}><Trash2 size={14} strokeWidth={2} aria-hidden="true" />Delete</button></header><div className="qr-preview">{url ? <img src={url} alt={`QR code for ${row.table_number}`} /> : <span className="qr-preview-loader" />}</div><div className="qr-token"><span>TABLE QR TOKEN</span><code title={row.token}>{row.token}</code></div><div className="qr-primary-action"><button onClick={copy}><Copy size={15} strokeWidth={2} aria-hidden="true" />Copy QR link</button></div><div className="qr-secondary-actions"><a href={url} download={`${row.table_number}-qr.png`}><Download size={15} strokeWidth={2} aria-hidden="true" />Download</a><button onClick={regenerate}><RefreshCw size={15} strokeWidth={2} aria-hidden="true" />Regenerate</button><button onClick={() => update({ is_active: !row.is_active }, row.is_active ? 'QR code deactivated.' : 'QR code activated.')}>{row.is_active ? 'Pause access' : 'Activate access'}</button></div></article>
}


// The action button carries the icon of what it does — a plus for "add". A
// header that always drew a plus, even beside "Export CSV", was telling the eye
// one thing and the label another.
function Header({ kicker, title, action, onAction, actionIcon: ActionIcon = Plus }) { return <div className="admin-heading"><div><span className="admin-kicker">{kicker}</span><h1>{title}</h1></div>{action && <button className="admin-primary" onClick={onAction}><ActionIcon size={16} strokeWidth={2.2} aria-hidden="true" />{action}</button>}</div> }

// Dollars everywhere: a plan price, an invoice, and the menu a guest reads all
// show the same currency. There is no code to pass in, so there is none to get
// wrong.
const formatMoney = (amount, currency = CURRENCY) => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(Number(amount || 0))
const formatDate = (date) => date ? new Date(date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not available'
// The card a restaurant pays with, named the way people name it. Only the brand and
// the last four digits ever reach this application — Safepay hands out nothing more,
// which is the point of entering the card on Safepay's own checkout page instead of here.
const CARD_BRANDS = { visa: 'Visa', mastercard: 'Mastercard', amex: 'American Express', discover: 'Discover', diners: 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay', maestro: 'Maestro', eftpos_australia: 'EFTPOS' }
const cardBrandName = (brand) => CARD_BRANDS[String(brand || '').toLowerCase()] || (brand ? `${String(brand)[0].toUpperCase()}${String(brand).slice(1)}` : 'Card')
const walletName = (wallet) => ({ apple_pay: 'Apple Pay', google_pay: 'Google Pay', link: 'Link' }[String(wallet || '').toLowerCase()] || 'Digital wallet')
const cardExpiry = (card) => card?.expMonth ? `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear || '').slice(-2)}` : ''
const daysUntil = (date) => date ? Math.max(0, Math.ceil((new Date(date).getTime() - Date.now()) / 86400000)) : null
const relativeTime = (date) => { const minutes = Math.max(0, Math.floor((Date.now() - new Date(date).getTime()) / 60000)); if (minutes < 1) return 'Just now'; if (minutes < 60) return `${minutes}m ago`; const hours = Math.floor(minutes / 60); if (hours < 24) return `${hours}h ago`; return `${Math.floor(hours / 24)}d ago` }

function SubscriptionBanner({ subscription, openPage }) { const [dismissed, setDismissed] = useState(false); if (!subscription || dismissed) return null; const days = daysUntil(subscription.status === 'trialing' ? subscription.trial_end : subscription.current_period_end); const state = subscription.status === 'trialing' && days !== null && days <= 3 ? 'trial' : subscription.status === 'past_due' ? 'past-due' : subscription.status === 'suspended' || subscription.status === 'canceled' ? 'suspended' : null; if (!state) return null; const text = state === 'trial' ? `Your trial ends in ${days} day${days === 1 ? '' : 's'}. Subscribe now to continue.` : state === 'past-due' ? 'Payment failed. Update your payment method to avoid interruption.' : 'Your subscription requires renewal. Your menu is currently offline.'; return <aside className={`subscription-banner ${state}`}><span>{state === 'trial' ? <Info size={14} strokeWidth={2.2} aria-hidden="true" /> : <TriangleAlert size={14} strokeWidth={2.2} aria-hidden="true" />}</span><p>{text}</p><button onClick={() => openPage('subscription')}>{state === 'trial' ? 'Subscribe' : 'Renew now'}</button><button className="banner-close" aria-label="Dismiss subscription notice" onClick={() => setDismissed(true)}><X size={15} strokeWidth={2} aria-hidden="true" /></button></aside> }

function NotificationBell({ notifications, onOpen, openPage }) { const unread = notifications.filter((item) => !item.is_read).length; const [open, setOpen] = useState(false); const [soundOn, setSoundOn] = useState(isNotificationSoundEnabled); const latest = notifications.slice(0, 5); const go = () => { setOpen(false); openPage('notifications') }; const toggleSound = () => setSoundOn(setNotificationSoundEnabled(!soundOn)); return <div className="notification-control"><button className={`notification-bell ${unread ? 'has-unread' : ''}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}><Bell size={18} strokeWidth={1.8} aria-hidden="true" />{unread > 0 && <b>{unread > 99 ? '99+' : unread}</b>}</button>{open && <section className="notification-popover"><header><strong>Notifications</strong><div className="notification-actions"><button onClick={toggleSound} className={soundOn ? undefined : 'muted'} aria-pressed={soundOn} title={soundOn ? 'Mute the notification sound' : 'Unmute the notification sound'}>{soundOn ? 'Sound on' : 'Sound off'}</button><button onClick={go}>View all</button></div></header>{latest.length ? latest.map((item) => <button className={!item.is_read ? 'unread' : ''} key={item.id} onClick={() => { onOpen(item); go() }}><b>{item.title}</b><span>{item.message}</span><small>{relativeTime(item.created_at)}</small></button>) : <p>No notifications yet.</p>}</section>}</div> }

// Safepay calls made from the restaurant's own panel. The session token is what
// the server uses to decide which restaurant this caller may touch — no
// restaurant id is sent from here, so the browser cannot ask for another
// restaurant's billing.
const postBilling = async (path, body = {}) => {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) throw new Error('Your session expired. Please sign in again.')
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.access_token}` },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(payload.error || 'The billing service could not be reached.')
    // "You already have a subscription" is not a failure to report and forget: the
    // server has just refreshed the subscription Safepay already holds, so the
    // only thing left for this screen to do is read it back.
    error.alreadySubscribed = Boolean(payload.alreadySubscribed)
    throw error
  }
  // An endpoint that answers with an empty or literal `null` body is still an
  // answer; handing that back as-is would make every caller check it.
  return payload && typeof payload === 'object' ? payload : {}
}

/**
 * The one place a restaurant starts, stops, or repairs its own subscription.
 * Checkout is Safepay's own hosted page, so no card detail is entered into this
 * app; the resulting state is written by the Safepay webhook, never by this
 * screen.
 */
function BillingActions({ subscription, primaryLabel, refresh }) {
  const [plans, setPlans] = useState([])
  const [pickedId, setPickedId] = useState('')
  const [card, setCard] = useState(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!supabase) return
    // Read through an RPC rather than the table. RLS on `subscription_plans`
    // scopes a restaurant to its own plan — correct for reading the one you are
    // on, useless for choosing one — so the catalogue comes from a function that
    // returns exactly the fields a buyer needs.
    supabase.rpc('public_plans').then(({ data }) => setPlans((Array.isArray(data) ? data : [])
      // Only plans Safepay can actually bill: a plan whose Safepay half is missing
      // fails at checkout, so it must not be offered before a card is typed.
      .filter((plan) => resolvePlanPrice(plan, CURRENCY) && plan.billable_pkr !== false)))
  }, [])

  // The card the last payment was made with, read from this restaurant's own
  // payment history. Safepay never hands a saved card to a browser — the card
  // lives on their side, and the row here holds only the brand and last four
  // digits the webhook recorded — so this asks the platform's own table rather
  // than inventing a card detail the provider would not give out. A payment that
  // carried no card detail shows no card at all, rather than claiming one is on
  // file when nothing recorded it.
  const restaurantId = subscription?.restaurant_id
  useEffect(() => {
    if (!supabase || !restaurantId) return undefined
    let active = true
    supabase
      .from('payment_transactions')
      .select('card_brand, card_last4, created_at')
      .eq('restaurant_id', restaurantId)
      .order('created_at', { ascending: false })
      .limit(5)
      .then(({ data }) => {
        if (!active) return
        const recorded = (data || []).find((row) => row.card_last4)
        setCard(recorded ? { brand: recorded.card_brand, last4: recorded.card_last4, from: 'last_payment' } : null)
      })
    return () => { active = false }
  }, [restaurantId])

  // The plan they are already on is pre-selected, but only when it is one of the
  // plans on offer — a withdrawn or custom plan is not in this list, and naming a
  // plan that cannot be chosen is how a subscribe button ends up doing nothing.
  // Nothing selected means the button stays disabled until they pick one.
  const ownsPlan = plans.some((plan) => plan.id === subscription?.plan_id)
  const planId = pickedId || (ownsPlan ? subscription.plan_id : '')
  const chosen = plans.find((plan) => plan.id === planId) || null
  const priced = chosen ? resolvePlanPrice(chosen, CURRENCY) : null
  // Whether the platform is billing this restaurant at all: a running subscription is
  // what has a renewal to stop. A card on file alone is not a subscription — it is
  // just a card waiting to be charged when a period starts.
  const hasSubscription = ['active', 'trialing', 'past_due'].includes(subscription?.status)
  const cardOnFile = Boolean(subscription?.card_last4)
  const savedCard = cardOnFile ? { brand: subscription.card_brand, last4: subscription.card_last4, expMonth: subscription.card_exp_month, expYear: subscription.card_exp_year, from: 'on_file' } : card
  // How a plan's price is spoken: "Rs 2,000 per month", "Rs 69,232 per year". A
  // custom plan is priced in days, which is why the count is read rather than assumed.
  const cadence = (plan) => plan.interval === 'year' ? 'year' : plan.interval === 'day' ? `${plan.interval_count || 1} days` : 'month'
  // A trial is offered once per restaurant, so the promise is only made when it
  // is still available rather than every time a plan is picked.
  const trialOffered = (plan) => Number(plan?.trial_days) > 0 && !subscription?.trial_used_at && !subscription?.trial_start
  // "Active" means Safepay has taken a payment for this period, so the only
  // remaining job is managing the card. Every other status means the job is to
  // get through checkout — which is *not* the same question as whether a Safepay
  // subscription exists: the checkout records a pending subscription as soon as
  // it is opened, so an abandoned attempt must not leave this screen hiding the
  // Subscribe button and offering only a renewal toggle.
  const active = subscription?.status === 'active'

  const open = async (path, body) => {
    setBusy(path); setError('')
    try {
      const result = await postBilling(path, body)
      window.location.assign(result.url)
    } catch (requestError) {
      setError(requestError.message); setBusy('')
      // The subscription this restaurant already paid for has just been restored
      // server-side, so pick it up rather than leaving them on a stale screen.
      if (requestError.alreadySubscribed) refresh?.()
    }
  }

  const start = () => open('/api/safepay/checkout', { planId })

  // Adding a card is its own page and its own session: a zero-amount verification on
  // Safepay that stores the card for future renewals. It takes no money, which is why
  // it is a separate button from paying for a period.
  const addCard = () => open('/api/safepay/card', {})

  // Stopping is a call, not a page: Safepay publishes no billing portal. The period
  // already paid for runs to its end and the card is not charged again, which is
  // exactly what the confirmation says.
  const stop = async () => {
    const until = subscription?.current_period_end || subscription?.trial_end
    if (!window.confirm(`Stop renewing your subscription? Your menu stays online until ${until ? formatDate(until) : 'the end of the paid period'}, then it stops and nothing more is charged.`)) return
    setBusy('cancel'); setError('')
    try {
      const result = await postBilling('/api/safepay/manage', { action: 'cancel' })
      notify(result.atPeriodEnd
        ? `Renewal stopped. Your menu stays online until ${result.endsAt ? formatDate(result.endsAt) : 'the end of the paid period'}.`
        : 'Subscription cancelled. Nothing more will be charged.')
      await refresh?.()
    } catch (requestError) {
      setError(requestError.message)
    }
    setBusy('')
  }

  // A webhook normally brings the truth; this is the repair path when one was
  // missed, and the only path at all on a laptop, where no webhook can arrive.
  const refreshStatus = async () => {
    setBusy('sync'); setError('')
    try { await postBilling('/api/safepay/sync', {}) } catch (requestError) { setError(requestError.message) }
    await refresh?.()
    setBusy('')
  }

  return <section className="billing-actions">
    <div className="billing-actions-head">
      <span className="settings-icon"><CreditCard size={18} strokeWidth={1.9} aria-hidden="true" /></span>
      <div>
        <div className="billing-title">
          <h2>{cardOnFile ? 'Your billing method' : 'Add a billing method'}</h2>
        </div>
        <p>{cardOnFile
          ? 'Your card is saved with Safepay, which charges it when each period starts. No Safepay account is needed — the card is stored against your restaurant.'
          : 'Pick a plan, then save your card on Safepay’s secure page — no Safepay account is needed, and the card is stored against your restaurant. The period is charged automatically the moment the card is confirmed there.'}
      </p>
      </div>
    </div>

    {savedCard && <section className="billing-card-on-file">
      <CardBrand brand={savedCard.brand} label={cardBrandName(savedCard.brand)} />
      <div className="billing-card-number">
        <strong>•••• •••• •••• {savedCard.last4}</strong>
        <small>
          {savedCard.name ? `${savedCard.name} · ` : ''}
          {cardExpiry(savedCard) ? `expires ${cardExpiry(savedCard)}` : 'card on record with Safepay'}
          {savedCard.wallet ? ` · ${walletName(savedCard.wallet)}` : ''}
        </small>
      </div>
      <span className="billing-card-state">{cardOnFile ? 'On file' : 'Last used'}</span>
    </section>}

    {card && !cardOnFile && <p className="payment-note">This is the card that paid your last invoice. Save it on Safepay’s page to have the next period charged automatically — otherwise you will pay each time it starts.</p>}

    {!active && plans.length > 0 && <fieldset className="billing-plans">
      <legend>Choose a plan</legend>
      <div className="billing-plan-list" role="radiogroup" aria-label="Choose a plan">
        {plans.map((plan) => { const price = resolvePlanPrice(plan, CURRENCY); const selected = plan.id === planId; return <button
          type="button"
          key={plan.id}
          role="radio"
          aria-checked={selected}
          className={`billing-plan${selected ? ' is-selected' : ''}`}
          onClick={() => setPickedId(plan.id)}
        >
          <span className="billing-plan-tick" aria-hidden="true">{selected ? <Check size={13} strokeWidth={3} /> : null}</span>
          <span className="billing-plan-copy">
            <strong>{plan.name}{subscription?.plan_id === plan.id ? ' · current plan' : ''}</strong>
            <small>
              {formatMoney(price.amount)} per {cadence(plan)}
              {trialOffered(plan) ? ` · ${plan.trial_days}-day free trial` : ''}
              {plan.duration_days ? ` · ${plan.duration_days} days` : ''}
            </small>
          </span>
          <span className="billing-plan-price">
            <strong>{formatMoney(price.amount)}</strong>
            <small>per {cadence(plan)}</small>
          </span>
        </button> })}
      </div>
    </fieldset>}

    {/* The quote is about a charge that has not happened yet, so it belongs with
        the plan picker. On a subscription that is already paid up it contradicted
        the note below it, which correctly says this period is covered. */}
    {priced && !active && <p className="billing-quote">
      {trialOffered(chosen)
        ? <>{chosen.name} starts with <strong>{chosen.trial_days} days free</strong> — the first charge is {formatMoney(priced.amount)} when the trial ends.</>
        : <>{chosen.name} · <strong>{formatMoney(priced.amount)}</strong> every {cadence(chosen)}, charged right after your card is saved on Safepay.</>}
    </p>}

    {plans.length === 0 && !active && <p className="payment-note">No published plan is priced and linked with Safepay yet. The platform team needs to save a plan price before you can subscribe from here.</p>}

    {active && <p className="payment-note">Your last payment is on record and this period is covered. {cardOnFile
      ? `The card ending ${subscription.card_last4} is charged on ${formatDate(subscription?.current_period_end)} unless you turn renewal off first.`
      : `Nothing is charged automatically — pay before ${formatDate(subscription?.current_period_end)} to keep your menu online.`}
    </p>}

    {savedCard && !active && <p className="payment-note">{cardOnFile
      ? 'A card is on file, but this period is not paid yet. Paying charges it straight away.'
      : 'The card below paid a previous period. Save it on Safepay to have renewals charged automatically.'}
    </p>}

    {error && <div className="login-error">{error}</div>}

    <div className="billing-actions-buttons">
      {!active && <button className="admin-primary" disabled={Boolean(busy) || !planId} onClick={start}>
        {busy.includes('checkout') ? 'Opening Safepay…' : primaryLabel}
      </button>}
      <button className="admin-secondary" disabled={Boolean(busy)} onClick={addCard}>
        <CreditCard size={15} strokeWidth={2} aria-hidden="true" />{busy === 'card' ? 'Opening Safepay…' : cardOnFile ? 'Replace your card' : 'Save a card for renewals'}
      </button>
      {hasSubscription && <button className="admin-secondary" disabled={Boolean(busy)} onClick={stop}>
        {busy === 'cancel' ? 'Cancelling…' : 'Stop renewal'}
      </button>}
      <button className="admin-secondary" disabled={Boolean(busy)} onClick={refreshStatus}><RefreshCw size={15} strokeWidth={2} aria-hidden="true" />{busy === 'sync' ? 'Checking…' : 'Refresh status'}</button>
    </div>

    <p className="payment-note billing-safety">We never store or display your full card number. Only the brand and last four digits are kept here — the card itself lives on Safepay.</p>
  </section>
}

// When the coverage ends, said honestly.
//
// `formatDate` answers "Not available" for no date, which beside "0 days
// remaining" reads as a broken screen rather than as a subscription that has
// never had a period — suspended after a trial that ended the day it began.
// Both halves of that line are decided here, together, so they cannot contradict
// each other.
// Automatic renewal, as a switch.
//
// The platform takes every renewal itself now: at the end of a period it charges the
// card Safepay holds for this restaurant, with nobody at the keyboard, and writes the
// outcome down. What a restaurant needs to be able to say is "stop", so this flips the
// one field that decides whether that charge happens — and says what it means in dates
// and a card number rather than in the field's own name. "Cancels at period end: true"
// is not a sentence anybody should have to read to find out whether their menu goes
// dark next month.
//
// It is deliberately not a cancellation: the period already paid for runs to its end,
// which is what that money bought. Turning it back on before then restores the next
// charge, and nothing was ever lost in between.
//
// The switch needs a card to be meaningful, so it is only offered when Safepay holds
// one: a renewal with nothing to charge is a promise this screen cannot keep.
function AutoRenewToggle({ subscription, refresh }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Only a subscription Safepay is actually running has a renewal to switch. A
  // suspended or ended one has nothing to turn off, and offering the switch would
  // be a promise this screen cannot keep.
  if (!subscription.safepay_card_pointer || !['active', 'trialing'].includes(subscription.status)) return null
  const on = !subscription.cancel_at_period_end
  const next = subscription.status === 'trialing' ? subscription.trial_end : subscription.current_period_end
  const toggle = async () => {
    setBusy(true); setError('')
    try { await postBilling('/api/safepay/manage', { action: 'autoRenew', on: !on }); await refresh?.() }
    catch (requestError) { setError(requestError.message) }
    setBusy(false)
  }
  return <section className={`auto-renew${on ? ' is-on' : ''}`}>
    <div className="auto-renew-copy">
      <strong>Automatic renewal</strong>
      <p>{on
        ? <>On — we charge your saved card{subscription.card_last4 ? <> ending <b>{subscription.card_last4}</b></> : null} on <b>{formatDate(next)}</b> and keep your menu online.</>
        : <>Off — nothing more will be charged, and your menu goes offline on <b>{formatDate(next)}</b>. You can turn this back on any time before then.</>}
      </p>
    </div>
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={`Automatic renewal ${on ? 'on' : 'off'}`}
      className="auto-renew-switch"
      onClick={toggle}
      disabled={busy}
    >
      <span className="auto-renew-track" aria-hidden="true"><span className="auto-renew-knob" /></span>
      <span className="auto-renew-state">{busy ? 'Saving…' : on ? 'On' : 'Off'}</span>
    </button>
    {error && <p className="auto-renew-error">{error}</p>}
  </section>
}

function CoverageEndFact({ status, billing, end, days }) {
  const label = status === 'trialing' ? 'Trial ends' : 'Period ends'
  if (!end) return <div><span>{label}</span><strong>—</strong><small>{status === 'trialing' ? 'Not set yet' : 'No paid period yet'}</small></div>
  const remaining = billing?.days_remaining ?? days
  return <div><span>{label}</span><strong>{formatDate(end)}</strong><small>{remaining === null || remaining === undefined ? '' : `${remaining} day${remaining === 1 ? '' : 's'} remaining`}</small></div>
}

// Which dates one payment covers. A subscription whose first period has not
// opened — suspended, or onboarded but never charged — has a start and no end,
// and saying "begins when the trial ends" to somebody whose trial ended weeks ago
// is simply wrong.
function CoveragePeriodFact({ subscription }) {
  const start = subscription.current_period_start
  const stop = subscription.current_period_end
  const value = start && stop ? `${formatDate(start)} — ${formatDate(stop)}`
    : start ? `${formatDate(start)} — ongoing`
      : subscription.status === 'trialing' ? 'Begins when the trial ends'
        : 'Not started — your first payment opens it'
  return <div><span>Billing period</span><strong>{value}</strong></div>
}

// The shape of the billing, drawn.
//
// Two dates in a grid answer "when" exactly, but not legibly. This draws the
// whole life as one bar with the three phases every subscription moves through —
// free trial (white), paid period (green), and the backup days that keep the
// menu online when a period ends unpaid (yellow). A phase behind is solid, the
// live one is filled up to today, and the ones ahead are hatched, so "where am I
// and what comes next" is a glance rather than a subtraction.
//
// The phases come from shared/periods.js — the same helper the operator panel
// draws with — and nothing is invented: a subscription with no dates draws no
// timeline at all, because a graph reads as measured truth.
function BillingTimeline({ subscription, billing }) {
  const view = billingPhases(subscription, {
    fallbackBackupDays: Number(billing?.backup_window_days) || Number(billing?.grace_period_days) || 0,
  })
  const { phases, current } = view
  if (!phases.length) return null

  const PHASE_LABEL = { trial: 'Free trial', plan: 'Paid & covered', backup: 'Backup days' }
  const first = phases[0]
  const last = phases[phases.length - 1]
  const span = Math.max(last.end - first.start, 1)
  const amount = formatMoney(subscription.amount)
  const renewing = !subscription.cancel_at_period_end
  const left = current?.daysLeft ?? null
  const trialing = current?.kind === 'trial'
  const inBackup = current?.kind === 'backup'
  const backupDays = view.backupDays
  const backupWord = `${backupDays} backup day${backupDays === 1 ? '' : 's'}`

  const headline = trialing ? 'Free trial' : inBackup ? 'Backup days' : current ? (renewing ? 'Current period' : 'Final period') : 'Coverage ended'
  const state = left === null ? 'Not running' : left === 0 ? 'Ends today' : `${left} day${left === 1 ? '' : 's'} left`
  const axisLabel = trialing ? 'First payment' : inBackup ? 'Menu goes offline' : current ? (renewing ? 'Next payment' : 'Coverage ends') : 'Coverage ended'
  const split = current ? Math.round(((current.end - first.start) / span) * 100) : 100

  const note = trialing
    ? `Your ${Math.round((first.end - first.start) / 86400000)}-day trial covers this period. Safepay takes the first payment of ${amount} on ${formatDate(current.end)}${renewing ? '' : ' — or leave renewal off and pay later'}${backupDays > 0 ? `, and ${backupWord} keep the menu online if a payment is missed` : ''}.`
    : inBackup
      ? `The paid period ended on ${formatDate(current.start)}. You are inside your backup window — it ends on ${formatDate(current.end)}. Renew before then to keep the menu online for your guests.`
      : current
        ? renewing
          ? `Your last payment of ${amount} covered this period. The next one is taken on ${formatDate(current.end)}${backupDays > 0 ? `; if it is missed, ${backupWord} keep the menu online before it goes offline` : ''}.`
          : `Your last payment of ${amount} covered this period. Automatic renewal is off, so nothing further is charged and the menu goes offline after ${formatDate(current.end)}${backupDays > 0 ? `, plus ${backupWord}` : ''}.`
        : 'Every phase of this subscription has ended. Renew to restore the menu for your guests.'

  return <section className="billing-timeline">
    <header className="timeline-head">
      <div><span>{headline}</span><strong>{state}</strong></div>
      <div className="timeline-amount"><small>{trialing ? 'first payment' : 'per period'}</small><strong>{amount}</strong></div>
    </header>

    <div className="timeline-labels phase-legend">
      {phases.map((phase) => <span key={phase.kind} className={`legend-${phase.kind}`}>{PHASE_LABEL[phase.kind]}{phase.state === 'current' ? ' · now' : ''}</span>)}
    </div>

    <div className="timeline-track">
      {phases.map((phase) => {
        const ratio = phase.state === 'past' ? 1 : phase.state === 'current' ? (current?.ratio ?? 0) : 0
        return <div key={phase.kind} className={`timeline-segment is-${phase.kind} is-${phase.state}`} style={{ flexGrow: Math.max(phase.days, 0.6) }}>
          {/* The fill ends exactly at today, so the boundary is the present moment. */}
          <span className="timeline-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      })}
    </div>

    <div className="timeline-axis" style={{ '--split': `${split}%` }}>
      <span className="timeline-axis-start"><b>{formatDate(first.start)}</b><em>{first.kind === 'trial' ? 'Trial started' : 'Period started'}</em></span>
      <span className="timeline-axis-split"><b>{formatDate(current?.end ?? last.end)}</b><em>{axisLabel}</em></span>
    </div>

    <p className="timeline-note">{note}</p>
  </section>
}

function SubscriptionPage({ subscription, billing, openPage, refresh }) { if (!subscription) return <><Header kicker="BILLING" title="Subscription" /><div className="empty-collection"><span><CreditCard size={26} strokeWidth={1.6} aria-hidden="true" /></span><h2>Subscription details are not ready</h2><p>Your platform administrator has not assigned a subscription yet.</p></div></>; const status = subscription.status; const end = status === 'trialing' ? subscription.trial_end : subscription.current_period_end; const days = daysUntil(end); const title = status === 'trialing' ? 'Free trial active' : status === 'active' ? 'Subscription active' : status === 'past_due' ? 'Payment needs attention' : 'Subscription required'; const action = status === 'past_due' ? 'Renew subscription' : status === 'active' ? 'Manage payment method' : status === 'trialing' ? 'Subscribe securely' : 'Renew subscription'; return <><Header kicker="PLAN & BILLING" title="Subscription" /><section className={`subscription-card ${status}`}><div className="subscription-status"><span>{status === 'active' ? <CircleCheckBig size={21} strokeWidth={2} aria-hidden="true" /> : status === 'trialing' ? <Info size={21} strokeWidth={2} aria-hidden="true" /> : <TriangleAlert size={21} strokeWidth={2} aria-hidden="true" />}</span><div><small>{status.replace('_', ' ')}</small><h2>{title}</h2><p>{status === 'suspended' || status === 'canceled' ? 'Renew to restore access to your digital menu.' : `Your ${subscription.plan?.name || 'current'} plan is managed securely by Plato Table.`}</p></div></div><div className="subscription-facts"><div><span>Plan</span><strong>{subscription.plan?.name || 'Current plan'}</strong></div><div><span>Price</span><strong>{formatMoney(subscription.amount)} / period</strong></div><CoverageEndFact status={status} billing={billing} end={end} days={days} /><CoveragePeriodFact subscription={subscription} />{(subscription.status === 'trialing' || subscription.status === 'past_due') && billing?.access_ends_at && <div><span>Access ends</span><strong>{formatDate(billing.access_ends_at)}</strong><small>{billing.grace_days_remaining === null ? '' : `${billing.grace_days_remaining} day${billing.grace_days_remaining === 1 ? '' : 's'} of grace left`}</small></div>}</div><BillingTimeline subscription={subscription} billing={billing} /><AutoRenewToggle subscription={subscription} refresh={refresh} /><BillingActions subscription={subscription} primaryLabel={action} refresh={refresh} /><footer><button className="admin-secondary" onClick={() => openPage('billing')}>View billing history</button></footer></section></> }

function BillingHistory({ restaurantId, openPage }) { const { data, loading, error } = useData('payment_transactions', restaurantId, 'created_at'); if (loading) return <PageLoader label="Loading billing history" />; const paid = data.filter((item) => item.status === 'succeeded').reduce((total, item) => total + Number(item.amount || 0), 0); const exportCsv = () => { const rows = [['Date', 'Amount', 'Currency', 'Status'], ...data.map((item) => [new Date(item.created_at).toISOString(), item.amount, item.currency, item.status])]; const blob = new Blob([rows.map((row) => row.join(',')).join('\n')], { type: 'text/csv' }); const href = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = href; anchor.download = 'billing-history.csv'; anchor.click(); URL.revokeObjectURL(href) }; return <><Header kicker="PLAN & BILLING" title="Billing history" action="Export CSV" onAction={exportCsv} actionIcon={Download} />{error && <div className="login-error">{error}</div>}<section className="billing-summary"><span>Total paid</span><strong>{formatMoney(paid)}</strong><button className="admin-secondary" onClick={() => openPage('subscription')}>Back to subscription</button></section><div className="billing-table">{data.length ? data.map((item) => <article key={item.id}><time>{formatDate(item.created_at)}</time><strong>{formatMoney(item.amount)}</strong><span className={`transaction-status ${item.status}`}>{item.status}</span>{item.invoice_url ? <a href={item.invoice_url} target="_blank" rel="noreferrer">Invoice <ExternalLink size={12} strokeWidth={2.2} aria-hidden="true" /></a> : <span className="no-invoice">Invoice unavailable</span>}</article>) : <div className="empty-collection"><span><FileText size={26} strokeWidth={1.6} aria-hidden="true" /></span><h2>No transactions yet</h2><p>Completed payments will appear here.</p></div>}</div></> }

// Card details live on Safepay, which publishes no portal page an owner can be
// sent to. What is left is the work that can be done here: Safepay Checkout to
// attach a card, and a cancellation the platform makes on their behalf.
function PaymentMethod({ subscription, billing, openPage, refresh }) { const status = subscription?.last_payment_status; return <><Header kicker="SECURE BILLING" title="Payment method" />{billing?.has_payment_method && <section className="billing-summary"><span>Last payment</span><strong>{status === 'paid' ? 'Paid' : status === 'failed' ? 'Failed' : 'No payment yet'}</strong><button className="admin-secondary" onClick={() => openPage('billing')}>View invoices</button></section>}<BillingActions subscription={subscription} primaryLabel={subscription?.status === 'suspended' || subscription?.status === 'canceled' ? 'Renew subscription' : 'Subscribe securely'} refresh={refresh} /><section className="payment-method-card"><span className="settings-icon"><Info size={18} strokeWidth={1.9} aria-hidden="true" /></span><h2>Need help with billing?</h2><p>Your subscription, invoices, and card are all managed by Safepay. If something looks wrong, the platform team can see the same records from the operator panel.</p><div><button className="admin-secondary" onClick={() => openPage('billing')}>View invoices</button><button className="admin-secondary" onClick={() => openPage('subscription')}>Back to subscription</button></div></section></> }

function Notifications({ notifications, refresh }) { const [filter, setFilter] = useState('all'); const [selected, setSelected] = useState(null); const mark = async (id, read = true) => { const { error } = await supabase.rpc('mark_restaurant_notification_read', { p_notification_id: id, p_is_read: read }); if (error) notify(error.message, 'error'); else refresh() }; const visible = notifications.filter((item) => filter === 'all' || (filter === 'unread' ? !item.is_read : item.is_read)); return <><Header kicker="PLATFORM UPDATES" title="Notifications" action="Mark all as read" actionIcon={Check} onAction={() => Promise.all(notifications.filter((item) => !item.is_read).map((item) => mark(item.id))).then(refresh)} /><div className="notification-filters"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>All</button><button className={filter === 'unread' ? 'active' : ''} onClick={() => setFilter('unread')}>Unread</button><button className={filter === 'read' ? 'active' : ''} onClick={() => setFilter('read')}>Read</button></div><section className="notification-list">{visible.length ? visible.map((item) => <article className={`${item.background_color} ${item.is_read ? '' : 'unread'}`} key={item.id} onClick={() => setSelected(item)}><span>{item.type === 'critical' ? <TriangleAlert size={14} strokeWidth={2.2} aria-hidden="true" /> : item.type === 'success' ? <CircleCheckBig size={14} strokeWidth={2.2} aria-hidden="true" /> : <Info size={14} strokeWidth={2.2} aria-hidden="true" />}</span><div><h2>{item.title}</h2><p>{item.message}</p><small>{relativeTime(item.created_at)}</small></div>{item.action_url && <ActionLink className="notification-cta" to={notificationTarget(item.action_url, restaurantSlug)} label={item.action_label || 'Open'} />}{!item.is_read && <button className="admin-secondary" onClick={(event) => { event.stopPropagation(); mark(item.id) }}><Check size={14} strokeWidth={2.2} aria-hidden="true" />Mark read</button>}</article>) : <div className="empty-collection"><span><Bell size={26} strokeWidth={1.6} aria-hidden="true" /></span><h2>No notifications</h2><p>You're all caught up.</p></div>}</section>{selected && <Modal title={selected.title} close={() => setSelected(null)}><div className="notification-detail"><p>{selected.message}</p><small>{formatDate(selected.created_at)}</small>{selected.action_url && <ActionLink className="admin-primary" to={notificationTarget(selected.action_url, restaurantSlug)} label={selected.action_label || 'Open'} onFollow={() => setSelected(null)} />}{!selected.is_read && <button className="admin-secondary" onClick={() => { mark(selected.id); setSelected(null) }}><Check size={14} strokeWidth={2.2} aria-hidden="true" />Mark as read</button>}</div></Modal>}</> }

function Usage({ restaurantId }) { const { data: scans, loading: scansLoading } = useData('scan_logs', restaurantId, 'scanned_at'); const { data: items, loading: itemsLoading } = useData('menu_items', restaurantId); const { data: categories, loading: categoriesLoading } = useData('categories', restaurantId); const [period, setPeriod] = useState('month'); if (scansLoading || itemsLoading || categoriesLoading) return <PageLoader label="Loading usage statistics" />; const since = new Date(); since.setDate(since.getDate() - (period === 'week' ? 7 : period === 'month' ? 30 : 90)); const rows = scans.filter((scan) => new Date(scan.scanned_at) >= since); const days = [...Array(period === 'week' ? 7 : period === 'month' ? 30 : 90)].map((_, i) => { const day = new Date(since); day.setDate(day.getDate() + i); return { label: day.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }), count: rows.filter((scan) => new Date(scan.scanned_at).toDateString() === day.toDateString()).length } }); const peak = Array.from({ length: 24 }, (_, hour) => rows.filter((scan) => new Date(scan.scanned_at).getHours() === hour).length); const max = Math.max(...days.map((day) => day.count), 1); return <><Header kicker="RESTAURANT ACTIVITY" title="Usage statistics" /><div className="usage-period"><label>Period <select value={period} onChange={(event) => setPeriod(event.target.value)}><option value="week">Last 7 days</option><option value="month">Last 30 days</option><option value="quarter">Last 90 days</option></select></label></div>{/* The same three cards the overview shows, so the two screens read as one
      product rather than two designs of the same numbers. */}
<div className="stats-grid usage-stats"><article className="stat-card"><div className="stat-icon"><QrCode size={17} strokeWidth={1.9} aria-hidden="true" /></div><span>QR scans</span><strong>{rows.length}</strong><small>Selected period</small></article><article className="stat-card"><div className="stat-icon"><UtensilsCrossed size={17} strokeWidth={1.9} aria-hidden="true" /></div><span>Menu items</span><strong>{items.length}</strong><small>Currently configured</small></article><article className="stat-card"><div className="stat-icon"><LayoutGrid size={17} strokeWidth={1.9} aria-hidden="true" /></div><span>Categories</span><strong>{categories.length}</strong><small>Currently configured</small></article></div><div className="usage-grid"><section className="admin-card chart-card"><h2>Scans over time</h2><div className="bar-chart">{days.map((day) => <div key={day.label} title={`${day.label}: ${day.count} scans`}><i style={{ height: `${Math.max(4, (day.count / max) * 100)}%` }} /><small>{day.label}</small></div>)}</div></section><section className="admin-card chart-card"><h2>Peak hours</h2><div className="peak-list">{peak.map((count, hour) => <div key={hour}><span>{String(hour).padStart(2, '0')}:00</span><i><b style={{ width: `${(count / Math.max(...peak, 1)) * 100}%` }} /></i><strong>{count}</strong></div>)}</div></section></div><section className="admin-card usage-note"><h2>Item views</h2><p>Item-view events are not collected by the current schema, so top viewed items cannot be shown yet. Scan, menu, and category metrics above use existing restaurant data only.</p></section></> }
function Modal({ title, close, children }) { return <div className="admin-modal-backdrop"><section className="admin-modal"><header><h2>{title}</h2><button onClick={close} aria-label="Close"><X size={18} strokeWidth={1.9} aria-hidden="true" /></button></header>{children}</section></div> }

function Shell({ theme, toggleTheme }) {
  const navigate = useNavigate(); const location = useLocation(); const checkoutReturn = new URLSearchParams(location.search).get('checkout'); const page = location.pathname.split('/').filter(Boolean).slice(2).join('/') || 'dashboard'; const [restaurant, setRestaurant] = useState(null); const [subscription, setSubscription] = useState(null); const [billing, setBilling] = useState(null); const [notifications, setNotifications] = useState([]); const [setupError, setSetupError] = useState(''); const openPage = (id) => navigate(id === 'dashboard' ? `/admin/${restaurantSlug}` : `/admin/${restaurantSlug}/${id}`);  // Billing and notifications are read through RPCs rather than table selects.
  // The RPCs apply the grace period, the per-restaurant read state, and the
  // audience filter in one place, so this screen cannot drift from what the menu
  // gate and the billing sweep believe. The old direct select also showed the
  // operator's own internal notes to the restaurant and shared one `is_read`
  // flag across every restaurant that received the same broadcast.
  const loadAccountData = async (restaurantId) => { const [subscriptionResult, billingResult, notificationResult] = await Promise.all([supabase.from('subscriptions').select('*, plan:subscription_plans(name, duration_days, interval, interval_count)').eq('restaurant_id', restaurantId).maybeSingle(), supabase.rpc('restaurant_billing', { p_restaurant_id: restaurantId }), supabase.rpc('restaurant_notifications', { p_limit: 50 })]); if (subscriptionResult.error) notify(subscriptionResult.error.message, 'error'); else setSubscription(subscriptionResult.data); if (!billingResult.error) setBilling(billingResult.data || null); if (notificationResult.error) notify(notificationResult.error.message, 'error'); else setNotifications(notificationResult.data?.notifications || []) }
  useEffect(() => {
    let mounted = true
    const loadRestaurant = async () => {
      const { data: { user }, error: userError } = await supabase.auth.getUser()
      if (userError || !user) { await supabase.auth.signOut(); navigate(`/admin/${restaurantSlug}/login`, { replace: true }); return }
      const { data, error } = await supabase.from('restaurant_admins').select('restaurant_id, restaurants!inner(name, subdomain, owner_email, phone, contact_email)').eq('user_id', user.id).eq('is_active', true).eq('restaurants.subdomain', restaurantSlug).maybeSingle()
      if (!mounted) return
      if (error) { setSetupError(error.message); return }
      if (data) { const restaurantRecord = { id: data.restaurant_id, name: data.restaurants?.name || 'Restaurant', email: data.restaurants?.owner_email || '', phone: data.restaurants?.phone || '', contactEmail: data.restaurants?.contact_email || '' }; setRestaurant(restaurantRecord); loadAccountData(restaurantRecord.id); return }
      // No bootstrap fallback: the live database has no bootstrap helper, and an
      // account that does not manage this slug must never be silently attached to
      // a different restaurant.
      setSetupError(`This account does not manage ${restaurantSlug}. Sign in to the correct restaurant workspace.`)
    }
    loadRestaurant(); return () => { mounted = false }
  }, [navigate])
  useEffect(() => { if (!restaurant) return undefined; const timer = window.setInterval(() => loadAccountData(restaurant.id), 60000); return () => window.clearInterval(timer) }, [restaurant])
  // Live delivery. The socket is a signal and never a source of truth: nothing is
  // read from the payload, and the RPC that applies the audience split, the grace
  // period, and per-recipient read state is re-run instead. A message the platform
  // sends while an owner is working therefore arrives — and chimes — immediately,
  // rather than up to a minute later. The poll above stays as the fallback for a
  // dropped connection; row-level security decides what is delivered either way.
  useEffect(() => {
    if (!supabase || !restaurant) return undefined
    const channel = supabase
      .channel(`restaurant-notifications-${restaurant.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'system_notifications' }, () => loadAccountData(restaurant.id))
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [restaurant])
  // One chime per new unread message. The counter starts at zero, so opening the
  // admin with something already waiting is what makes the sound, and the minute
  // poll above then only speaks up when the unread count actually grows rather
  // than every time the same message is read back.
  const chimedUnread = useRef(0)
  const unreadCount = notifications.filter((item) => !item.is_read).length
  useEffect(() => { if (!unreadCount) { chimedUnread.current = 0; return } if (unreadCount > chimedUnread.current) playNotificationSound(); chimedUnread.current = unreadCount }, [unreadCount])
  useEffect(() => { const locked = subscription?.status === 'suspended' || subscription?.status === 'canceled'; if (restaurant && locked && !subscriptionPages.includes(page)) navigate(`/admin/${restaurantSlug}/subscription`, { replace: true }) }, [restaurant, subscription, page, navigate])
  // Coming back from Safepay.
  //
  // The page returns the owner with ?checkout=success&tracker=track_…, and that
  // tracker is read back from Safepay rather than taken on trust from the query
  // string: the money is written down from Safepay's own record of the payment, not
  // from a parameter a browser could invent. The webhook usually arrives too, and
  // both paths write the same facts, so whichever lands first wins. The query string
  // is cleared afterwards so a refresh does not repeat the read.
  //
  // A session that came back from the add-card page reports `card-saved` instead:
  // nothing was charged, and the message must not claim otherwise.
  useEffect(() => {
    if (!restaurant) return undefined
    const params = new URLSearchParams(location.search)
    const outcome = params.get('checkout')
    if (!outcome) return undefined
    const returnTo = `/admin/${restaurantSlug}/subscription`
    const clear = () => navigate(returnTo, { replace: true })

    if (outcome !== 'success') {
      notify('Checkout cancelled. Nothing was charged.', 'error')
      clear()
      return undefined
    }

    let cancelled = false
    // The confirming sheet below stays up until the fresh state has actually been
    // read back, and the URL is only cleaned afterwards — settling takes seconds
    // (read the tracker, store the card, charge the first period), and refreshing
    // the screen first is the difference between "confirming…" and showing the
    // row's old "payment failed" face for a few seconds under the overlay.
    const finish = async () => {
      if (cancelled) return
      await loadAccountData(restaurant.id)
      if (cancelled) return
      clear()
    }

    postBilling('/api/safepay/settle', { ...(params.get('tracker') ? { tracker: params.get('tracker') } : {}) })
      .then((result) => {
        if (cancelled) return
        const card = result.subscription?.card_last4 ? ` Your card ending ${result.subscription.card_last4} is on file.` : ''
        if (result.result === 'paid') notify(`Payment received — your subscription is active until ${formatDate(result.subscription?.current_period_end)}.${card}`)
        else if (result.result === 'card-saved') {
          // The card was accepted but the first charge did not go through (a
          // verification-only card, no funds, an issuer refusal). Saying "card
          // saved" alone would look like success while the period stayed unpaid.
          if (result.first_charge && result.first_charge.charged === false) notify(`Card saved, but the payment could not be taken${result.first_charge.reason ? `: ${result.first_charge.reason}` : '.'} Try again or use another card — the menu stays online through the grace period.`, 'error')
          // Revisiting the success URL after everything already settled: the
          // period is paid, and "card saved" alone would undersell that.
          else if (result.subscription?.status === 'active' && result.subscription?.last_payment_status === 'paid') notify(`Payment received — your subscription is active until ${formatDate(result.subscription?.current_period_end)}.${card}`)
          else notify(`Card saved.${card} We'll charge it when your next period starts.`)
        }
        else if (result.result === 'pending') notify('Safepay is still waiting for the payment to finish. Refresh in a moment.', 'error')
        else if (result.result === 'unsettled') notify('The payment did not go through. Nothing was charged — you can try again or use another card.', 'error')
        else notify('Returned from Safepay. Refresh status in a moment to see the outcome.')
      })
      .catch((requestError) => { if (!cancelled) notify(requestError.message, 'error') })
      .then(finish)
    return () => { cancelled = true }
  }, [restaurant, location.search, navigate])
  if (setupError) return <main className="scan-error"><BrandMark size={42} /><h1>Admin setup incomplete</h1><p>{setupError}</p><button className="admin-primary" onClick={() => supabase.auth.signOut().then(() => navigate(`/admin/${restaurantSlug}/login`))}>Log out</button></main>
  if (!restaurant) return <main className="scan-error"><span className="scan-spinner" /><p>Loading your restaurant…</p></main>
  const locked = subscription?.status === 'suspended' || subscription?.status === 'canceled'; const activePage = locked && !subscriptionPages.includes(page) ? 'subscription' : page; const refreshAccount = () => loadAccountData(restaurant.id); const views = { dashboard: <Dashboard restaurantId={restaurant.id} restaurantName={restaurant.name} openPage={openPage} />, menu: <Menu restaurantId={restaurant.id} />, offers: <Offers restaurantId={restaurant.id} />, categories: <Categories restaurantId={restaurant.id} />, qr: <QR restaurantId={restaurant.id} />, subscription: <SubscriptionPage subscription={subscription} billing={billing} openPage={openPage} refresh={refreshAccount} />, billing: <BillingHistory restaurantId={restaurant.id} openPage={openPage} />, payment: <PaymentMethod subscription={subscription} billing={billing} openPage={openPage} refresh={refreshAccount} />, notifications: <Notifications notifications={notifications} refresh={refreshAccount} />, usage: <Usage restaurantId={restaurant.id} />, settings: <Settings restaurant={restaurant} openPage={openPage} theme={theme} toggleTheme={toggleTheme} /> }
  return <main className="admin-shell"><aside className="admin-sidebar"><Link className="admin-brand" to={`/admin/${restaurantSlug}`}><BrandMark size={38} /><div><strong>Plato Table</strong><small>{restaurant.name}</small></div></Link><nav>{nav.map(([id, Icon, label]) => <button disabled={locked && !subscriptionPages.includes(id)} className={id === activePage ? 'active' : ''} key={id} onClick={() => openPage(id)} aria-current={id === activePage ? 'page' : undefined}><Icon {...iconProps} />{label}</button>)}</nav><div className="sidebar-footer"><div className="restaurant-chip"><span>{restaurant.name.slice(0, 2)}</span><div><strong>{restaurant.name}</strong><small>Administrator</small></div></div><button className="sidebar-signout" onClick={() => supabase.auth.signOut().then(() => navigate(`/admin/${restaurantSlug}/login`))}><LogOut size={15} strokeWidth={1.9} aria-hidden="true" />Log out</button></div></aside><section className="admin-workspace"><header className="admin-topbar"><div className="mobile-admin-brand"><BrandMark size={28} /><strong>Plato Table</strong></div><span className="topbar-page">{nav.find(([id]) => id === activePage)?.[2] || 'Billing'}</span><div className="topbar-actions"><button className="admin-theme-toggle" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} aria-pressed={theme === 'dark'} title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}>{theme === 'dark' ? <Sun size={17} strokeWidth={1.8} aria-hidden="true" /> : <Moon size={17} strokeWidth={1.8} aria-hidden="true" />}</button><NotificationBell notifications={notifications} onOpen={(item) => !item.is_read && supabase.rpc('mark_restaurant_notification_read', { p_notification_id: item.id, p_is_read: true }).then(() => loadAccountData(restaurant.id))} openPage={openPage} /><Link to={`/${restaurantSlug}`} className="topbar-menu-link">Open customer menu <ExternalLink size={13} strokeWidth={2.2} aria-hidden="true" /></Link></div></header><div className="admin-content"><SubscriptionBanner subscription={subscription} openPage={openPage} />{locked && activePage === 'subscription' && <section className="payment-wall"><span><TriangleAlert size={24} strokeWidth={1.9} aria-hidden="true" /></span><h2>Subscription required</h2><p>Your subscription has ended. Renew to restore your digital menu and admin tools.</p></section>}{views[activePage] || views.dashboard}</div><Feedback />{checkoutReturn === 'success' && <div className="admin-modal-backdrop" role="status" aria-live="polite"><section className="admin-modal billing-settle-modal"><div className="billing-settle-body"><div className="loader-orbit"><i /><i /><i /></div><strong>Confirming your payment</strong><p>We’re reading the result back from Safepay and starting your billing period. This usually takes a few seconds — please keep this page open.</p></div></section></div>}</section></main>
}

// One area of settings: a row that says what it holds, and the fields behind it.
//
// The row is the point. A closed section still answers its own question — the
// phone number, the billing email, which appearance is on — because the summary
// is the current value, not a description of it. Nothing here can be opened to
// discover that it was already set.
function SettingBlock({ id, icon: Icon, title, description, summary, open, onOpen, children }) {
  const expanded = open === id
  return <article className={`setting-block${expanded ? ' is-open' : ''}`}>
    <button type="button" className="setting-row" onClick={() => onOpen(expanded ? '' : id)} aria-expanded={expanded} aria-controls={`setting-panel-${id}`}>
      <span className="setting-row-icon"><Icon size={18} strokeWidth={1.8} aria-hidden="true" /></span>
      <span className="setting-row-copy"><strong>{title}</strong><small>{description}</small></span>
      <span className="setting-row-value">{summary}</span>
      <ChevronDown className="setting-row-chevron" size={18} strokeWidth={2} aria-hidden="true" />
    </button>
    {expanded && <div className="setting-panel" id={`setting-panel-${id}`}>{children}</div>}
  </article>
}

function Settings({ restaurant, openPage, theme, toggleTheme }) {
  const [name, setName] = useState(restaurant.name); const [phone, setPhone] = useState(restaurant.phone); const [contactEmail, setContactEmail] = useState(restaurant.contactEmail); const [billingEmail, setBillingEmail] = useState(restaurant.email); const [taxId, setTaxId] = useState(''); const [billingAddress, setBillingAddress] = useState(''); const [password, setPassword] = useState(''); const [confirmPassword, setConfirmPassword] = useState(''); const [currentPassword, setCurrentPassword] = useState(''); const [openSection, setOpenSection] = useState('')
  useEffect(() => { supabase.from('restaurants').select('billing_email, tax_id, billing_address').eq('id', restaurant.id).maybeSingle().then(({ data, error }) => { if (!error && data) { setBillingEmail(data.billing_email || restaurant.email); setTaxId(data.tax_id || ''); setBillingAddress(data.billing_address || '') } }) }, [restaurant.id, restaurant.email])
  const saveProfile = async () => { const { error } = await supabase.from('restaurants').update({ name: name.trim(), phone: phone.trim() || null, contact_email: contactEmail.trim() || null }).eq('id', restaurant.id); if (error) notify(error.message, 'error'); else notify('Restaurant contact details saved.') }
  const saveBilling = async () => { const { error } = await supabase.from('restaurants').update({ billing_email: billingEmail.trim() || null, tax_id: taxId.trim() || null, billing_address: billingAddress.trim() || null }).eq('id', restaurant.id); if (error) notify(error.message, 'error'); else notify('Billing details saved.') }
  // The current password is asked for and checked first: updateUser does not ask
  // for it, so without this step anyone who finds an unlocked browser can set a
  // new password and keep the account.
  const changePassword = async (e) => {
    e.preventDefault()
    const problem = passwordError(password)
    if (problem) return notify(problem, 'error')
    if (password !== confirmPassword) return notify('Passwords do not match.', 'error')
    const { error: verifyError } = await supabase.auth.signInWithPassword({ email: restaurant.email, password: currentPassword })
    if (verifyError) return notify(`Your current password could not be verified. ${describeAuthError(verifyError).message}`, 'error')
    const { error } = await supabase.auth.updateUser({ password })
    if (error) notify(error.message, 'error')
    else { setPassword(''); setConfirmPassword(''); setCurrentPassword(''); notify('Password updated successfully.') }
  }
  return <><Header kicker="RESTAURANT PROFILE" title="Settings" /><section className="settings-profile"><span className="settings-profile-mark"><BrandMark size={46} /></span><div className="settings-profile-copy"><span className="admin-kicker">RESTAURANT PROFILE</span><h2>{restaurant.name}</h2><p>/{restaurantSlug} · {restaurant.email}</p></div><div className="settings-profile-actions"><button className="admin-secondary" onClick={() => openPage('subscription')}>Plan & billing</button><Link className="admin-secondary" to={`/${restaurantSlug}`}>View customer menu <ExternalLink size={12} strokeWidth={2.2} aria-hidden="true" /></Link></div></section><div className="settings-list"><SettingBlock id="contact" icon={Store} title="Customer contact" description="Shown to guests when they need help." summary={phone || contactEmail || 'Not set'} open={openSection} onOpen={setOpenSection}><div className="setting-fields"><Field label="Restaurant name"><input value={name} onChange={(e) => setName(e.target.value)} /></Field><Field label="Phone number"><input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="Add a phone number" /></Field><Field label="Customer contact email"><input type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} placeholder="Add a customer contact email" /></Field></div><div className="setting-actions"><button className="admin-primary" onClick={saveProfile}>Save changes</button></div></SettingBlock><SettingBlock id="billing" icon={Receipt} title="Billing details" description="Used for subscription invoices and billing support." summary={billingEmail || 'Not set'} open={openSection} onOpen={setOpenSection}><div className="setting-fields"><Field label="Billing email"><input type="email" value={billingEmail} onChange={(e) => setBillingEmail(e.target.value)} placeholder="billing@example.com" /></Field><Field label="Tax ID (optional)"><input value={taxId} onChange={(e) => setTaxId(e.target.value)} placeholder="Add tax ID" /></Field><Field label="Billing address"><textarea value={billingAddress} onChange={(e) => setBillingAddress(e.target.value)} placeholder="Street, city, postal code" /></Field></div><div className="setting-actions"><button className="admin-primary" onClick={saveBilling}>Save changes</button><button className="admin-secondary" onClick={() => openPage('payment')}>Manage payment</button><button className="admin-secondary" onClick={() => openPage('billing')}>View invoices</button></div></SettingBlock><SettingBlock id="appearance" icon={Palette} title="Appearance" description="How this workspace looks on this device." summary={theme === 'dark' ? 'Dark' : 'Light'} open={openSection} onOpen={setOpenSection}><div className="setting-choice"><button type="button" className={theme === 'light' ? 'is-selected' : ''} onClick={() => theme === 'dark' && toggleTheme?.()} aria-pressed={theme === 'light'}><Sun size={17} strokeWidth={1.9} aria-hidden="true" />Light</button><button type="button" className={theme === 'dark' ? 'is-selected' : ''} onClick={() => theme === 'light' && toggleTheme?.()} aria-pressed={theme === 'dark'}><Moon size={17} strokeWidth={1.9} aria-hidden="true" />Dark</button></div></SettingBlock><SettingBlock id="security" icon={ShieldCheck} title="Account security" description="The address you sign in with, and your password." summary={restaurant.email} open={openSection} onOpen={setOpenSection}><form className="setting-fields setting-form-inline" onSubmit={changePassword}><Field label="Admin email"><input value={restaurant.email} disabled readOnly /></Field><Field label="Current password"><input required type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} /></Field><Field label="New password"><input required type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field><Field label="Confirm new password"><input required type="password" autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} /></Field><div className="setting-actions"><button className="admin-primary">Update password</button></div><aside className="security-note">Passwords need at least 12 characters. After three failed sign-in attempts, this browser is locked out for one hour.</aside></form></SettingBlock></div></>
}
export default function AdminApp({ login = false }) {
  // The wrapper carries the theme for both surfaces, so the sign-in screen and
  // the workspace never disagree about which appearance is active.
  const { theme, toggle } = useTheme('platotable-admin-theme')
  // Armed here — on the sign-in screen as much as inside the workspace — because
  // that is what makes the first chime audible: the click that signs in is a real
  // gesture, so the AudioContext is already running by the time the workspace has
  // read its unread count, instead of the chime waiting on a second, unrelated
  // click that the person had no reason to make.
  useEffect(() => { armNotificationSound() }, [])

  return <div className="admin-theme-root" data-theme={theme}>{login ? <Login /> : <Shell theme={theme} toggleTheme={toggle} />}</div>
}
