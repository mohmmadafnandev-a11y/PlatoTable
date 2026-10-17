// The platform's own name.
//
// A constant rather than an environment variable, because it is the one string
// the product cannot get wrong: it appears in the browser tab, the sign-in
// screen, the operator header, and the "from" line of every invoice. It used to
// be read from VITE_APP_NAME with this as a fallback, which meant a typo in one
// local file silently renamed the whole platform — and did, in a file that
// shipped with a typo in the name.
//
// White-labelling, if it is ever wanted, changes this line.
export const APP_NAME = 'Plato Table'

/** Customer-facing product line, used wherever the name is followed by what it is. */
export const APP_TAGLINE = 'Digital menu for your restaurant'
