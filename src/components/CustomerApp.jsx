import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { categories, fallbackMenuItems } from '../data'
import { supabase } from '../lib/supabase'

export default function CustomerApp() {
  const { token } = useParams()
  const [menuItems, setMenuItems] = useState(fallbackMenuItems)
  const [activeCategory, setActiveCategory] = useState('all')
  const [activeTab, setActiveTab] = useState('menu')
  const [query, setQuery] = useState('')
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectedItem, setSelectedItem] = useState(null)
  const [notice, setNotice] = useState('')
  const [dataSource, setDataSource] = useState('demo')

  useEffect(() => {
    if (!supabase) return
    const loadMenu = async () => {
      const { data, error } = await supabase.from('menu_items').select('*, categories(name)').eq('is_available', true).order('display_order')
      if (!error && data?.length) {
        setMenuItems(data.map((item) => ({ ...item, image: item.image_url, category: item.categories?.name?.toLowerCase().replaceAll(' ', '-') || 'mains', time: '15–25 min' })))
        setDataSource('live')
      }
    }
    loadMenu()
  }, [])

  const visibleItems = useMemo(() => menuItems.filter((item) => {
    const categoryMatch = activeCategory === 'all' || item.category === activeCategory
    const searchText = `${item.name} ${item.description || ''}`.toLowerCase()
    return categoryMatch && searchText.includes(query.toLowerCase())
  }), [activeCategory, menuItems, query])

  const showNotice = (message) => {
    setNotice(message)
    window.setTimeout(() => setNotice(''), 2500)
  }

  const displayItems = activeTab === 'offers' ? menuItems.filter((item) => item.is_offer) : visibleItems
  const tableName = token ? `Table ${token.slice(-2).toUpperCase()}` : 'Table 04'

  return <main className="app-shell">
    <section className="menu-app" aria-label="Saffron Table digital menu">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">S</div>
        <div className="brand-copy"><span className="eyebrow">WELCOME TO</span><strong>Saffron Table</strong></div>
        <button className="table-status" type="button" onClick={() => showNotice(`Your ${dataSource} menu session is active`)}><span className="live-dot" /><span>{tableName}</span><small>14:32</small></button>
      </header>

      <div className="hero-panel">
        <div className="hero-content"><span className="hero-kicker">THE SAFFRON EXPERIENCE</span><h1>Good food,<br /><em>great moments.</em></h1><p>A modern take on the flavours you already love.</p><button className="hero-button" type="button" onClick={() => document.getElementById('menu-list')?.scrollIntoView({ behavior: 'smooth' })}>Explore the menu <span>→</span></button></div>
        <div className="hero-image" role="img" aria-label="A plated restaurant dish" /><div className="hero-note"><span>✦</span> Made fresh,<br />just for you</div>
      </div>

      <section className="content-area">
        <div className="section-heading"><div><span className="eyebrow">OUR SELECTION</span><h2>{activeTab === 'offers' ? 'Today’s special offers' : activeTab === 'about' ? 'Our story' : 'Find your new favourite'}</h2></div><button className="search-button" type="button" onClick={() => setSearchOpen(true)} aria-label="Search menu">⌕</button></div>
        {activeTab === 'about' ? <article className="about-card"><span className="eyebrow">SINCE 2016</span><h2>Rooted in tradition. Made for today.</h2><p>At Saffron Table, every dish begins with carefully sourced ingredients and the recipes that bring people together. Take your time, savour every bite, and make yourself at home.</p><div><span>✦ Open daily</span><span>☏ Need help? Call staff</span><Link to="/admin/login">Staff access →</Link></div></article> : <>
          {activeTab === 'menu' && <div className="category-row" role="tablist" aria-label="Menu categories">{categories.map((category) => <button key={category.id} type="button" className={activeCategory === category.id ? 'category active' : 'category'} onClick={() => setActiveCategory(category.id)}><span>{category.icon}</span>{category.label}</button>)}</div>}
          {activeTab === 'offers' && <div className="offer-banner"><div><span className="offer-label">LIMITED TIME</span><strong>Up to 20% off<br />your table favourites</strong></div><button type="button" onClick={() => showNotice('Offers are automatically applied')}>View offers</button></div>}
          <div className="menu-grid" id="menu-list">{displayItems.map((item, index) => <article className="dish-card" key={item.id} style={{ animationDelay: `${index * 55}ms` }}><button className="image-button" type="button" onClick={() => setSelectedItem(item)} aria-label={`View ${item.name}`}><img src={item.image || 'https://images.unsplash.com/photo-1546069901-ba9599a7e63c?auto=format&fit=crop&w=900&q=80'} alt="" />{item.tag && <span className="dish-tag">{item.tag}</span>}{item.is_offer && <span className="discount-badge">OFFER</span>}</button><div className="dish-info"><div className="dish-line"><h3>{item.name}</h3><button type="button" className="plus-button" onClick={() => showNotice(`${item.name} added to your table order`)} aria-label={`Add ${item.name}`}>+</button></div><p>{item.description}</p><div className="price-line"><strong>PKR {(item.is_offer ? item.offer_price : item.price).toLocaleString()}</strong><span>◷ {item.time}</span></div></div></article>)}</div>
          {!displayItems.length && <div className="empty-state">No dishes found. Try another search.</div>}
        </>}
      </section>
      <nav className="bottom-nav" aria-label="Main navigation">{[['menu', '⌂', 'Menu'], ['offers', '✦', 'Offers'], ['search', '⌕', 'Search'], ['about', '◌', 'About']].map(([tab, icon, label]) => <button key={tab} type="button" className={activeTab === tab ? 'nav-item active' : 'nav-item'} onClick={() => tab === 'search' ? setSearchOpen(true) : setActiveTab(tab)}><span>{icon}</span>{label}</button>)}</nav>
    </section>

    {searchOpen && <div className="overlay" role="dialog" aria-modal="true" aria-label="Search the menu"><div className="search-modal"><div className="modal-top"><h2>Search menu</h2><button type="button" onClick={() => setSearchOpen(false)} aria-label="Close search">×</button></div><label className="search-field"><span>⌕</span><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="What are you craving?" /></label><p className="search-hint">Search for a dish or ingredient</p>{query && <div className="search-results">{visibleItems.map((item) => <button key={item.id} type="button" onClick={() => { setSelectedItem(item); setSearchOpen(false) }}><img src={item.image} alt="" /><span><strong>{item.name}</strong><small>PKR {item.price.toLocaleString()}</small></span><b>→</b></button>)}</div>}</div></div>}
    {selectedItem && <div className="overlay" role="dialog" aria-modal="true" aria-label={selectedItem.name}><article className="detail-modal"><button className="close-detail" type="button" onClick={() => setSelectedItem(null)} aria-label="Close details">×</button><img src={selectedItem.image} alt={selectedItem.name} /><div className="detail-content"><span className="eyebrow">{selectedItem.category}</span><h2>{selectedItem.name}</h2><p>{selectedItem.description}</p><div className="detail-bottom"><strong>PKR {(selectedItem.offer_price || selectedItem.price).toLocaleString()}</strong><button type="button" onClick={() => { showNotice(`${selectedItem.name} added`); setSelectedItem(null) }}>Add to table <span>+</span></button></div></div></article></div>}
    {notice && <div className="toast" role="status">✓ {notice}</div>}
  </main>
}
