import brandIcon from '../assets/brand-icon.png'
import './BrandMark.css'

// The Plato Table mark, used wherever a panel shows the product itself rather
// than the restaurant.
//
// The artwork is a finished badge: an orange rounded tile with the cloche,
// phone and plate on it, cropped tight to its own edges. So it is rendered
// as-is — no frame, no white backing, no shadow. That matters because the tile
// corners are transparent in the PNG, which means an opaque backing would show
// through as a coloured square behind the badge, and it also means one asset
// works on the cream marketing pages and the dark admin sidebars alike.
//
// `size` is the rendered square edge in pixels, passed as width/height
// attributes so the box is reserved before the image loads.
export default function BrandMark({ size = 40, className, style }) {
  return (
    <img
      className={className ? `brand-mark ${className}` : 'brand-mark'}
      src={brandIcon}
      alt=""
      width={size}
      height={size}
      style={style}
    />
  )
}
