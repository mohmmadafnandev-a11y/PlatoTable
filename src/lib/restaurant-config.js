export const restaurantName = import.meta.env.VITE_RESTAURANT_NAME || 'Restaurant'
export const restaurantSlug = import.meta.env.VITE_RESTAURANT_SLUG || ''
export const adminAuthEmail = restaurantSlug ? `admin@${restaurantSlug}.local` : ''
