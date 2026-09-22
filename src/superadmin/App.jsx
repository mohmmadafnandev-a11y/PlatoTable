import { useCallback, useEffect, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { BarChart3, Bell, Building2, ChevronDown, CircleDollarSign, CreditCard, FileClock, LayoutDashboard, Link2, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Receipt, Search, Settings, ShieldCheck, Sun, Users, X } from 'lucide-react'
import { supabase } from './lib/supabase'
import { saPath } from '../lib/tenant'
import { describeAuthError } from '../lib/auth-errors'
import './App.css'
import './theme.css'
import ActivityLogs from './components/ActivityLogs'
import Analytics from './components/Analytics'
import CustomUrls from './components/CustomUrls'
import Dashboard from './components/Dashboard'
import Plans from './components/Plans'
import { RestaurantDetail, Restaurants } from './components/Restaurants'
import Revenue from './components/Revenue'
import SystemSettings from './components/Settings'
import { SubscriptionDetail, Subscriptions } from './components/Subscriptions'
import Team from './components/Team'
import Transactions from './components/Transactions'
import { StatusBadge } from './components/ui'
import { useRestaurants } from './lib/data'
import { useTheme } from '../lib/theme'
import { useSidebar } from './lib/layout'
import RestaurantOnboarding from './components/RestaurantOnboarding'

const appName = import.meta.env.VITE_APP_NAME || 'Plato Table'

// Every Super Admin screen lives under /admin in the merged bundle. Prefixing
// navigation in one place keeps each page component's own paths untouched.
const useSuperAdminNavigate = () => {
  const navigate = useNavigate()
  return useCallback((to, options) => navigate(typeof to === 'string' ? saPath(to) : to, options), [navigate])
}

const navigation = [
  { to: saPath('/dashboard'), label: 'Dashboard', icon: LayoutDashboard },
  { to: saPath('/restaurants'), label: 'Restaurants', icon: Building2 },
  { to: saPath('/subscriptions'), label: 'Subscriptions', icon: CreditCard },
  { to: saPath('/transactions'), label: 'Transactions', icon: Receipt },
  { to: saPath('/revenue'), label: 'Revenue & wallet', icon: CircleDollarSign },
  { to: saPath('/plans'), label: 'Plans & pricing', icon: CreditCard },
  { to: saPath('/notifications'), label: 'Notifications', icon: Bell },
  { to: saPath('/analytics'), label: 'Analytics', icon: BarChart3 },
  { to: saPath('/logs'), label: 'Activity logs', icon: FileClock },
  { to: saPath('/team'), label: 'Team members', icon: Users },
  { to: saPath('/urls'), label: 'Custom URLs', icon: Link2 },
  { to: saPath('/settings'), label: 'System settings', icon: Settings },
]

function App() {
  const [session, setSession] = useState(() => supabase ? undefined : null)
  // Three states, not two: undefined means the super_admins lookup has not
  // answered yet, null means it answered and this account is not platform
  // staff. Collapsing those into one value made every deep link race the
  // lookup and bounce to the dashboard.
  const [profile, setProfile] = useState(undefined)
  const [authError, setAuthError] = useState('')
  const { theme, toggle: toggleTheme } = useTheme('platotable-super-admin-theme')

  useEffect(() => {
    if (!supabase) return undefined
    supabase.auth.getSession().then(({ data }) => setSession(data.session || null))
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => setSession(nextSession))
    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    let alive = true
    if (!session || !supabase) return undefined
    supabase.from('super_admins').select('id, name, email, role, is_active').eq('user_id', session.user.id).maybeSingle().then(({ data, error }) => {
      if (!alive) return
      if (error || !data?.is_active) { setAuthError(error ? 'Super Admin access has not been configured yet.' : 'Your Super Admin account is inactive.'); setProfile(null) }
      else { setAuthError(''); setProfile(data) }
    })
    return () => { alive = false }
  }, [session])

  // Hold on the loading screen until the platform-staff check has answered.
  // Redirecting on an unanswered check is what discarded the requested URL.
  if (session === undefined || (session && profile === undefined)) return <div className="sa-scope" data-theme={theme}><LoadingScreen /></div>
  // These are descendant routes of the /admin/* route that mounts this app, so
  // the paths must be relative: a leading slash here would be resolved against
  // the parent and become /admin/admin/login.
  return <div className="sa-scope" data-theme={theme}><Routes>
    <Route path="login" element={session && profile ? <Navigate to={saPath('/dashboard')} replace /> : <Login error={authError} />} />
    <Route path="*" element={session && profile ? <Shell profile={profile} theme={theme} toggleTheme={toggleTheme} /> : <Navigate to={saPath('/login')} replace />} />
  </Routes></div>
}

