import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const pages = { menu: ['Menu', '⌂'], search: ['Search', '⌕'], settings: ['Settings', '⚙'] }
const languages = { en: 'English', ur: 'اردو', ps: 'پښتو' }
const copy = {
  en: { menu: 'Menu', search: 'Search', settings: 'Settings', choose: 'Choose something', delicious: 'delicious.', searchMenu: 'Search menu', dishes: 'Dishes or ingredients', filter: 'Filter', found: 'found', session: 'YOUR TABLE SESSION', goodToKnow: 'Good to know', visit: 'Your menu stays open for this visit.', table: 'TABLE', timeLeft: 'TIME LEFT', language: 'Language', appearance: 'Appearance', darkOn: 'Dark mode is on', darkOff: 'Light mode is on', call: 'Call restaurant', whatsapp: 'WhatsApp restaurant', email: 'Email restaurant', message: 'Message the restaurant team' },
  ur: { menu: 'مینو', search: 'تلاش', settings: 'ترتیبات', choose: 'کچھ مزیدار', delicious: 'منتخب کریں۔', searchMenu: 'مینو تلاش کریں', dishes: 'کھانے یا اجزاء', filter: 'فلٹر', found: 'آئٹمز ملے', session: 'آپ کا ٹیبل سیشن', goodToKnow: 'جاننے کے لیے', visit: 'یہ مینو اس وزٹ کے لیے کھلا رہے گا۔', table: 'ٹیبل', timeLeft: 'باقی وقت', language: 'زبان', appearance: 'ظاہری شکل', darkOn: 'ڈارک موڈ فعال ہے', darkOff: 'لائٹ موڈ فعال ہے', call: 'ریستوران کو کال کریں', whatsapp: 'واٹس ایپ ریستوران', email: 'ریستوران کو ای میل کریں', message: 'ریستوران ٹیم کو پیغام بھیجیں' },
  ps: { menu: 'مېنو', search: 'لټون', settings: 'امستنې', choose: 'يو خوندور شی', delicious: 'وټاکئ.', searchMenu: 'مېنو ولټوئ', dishes: 'خواړه يا اجزا', filter: 'فلټر', found: 'خواړه وموندل شول', session: 'ستاسو د مېز سیشن', goodToKnow: 'د پوهېدو لپاره', visit: 'مېنو به د دې لیدنې لپاره پرانیستی وي.', table: 'مېز', timeLeft: 'پاتې وخت', language: 'ژبه', appearance: 'بڼه', darkOn: 'توره بڼه فعاله ده', darkOff: 'روښانه بڼه فعاله ده', call: 'رستورانت ته زنګ ووهئ', whatsapp: 'د رستورانت واټس اپ', email: 'رستورانت ته برېښنالیک', message: 'د رستورانت ټیم ته پیغام واستوئ' },
}
const formatPrice = (value) => Number(value).toLocaleString()

function FilterSheet({ categories, category, setCategory, minPrice, setMinPrice, maxPrice, setMaxPrice, photoOnly, setPhotoOnly, sort, setSort, close }) {
  const reset = () => { setCategory('all'); setMinPrice(''); setMaxPrice(''); setPhotoOnly(false); setSort('featured') }
  return <div className="menu-filter-backdrop" onClick={close} role="presentation">
    <section className="menu-filter-sheet" role="dialog" aria-modal="true" aria-label="Filter menu" onClick={(event) => event.stopPropagation()}>
      <div className="sheet-handle" />
      <header><div><span className="eyebrow">REFINE YOUR MENU</span><h2>Filters</h2></div><button onClick={close} aria-label="Close filters">×</button></header>
      <div className="filter-content">
        <label className="filter-label">Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">All categories</option>{categories.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <div className="filter-price-row"><label className="filter-label">Minimum price<input type="number" min="0" inputMode="numeric" value={minPrice} onChange={(event) => setMinPrice(event.target.value)} placeholder="No minimum" /></label><label className="filter-label">Maximum price<input type="number" min="0" inputMode="numeric" value={maxPrice} onChange={(event) => setMaxPrice(event.target.value)} placeholder="No maximum" /></label></div>
        <label className="filter-label">Sort by<select value={sort} onChange={(event) => setSort(event.target.value)}><option value="featured">Featured</option><option value="price-low">Price: low to high</option><option value="price-high">Price: high to low</option><option value="name">Name: A to Z</option></select></label>
        <button className={photoOnly ? 'filter-toggle active' : 'filter-toggle'} onClick={() => setPhotoOnly(!photoOnly)}><span><strong>Only dishes with photos</strong><small>Show menu images only</small></span><i><b /></i></button>
      </div>
      <footer><button className="sheet-reset" onClick={reset}>Reset all</button><button className="sheet-apply" onClick={close}>Show dishes</button></footer>
    </section>
  </div>
}

