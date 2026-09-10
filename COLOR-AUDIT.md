# Color utility audit

## Scope

Searched every file under `src/` for these requested Tailwind utility patterns:

- `text-gray-400`
- `text-gray-300`
- `text-gray-200`
- `text-slate-400`
- `text-slate-300`
- `placeholder-gray-400`
- `placeholder-gray-300`
- `text-opacity`
- `opacity-<number>`

## Results

**0 matches in 0 files.**

This React/Vite project does not use Tailwind CSS classes or Tailwind configuration. Its color system is custom CSS, primarily in:

- `src/App.css`
- `src/components/Admin.css`
- `src/index.css`

Therefore there were no Tailwind `text-gray-*`, `text-slate-*`, placeholder, or utility-opacity instances to replace.

## CSS accessibility changes

The equivalent custom-CSS contrast and control fixes are in:

- `src/App.css` — customer light/dark text, contact rows, placeholders, focus indicators, dark controls.
- `src/components/Admin.css` — admin input values, disabled values, labels, placeholders, and focus indicators.

## Performance follow-up

Menu-card images now use native browser lazy loading and asynchronous image decoding in:

- `src/components/CustomerApp.jsx`
- `src/components/AdminApp.jsx`

This prevents a long demo menu from downloading all remote food images immediately.