function LoadingScreen() { return <main className="grid min-h-screen place-items-center bg-slate-50 text-sm font-medium text-slate-600"><div className="flex items-center gap-3"><span className="h-5 w-5 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600" />Opening {appName}…</div></main> }

function Login({ error }) {
  const navigate = useSuperAdminNavigate(); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [showPassword, setShowPassword] = useState(false); const [remember, setRemember] = useState(true); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(false)
  const submit = async (event) => { event.preventDefault(); if (!supabase) return setMessage('Add the public Supabase variables to .env.local before signing in.'); setLoading(true); setMessage(''); const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password }); if (signInError) { setMessage(describeAuthError(signInError).message); setLoading(false); return } if (!remember) sessionStorage.setItem('platotable-session-only', 'true'); navigate('/dashboard') }
  const reset = async () => { if (!email.trim()) return setMessage('Enter your email address first, then choose password reset.'); if (!supabase) return; const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}${saPath('/login')}` }); setMessage(resetError ? 'Could not send the reset email. Please try again.' : 'Password reset instructions were sent if this account exists.') }
  return <main className="login-glow grid min-h-screen place-items-center p-5"><section className="grid w-full max-w-5xl overflow-hidden rounded-[28px] bg-white shadow-2xl shadow-slate-950/20 lg:grid-cols-[.9fr_1.1fr]"><aside className="login-art relative hidden min-h-[620px] overflow-hidden p-11 text-white lg:flex lg:flex-col lg:justify-between"><div className="relative z-10 flex items-center gap-3 text-lg font-bold"><span className="grid h-10 w-10 place-items-center rounded-xl bg-white text-indigo-600">P</span>{appName}</div><div className="relative z-10 max-w-sm"><span className="text-xs font-semibold tracking-[.2em] text-indigo-200">PLATFORM CONTROL</span><h1 className="mt-5 text-5xl font-semibold leading-[1.04] tracking-tight">Every restaurant.<br /><span className="text-emerald-300">One clear view.</span></h1><p className="mt-5 text-sm leading-6 text-slate-200">Manage restaurants, subscriptions, revenue, and support from one secure workspace.</p></div><div className="relative z-10 flex items-center gap-2 text-xs font-medium text-slate-300"><ShieldCheck size={16} /> Enterprise-grade access controls</div></aside><section className="flex min-h-[620px] items-center justify-center p-7 sm:p-12"><form className="w-full max-w-sm" onSubmit={submit}><div className="mb-9"><div className="mb-6 flex h-11 w-11 items-center justify-center rounded-xl bg-indigo-600 text-lg font-bold text-white lg:hidden">P</div><span className="text-xs font-semibold tracking-[.16em] text-indigo-600">SECURE ACCESS</span><h2 className="mt-2 text-3xl font-semibold tracking-tight text-slate-900">Welcome back</h2><p className="mt-2 text-sm text-slate-500">Sign in to the {appName} Super Admin Panel.</p></div>{(message || error) && <div className="mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700" role="alert">{message || error}</div>}<label className="mb-5 grid gap-2 text-sm font-medium text-slate-700">Email address<input required type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@platotable.com" className="h-12 rounded-lg border border-slate-300 px-3 text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" /></label><label className="mb-3 grid gap-2 text-sm font-medium text-slate-700">Password<div className="relative"><input required type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Enter your password" className="h-12 w-full rounded-lg border border-slate-300 px-3 pr-16 text-slate-900 outline-none transition focus:border-indigo-500 focus:ring-4 focus:ring-indigo-100" /><button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute inset-y-0 right-2 px-2 text-xs font-semibold text-indigo-600">{showPassword ? 'Hide' : 'Show'}</button></div></label><div className="mb-7 flex items-center justify-between gap-3"><label className="flex items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} className="h-4 w-4 rounded border-slate-300 accent-indigo-600" />Remember me</label><button type="button" onClick={reset} className="text-sm font-semibold text-indigo-600 hover:text-indigo-800">Forgot password?</button></div><button disabled={loading} className="flex h-12 w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-700 active:scale-[.99] disabled:opacity-60">{loading && <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white" />}{loading ? 'Signing in…' : 'Sign in securely'}</button><p className="mt-7 flex items-center justify-center gap-2 text-xs text-slate-500"><ShieldCheck size={15} className="text-emerald-600" />Secure, restricted Super Admin access</p></form></section></section></main>
}

function Shell({ profile, theme, toggleTheme }) {
  const [mobileOpen, setMobileOpen] = useState(false); const [menuOpen, setMenuOpen] = useState(false); const navigate = useSuperAdminNavigate(); const location = useLocation()
  const { collapsed, toggle: toggleSidebar } = useSidebar()
  const signOut = async () => { await supabase.auth.signOut(); navigate('/login') }
  // The page is read straight from the URL instead of from a nested <Routes>,
  // which would resolve relative to the splat above and shift every path.
  const segments = location.pathname.replace(/^\/admin\/?/, '').split('/').filter(Boolean)
  const page = segments[0] || 'dashboard'
  const detail = segments[1] || ''
  const pageViews = {
    dashboard: <Dashboard navigate={navigate} />,
    restaurants: detail === 'new' ? <RestaurantOnboarding navigate={navigate} /> : detail ? <RestaurantDetail navigate={navigate} id={detail} profile={profile} /> : <Restaurants navigate={navigate} profile={profile} />,
    urls: <CustomUrls profile={profile} />,
    transactions: <Transactions />,
    subscriptions: detail ? <SubscriptionDetail navigate={navigate} id={detail} profile={profile} /> : <Subscriptions navigate={navigate} />,
    plans: <Plans />,
    revenue: <Revenue profile={profile} />,
    notifications: detail === 'send' ? <SendNotification navigate={navigate} /> : <Notifications navigate={navigate} />,
    analytics: <Analytics />,
    logs: <ActivityLogs />,
    team: <Team profile={profile} />,
    settings: <SystemSettings profile={profile} />,
  }
  const content = pageViews[page] || <ComingSoon title={navigation.find((item) => item.to === location.pathname)?.label || 'Page'} />
  return <main className={`sa-shell shell-gradient min-h-screen text-slate-900 ${collapsed ? 'is-collapsed' : ''}`}>
    <aside className={`sa-aside fixed inset-y-0 left-0 z-30 flex flex-col border-r border-slate-200 bg-white p-4 md:translate-x-0 ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}>
      <div className="sa-brand flex items-center gap-3 px-3 py-3">
        <span className="grid h-9 w-9 flex-none place-items-center rounded-xl bg-indigo-600 font-bold text-white">P</span>
        <div className="sa-brand-text min-w-0 flex-1">
          <strong className="block truncate text-sm">{appName}</strong>
          <span className="block truncate text-xs text-slate-500">Super Admin</span>
        </div>
        {/* Desktop only: on a phone the sidebar is a drawer, and a 5rem rail
            there would be worse than no collapse at all. */}
        <button
          onClick={toggleSidebar}
          className="hidden h-8 w-8 flex-none place-items-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 md:grid"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
        </button>
        <button className="ml-auto text-slate-500 md:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X size={20} /></button>
      </div>
      <nav className="mt-7 grid gap-1">
        {navigation.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} onClick={() => setMobileOpen(false)} className="nav-link relative flex min-h-11 items-center gap-3 rounded-lg px-3 text-sm font-medium">
          <Icon size={18} className="flex-none" />
          {/* Left in the tree while collapsed, so the link still announces its
              name to a screen reader when only the icon is on screen. */}
          <span className="sa-label">{label}</span>
          <span className="sa-tip" aria-hidden="true">{label}</span>
        </NavLink>)}
      </nav>
      <div className="sa-status mt-auto rounded-xl bg-slate-900 p-4 text-white">
        <div className="sa-status-row flex items-center gap-2">
          <span className="h-2 w-2 flex-none rounded-full bg-emerald-400" />
          <p className="sa-status-detail text-xs font-semibold text-indigo-200">PLATFORM STATUS</p>
        </div>
        <p className="sa-status-detail mt-2 text-sm font-semibold">All systems operational</p>
        <p className="sa-status-detail mt-1 text-xs leading-5 text-slate-300">Manage your platform securely from one workspace.</p>
      </div>
    </aside>
    {mobileOpen && <button className="fixed inset-0 z-20 bg-slate-950/25 md:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
    <section className="sa-content min-h-screen"><header className="sticky top-0 z-10 flex h-17 items-center gap-4 border-b border-slate-200 bg-white/90 px-5 backdrop-blur sm:px-8"><button onClick={() => setMobileOpen(true)} className="grid h-10 w-10 place-items-center rounded-lg text-slate-600 hover:bg-slate-100 md:hidden" aria-label="Open navigation"><Menu size={21} /></button><label className="hidden max-w-sm flex-1 items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 text-slate-400 sm:flex"><Search size={17} /><input className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-slate-400" placeholder="Search restaurants, payments…" /></label><div className="ml-auto flex items-center gap-2"><button onClick={toggleTheme} className="grid h-10 w-10 place-items-center rounded-full text-slate-600 hover:bg-slate-100" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} aria-pressed={theme === 'dark'}>{theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}</button><button className="relative grid h-10 w-10 place-items-center rounded-full text-slate-600 hover:bg-slate-100" aria-label="Notifications"><Bell size={19} /><span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-red-500" /></button><div className="relative"><button onClick={() => setMenuOpen(!menuOpen)} className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-slate-100"><span className="grid h-8 w-8 place-items-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{(profile.name || profile.email).slice(0, 2).toUpperCase()}</span><span className="hidden text-left sm:block"><strong className="block max-w-32 truncate text-xs">{profile.name || 'Platform admin'}</strong><small className="text-[11px] capitalize text-slate-500">{profile.role.replace('_', ' ')}</small></span><ChevronDown size={15} className="text-slate-500" /></button>{menuOpen && <div className="absolute right-0 top-12 w-48 rounded-xl border border-slate-200 bg-white p-1 shadow-xl"><button onClick={signOut} className="flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-red-600 hover:bg-red-50"><LogOut size={16} />Sign out</button></div>}</div></div></header><div className="dashboard-enter mx-auto max-w-7xl p-5 sm:p-8">{content}</div></section></main>
}