export default function CustomerApp({ session }) {
  const { token } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const page = location.pathname.split('/').at(-1)
  const activePage = pages[page] ? page : 'menu'
  const [menu, setMenu] = useState([])
  const [categories, setCategories] = useState([])
  const [restaurantContact, setRestaurantContact] = useState(() => ({
    phone: session.contact_phone || '',
    email: session.contact_email || '',
  }))
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('all')
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [photoOnly, setPhotoOnly] = useState(false)
  const [sort, setSort] = useState('featured')
  const [filterOpen, setFilterOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [isClosingDetail, setIsClosingDetail] = useState(false)
  const [selectedImageIndex, setSelectedImageIndex] = useState(0)
  const carouselRef = useRef(null)
  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('menu-theme') === 'dark')
  const [language, setLanguage] = useState(() => localStorage.getItem('palatotable-language') || 'en')
  const [sessionError, setSessionError] = useState(false)
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
      if (error || !data?.valid) { setSessionError(true); return }
      setCategories(data.categories || [])
      setMenu(data.items || [])
      setRestaurantContact({ phone: data.contact_phone || session.contact_phone || '', email: data.contact_email || session.contact_email || '' })
      setLoading(false)
    }
    load()
    return () => { alive = false }
  }, [session.contact_email, session.contact_phone, session.session_token, token])

  const remainingSeconds = Math.max(0, Math.floor((new Date(session.expires_at).getTime() - now) / 1000))
  const minutes = String(Math.floor(remainingSeconds / 60)).padStart(2, '0')
  const seconds = String(remainingSeconds % 60).padStart(2, '0')
  const expired = sessionError || remainingSeconds === 0
  const visible = useMemo(() => menu
    .filter((item) => {
      const matchesCategory = category === 'all' || item.category_id === category
      const matchesSearch = `${item.name} ${item.description || ''}`.toLowerCase().includes(query.toLowerCase())
      const matchesMinimum = !minPrice || Number(item.price) >= Number(minPrice)
      const matchesMaximum = !maxPrice || Number(item.price) <= Number(maxPrice)
      return matchesCategory && matchesSearch && matchesMinimum && matchesMaximum && (!photoOnly || item.image_url)
    })
    .sort((a, b) => sort === 'price-low' ? Number(a.price) - Number(b.price) : sort === 'price-high' ? Number(b.price) - Number(a.price) : sort === 'name' ? a.name.localeCompare(b.name) : 0), [category, maxPrice, menu, minPrice, photoOnly, query, sort])
  const activeFilters = Number(category !== 'all') + Number(Boolean(minPrice)) + Number(Boolean(maxPrice)) + Number(photoOnly) + Number(sort !== 'featured')
  const text = copy[language] || copy.en
  const setMenuLanguage = (value) => { setLanguage(value); localStorage.setItem('palatotable-language', value) }
  const contactPhone = restaurantContact.phone
  const contactEmail = restaurantContact.email
  const selectedImages = selected?.image_urls?.length ? selected.image_urls : selected?.image_url ? [selected.image_url] : []
  const selectedCategory = categories.find((item) => item.id === selected?.category_id)?.name
  const openItem = (item) => { setIsClosingDetail(false); setSelectedImageIndex(0); setSelected(item) }
  const closeItem = () => { setIsClosingDetail(true); window.setTimeout(() => { setSelected(null); setIsClosingDetail(false) }, 180) }
  const slideImage = (direction) => { const nextIndex = (selectedImageIndex + direction + selectedImages.length) % selectedImages.length; setSelectedImageIndex(nextIndex); carouselRef.current?.scrollTo({ left: carouselRef.current.clientWidth * nextIndex, behavior: 'smooth' }) }
  const syncImageIndex = () => { if (carouselRef.current) setSelectedImageIndex(Math.round(carouselRef.current.scrollLeft / carouselRef.current.clientWidth)) }
  const go = (target) => navigate({ pathname: `/scan/${token}/${target === 'menu' ? '' : target}`, search: location.search })
  const toggleTheme = () => { const next = !darkMode; setDarkMode(next); localStorage.setItem('menu-theme', next ? 'dark' : 'light') }
  const showItems = activePage !== 'settings'

  if (expired) return <main className="scan-error"><div className="brand-mark">P</div><span>⏱</span><h1>Session expired</h1><p>Your 15-minute table session has ended. Please scan the QR code on your table again.</p></main>

  return <main className={darkMode ? 'app-shell dark-mode-shell' : 'app-shell'}><section className={darkMode ? 'menu-app dark-theme' : 'menu-app'}>
    <header className="customer-topbar"><div className="palato-brand"><div className="brand-mark">P</div><div><strong>PalatoTable</strong><small>{session.restaurant_name}</small></div></div><div className="session-pill"><i /><span>{session.table_number}</span><b>{minutes}:{seconds}</b></div></header>
    <section className="content-area">
      {activePage === 'menu' && <><section className="menu-intro"><div><span className="eyebrow">DIGITAL TABLE MENU</span><h1>{text.choose}<br /><em>{text.delicious}</em></h1></div><button className="search-button" onClick={() => go('search')} aria-label="Search menu">⌕</button></section><div className="category-row">{[{ id: 'all', name: 'All dishes', icon: '✦' }, ...categories].map((item) => <button key={item.id} className={category === item.id ? 'category active' : 'category'} onClick={() => setCategory(item.id)}><span>{item.icon || '•'}</span>{item.name}</button>)}</div></>}
      {activePage === 'search' && <section className="search-page"><div className="section-heading"><div><span className="eyebrow">FIND YOUR FAVOURITE</span><h1>{text.searchMenu}</h1></div><button className="filter-button" onClick={() => setFilterOpen(true)}>☷ <span>{text.filter}</span>{activeFilters > 0 && <b>{activeFilters}</b>}</button></div><label className="search-field page-search"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder={text.dishes} /><button onClick={() => setQuery('')} aria-label="Clear search">{query ? '×' : ''}</button></label><div className="search-meta"><span>{visible.length} {text.found}</span>{activeFilters > 0 && <button onClick={() => setFilterOpen(true)}>Filters active</button>}</div></section>}
      {activePage === 'settings' && <section className="customer-settings"><div className="settings-intro"><span className="eyebrow">{text.session}</span><h1>{text.goodToKnow}</h1><p>{text.visit}</p></div><div className="session-summary"><div><span>{text.table}</span><strong>{session.table_number}</strong></div><div><span>{text.timeLeft}</span><strong>{minutes}:{seconds}</strong></div></div><div className="settings-list"><label className="customer-setting language-setting"><div><strong>{text.language}</strong><small>{languages[language]}</small></div><select value={language} onChange={(event) => setMenuLanguage(event.target.value)} aria-label={text.language}>{Object.entries(languages).map(([code, name]) => <option key={code} value={code}>{name}</option>)}</select></label><div className="customer-setting"><div><strong>{text.appearance}</strong><small>{darkMode ? text.darkOn : text.darkOff}</small></div><button className={darkMode ? 'theme-switch on' : 'theme-switch'} onClick={toggleTheme} aria-label="Toggle dark mode"><span /></button></div>{contactPhone && <a className="customer-setting link-setting" href={`tel:${contactPhone}`}><div><strong>{text.call}</strong><small>{contactPhone}</small></div><span>›</span></a>}{contactPhone && <a className="customer-setting link-setting" href={`https://wa.me/${contactPhone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer"><div><strong>{text.whatsapp}</strong><small>{text.message}</small></div><span>›</span></a>}{contactEmail && <a className="customer-setting link-setting" href={`mailto:${contactEmail}`}><div><strong>{text.email}</strong><small>{contactEmail}</small></div><span>›</span></a>}</div></section>}
      {showItems && (loading ? <div className="menu-loading" aria-live="polite"><div className="menu-loading-message"><span /><div><strong>Preparing your menu</strong><small>Fresh dishes are loading</small></div></div><div className={activePage === 'search' ? 'menu-skeleton-grid search-results-grid' : 'menu-skeleton-grid'}>{Array.from({ length: 6 }, (_, index) => <article className="dish-skeleton" key={index}><i /><div><b /><em /><em className="short" /><span /></div></article>)}</div></div> : <div className={activePage === 'search' ? 'menu-grid search-results-grid' : 'menu-grid'}>{visible.map((item) => <article className="dish-card" key={item.id}><button className="image-button" onClick={() => openItem(item)} aria-label={`View ${item.name}`}> <>{item.image_url ? <img src={item.image_url} alt="" /> : <div className="image-placeholder">🍽</div>}</></button><div className="dish-info"><h2>{item.name}</h2><p>{item.description || 'Prepared fresh for your table.'}</p><div className="price-line"><strong>{session.currency} {formatPrice(item.price)}</strong><button onClick={() => openItem(item)} aria-label={`View ${item.name}`}>+</button></div></div></article>)}</div>)}
      {showItems && !loading && !visible.length && <div className="empty-state"><span>⌕</span><h2>No dishes found</h2><p>Try another search or adjust your filters.</p><button onClick={() => { setQuery(''); setCategory('all'); setMinPrice(''); setMaxPrice(''); setPhotoOnly(false); setSort('featured') }}>Clear filters</button></div>}
    </section>
    <nav className="bottom-nav">{Object.entries(pages).map(([id, [, icon]]) => <button key={id} className={activePage === id ? 'nav-item active' : 'nav-item'} onClick={() => go(id)}><span>{icon}</span>{text[id]}</button>)}</nav>
  </section>{filterOpen && <FilterSheet categories={categories} category={category} setCategory={setCategory} minPrice={minPrice} setMinPrice={setMinPrice} maxPrice={maxPrice} setMaxPrice={setMaxPrice} photoOnly={photoOnly} setPhotoOnly={setPhotoOnly} sort={sort} setSort={setSort} close={() => setFilterOpen(false)} />}{selected && <div className={isClosingDetail ? 'overlay detail-overlay is-closing' : 'overlay detail-overlay'} role="presentation" onClick={closeItem}><article className={isClosingDetail ? 'detail-modal is-closing' : 'detail-modal'} role="dialog" aria-modal="true" aria-label={selected.name} onClick={(event) => event.stopPropagation()}><button className="close-detail" onClick={closeItem} aria-label="Close dish details">×</button><div className="detail-carousel" ref={carouselRef} onScroll={syncImageIndex}>{selectedImages.length ? selectedImages.map((image, index) => <img key={`${image}-${index}`} src={image} alt={`${selected.name} ${index + 1}`} />) : <div className="detail-placeholder">🍽</div>}</div>{selectedImages.length > 1 && <><div className="carousel-controls"><button onClick={() => slideImage(-1)} aria-label="Previous image">‹</button><button onClick={() => slideImage(1)} aria-label="Next image">›</button></div><div className="detail-gallery"><span>Swipe or use arrows · Photo {selectedImageIndex + 1} of {selectedImages.length}</span><i>{selectedImageIndex + 1}/{selectedImages.length}</i></div></>}<div className="detail-content"><span className="eyebrow">{selectedCategory || 'FROM THE MENU'}</span><h2>{selected.name}</h2><p>{selected.description || 'Prepared fresh for your table.'}</p><div className="detail-meta"><span>{session.table_number}</span><strong>{session.currency} {formatPrice(selected.price)}</strong></div></div></article></div>}</main>
}
