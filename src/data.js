export const categories = [
  { id: 'all', label: 'All', icon: '✦' },
  { id: 'starters', label: 'Starters', icon: '🥗' },
  { id: 'mains', label: 'Mains', icon: '🍛' },
  { id: 'grills', label: 'Grills', icon: '🔥' },
  { id: 'drinks', label: 'Drinks', icon: '🍹' },
  { id: 'desserts', label: 'Desserts', icon: '🍰' },
]

export const fallbackMenuItems = [
  { id: 1, name: 'Smoky Chicken Karahi', category: 'mains', price: 1290, time: '25 min', image: 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?auto=format&fit=crop&w=900&q=85', description: 'Tender chicken simmered in a fragrant tomato, ginger and green chilli masala.', tag: 'Chef’s pick', is_offer: true, offer_price: 1090, is_available: true },
  { id: 2, name: 'Charcoal Chicken Tikka', category: 'grills', price: 790, time: '20 min', image: 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?auto=format&fit=crop&w=900&q=85', description: 'Yogurt-marinated chicken, chargrilled and served with mint chutney.', tag: 'Popular', is_offer: true, offer_price: 650, is_available: true },
  { id: 3, name: 'Creamy Chicken Pasta', category: 'mains', price: 890, time: '18 min', image: 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=900&q=85', description: 'Penne tossed with grilled chicken, parmesan and our signature cream sauce.', is_available: true },
  { id: 4, name: 'Crispy Dynamite Prawns', category: 'starters', price: 995, time: '15 min', image: 'https://images.unsplash.com/photo-1565680018434-b513d5e5fd47?auto=format&fit=crop&w=900&q=85', description: 'Golden fried prawns coated in a sweet-spicy dynamite sauce.', is_available: true },
  { id: 5, name: 'Garden Fattoush', category: 'starters', price: 490, time: '10 min', image: 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=900&q=85', description: 'Crisp greens, herbs, toasted pita and bright lemon sumac dressing.', is_available: true },
  { id: 6, name: 'Saffron Tres Leches', category: 'desserts', price: 540, time: '10 min', image: 'https://images.unsplash.com/photo-1551024506-0bccd828d307?auto=format&fit=crop&w=900&q=85', description: 'A cloud-soft milk cake finished with saffron cream and pistachio.', is_offer: true, offer_price: 430, is_available: true },
]

export const recentScans = [
  { table: 'Table 04', device: 'iPhone · Safari', time: 'Just now', status: 'Active' },
  { table: 'Table 11', device: 'Android · Chrome', time: '2 min ago', status: 'Active' },
  { table: 'Garden 02', device: 'iPhone · Safari', time: '7 min ago', status: 'Active' },
  { table: 'Table 08', device: 'Android · Chrome', time: '18 min ago', status: 'Expired' },
]