function Notifications({ navigate }) { const [notifications, setNotifications] = useState([]); const [loading, setLoading] = useState(true); const [type, setType] = useState('all'); const reload = () => supabase.from('system_notifications').select('*, restaurants(name)').order('created_at', { ascending: false }).then(({ data }) => { setNotifications(data || []); setLoading(false) }); useEffect(() => { if (supabase) reload() }, []); const visible = notifications.filter((item) => type === 'all' || item.type === type); return <><div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="text-xs font-semibold tracking-[.16em] text-indigo-600">RESTAURANT COMMUNICATION</p><h1 className="mt-2 text-3xl font-semibold">Notifications</h1><p className="mt-2 text-sm text-slate-500">Send operational updates and review delivery history.</p></div><button onClick={() => navigate('/notifications/send')} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white">+ Send notification</button></div><div className="mb-4 flex gap-2 overflow-x-auto">{['all', 'info', 'success', 'warning', 'critical'].map((item) => <button key={item} onClick={() => setType(item)} className={`rounded-lg px-3 py-2 text-sm font-semibold capitalize ${type === item ? 'bg-indigo-600 text-white' : 'border border-slate-200 bg-white text-slate-600'}`}>{item}</button>)}</div><section className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">{loading ? <p className="p-8 text-sm text-slate-500">Loading notifications…</p> : <div className="overflow-x-auto"><table className="min-w-175 w-full text-left text-sm"><thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr><th className="p-4">Date</th><th className="p-4">Notification</th><th className="p-4">Type</th><th className="p-4">Audience</th><th className="p-4">Color</th></tr></thead><tbody>{visible.map((item) => <tr key={item.id} className="border-t border-slate-100"><td className="p-4 text-slate-500">{new Date(item.created_at).toLocaleDateString()}</td><td className="p-4"><strong className="block text-slate-800">{item.title}</strong><span className="mt-1 block max-w-md truncate text-xs text-slate-500">{item.message}</span></td><td className="p-4"><StatusBadge status={item.type === 'success' ? 'active' : item.type === 'critical' ? 'suspended' : item.type} /></td><td className="p-4 text-slate-600">{item.restaurants?.name || 'All restaurants'}</td><td className="p-4 capitalize text-slate-600">{item.background_color}</td></tr>)}{!visible.length && <tr><td colSpan="5" className="p-9 text-center text-slate-500">No notifications found.</td></tr>}</tbody></table></div>}</section></> }
function SendNotification({ navigate }) {
  const { restaurants, loading: restaurantsLoading, error: restaurantsError } = useRestaurants()
  const [title, setTitle] = useState(''); const [message, setMessage] = useState(''); const [type, setType] = useState('info'); const [color, setColor] = useState('white'); const [audience, setAudience] = useState('all'); const [restaurantId, setRestaurantId] = useState(''); const [selectedRestaurantIds, setSelectedRestaurantIds] = useState([]); const [sending, setSending] = useState(false); const [feedback, setFeedback] = useState('')
  const targetIds = audience === 'one' ? (restaurantId ? [restaurantId] : []) : selectedRestaurantIds
  const selectRestaurant = (id) => setSelectedRestaurantIds((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id])
  const send = async (event) => {
    event.preventDefault(); setFeedback('')
    if (audience !== 'all' && !targetIds.length) return setFeedback('Choose at least one restaurant.')
    setSending(true)
    const notification = { title: title.trim(), message: message.trim(), type, background_color: color }
    const records = audience === 'all' ? [notification] : targetIds.map((id) => ({ ...notification, restaurant_id: id }))
    const { error } = await supabase.from('system_notifications').insert(records)
    if (error) setFeedback(`Could not send notification: ${error.message}`)
    else { setFeedback(audience === 'all' ? 'Broadcast sent to all restaurants.' : `Notification sent to ${records.length} restaurant${records.length === 1 ? '' : 's'}.`); setTitle(''); setMessage(''); setRestaurantId(''); setSelectedRestaurantIds([]) }
    setSending(false)
  }
  const audienceLabel = audience === 'all' ? 'Send broadcast to all restaurants' : audience === 'one' ? 'Send to selected restaurant' : `Send to ${targetIds.length} selected restaurant${targetIds.length === 1 ? '' : 's'}`
  return <section className="mx-auto max-w-5xl"><button onClick={() => navigate('/notifications')} className="mb-5 text-sm font-semibold text-indigo-600">← Notifications</button><div className="mb-7"><h1 className="text-3xl font-semibold">Send notification</h1><p className="mt-2 text-sm text-slate-500">Messages are delivered securely in the restaurant admin notification center.</p></div><form onSubmit={send} className="grid gap-6 lg:grid-cols-[1fr_.8fr]"><div className="grid gap-5 rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><label className="grid gap-2 text-sm font-medium text-slate-700">Title<input required value={title} onChange={(event) => setTitle(event.target.value)} className="h-11 rounded-lg border border-slate-300 px-3 outline-none focus:border-indigo-500" placeholder="Important platform update" /></label><label className="grid gap-2 text-sm font-medium text-slate-700">Message<textarea required value={message} onChange={(event) => setMessage(event.target.value)} className="min-h-36 rounded-lg border border-slate-300 p-3 outline-none focus:border-indigo-500" placeholder="Write a clear message for restaurants…" /></label><div className="grid gap-2 text-sm font-medium text-slate-700"><span>Audience</span><div className="flex flex-wrap gap-2">{[['all', 'All restaurants'], ['one', 'One restaurant'], ['selected', 'Selected restaurants']].map(([value, label]) => <button type="button" key={value} onClick={() => setAudience(value)} className={`rounded-lg px-3 py-2 text-sm ${audience === value ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-600'}`}>{label}</button>)}</div></div>{audience === 'one' && <label className="grid gap-2 text-sm font-medium text-slate-700">Restaurant<select required value={restaurantId} onChange={(event) => setRestaurantId(event.target.value)} disabled={restaurantsLoading} className="h-11 rounded-lg border border-slate-300 bg-white px-3 outline-none focus:border-indigo-500"><option value="">{restaurantsLoading ? 'Loading restaurants…' : 'Choose a restaurant'}</option>{restaurants.map((restaurant) => <option key={restaurant.id} value={restaurant.id}>{restaurant.name}</option>)}</select>{restaurantsError && <small className="text-red-600">{restaurantsError}</small>}</label>}{audience === 'selected' && <fieldset className="grid gap-2 text-sm font-medium text-slate-700"><legend>Restaurants</legend><div className="max-h-52 overflow-y-auto rounded-lg border border-slate-200 p-2">{restaurantsLoading ? <p className="p-2 text-sm text-slate-500">Loading restaurants…</p> : restaurants.map((restaurant) => <label key={restaurant.id} className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 hover:bg-slate-50"><input type="checkbox" checked={selectedRestaurantIds.includes(restaurant.id)} onChange={() => selectRestaurant(restaurant.id)} className="h-4 w-4 accent-indigo-600" />{restaurant.name}</label>)}{!restaurantsLoading && !restaurants.length && <p className="p-2 text-sm text-slate-500">No restaurants are available.</p>}</div>{restaurantsError && <small className="text-red-600">{restaurantsError}</small>}</fieldset>}<div className="grid gap-2 text-sm font-medium text-slate-700"><span>Notification type</span><div className="flex flex-wrap gap-2">{['info', 'success', 'warning', 'critical'].map((item) => <button type="button" key={item} onClick={() => setType(item)} className={`rounded-lg px-3 py-2 text-sm capitalize ${type === item ? 'bg-indigo-600 text-white' : 'border border-slate-200 text-slate-600'}`}>{item}</button>)}</div></div><div className="grid gap-2 text-sm font-medium text-slate-700"><span>Background color</span><div className="flex flex-wrap gap-2">{['white', 'green', 'yellow', 'red'].map((item) => <button type="button" key={item} onClick={() => setColor(item)} className={`rounded-lg border px-3 py-2 text-sm capitalize ${color === item ? 'border-indigo-500 ring-2 ring-indigo-100' : 'border-slate-200'}`}>{item}</button>)}</div></div>{feedback && <p className="rounded-lg bg-slate-100 p-3 text-sm text-slate-700">{feedback}</p>}<button disabled={sending || (audience !== 'all' && !targetIds.length)} className="rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white disabled:opacity-60">{sending ? 'Sending…' : audienceLabel}</button></div><aside className={`rounded-xl border p-6 shadow-sm ${color === 'red' ? 'border-red-200 bg-red-50' : color === 'green' ? 'border-emerald-200 bg-emerald-50' : color === 'yellow' ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}><p className="text-xs font-semibold tracking-[.16em] text-slate-500">LIVE PREVIEW</p><h2 className="mt-4 font-semibold text-slate-900">{title || 'Notification title'}</h2><p className="mt-2 text-sm leading-6 text-slate-600">{message || 'Your restaurant message will appear here.'}</p><span className="mt-5 inline-block rounded-full bg-white/80 px-2.5 py-1 text-xs font-semibold capitalize text-slate-600">{type}</span></aside></form></section>
}
function ComingSoon({ title }) { return <section className="grid min-h-[60vh] place-items-center rounded-xl border border-dashed border-slate-300 bg-white p-8 text-center"><div><span className="mx-auto grid h-12 w-12 place-items-center rounded-xl bg-indigo-50 text-xl text-indigo-600">P</span><h1 className="mt-5 text-2xl font-semibold">{title}</h1><p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">This screen is scheduled for the next implementation phase.</p></div></section> }

export default App
