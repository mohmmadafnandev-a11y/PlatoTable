import { useMemo, useState } from 'react'
import { Check, Pencil, Plus, Trash2, UtensilsCrossed, X } from 'lucide-react'
import { logActivity, useTenantRows } from '../lib/data'
import { money, plainNumber } from '../lib/format'
import { Card, EmptyState, Field, Notice, SectionHead, Spinner, inputClass } from './ui'

// Editing a restaurant's menu from the platform side.
//
// This exists because the alternative is worse: a support call that ends with
// "ask them to change it" for something as small as a price with a typo, or a
// mislabelled dish, or an item that needs hiding for an evening. The operator can
// now do it, and every change lands in the activity log like any other action.
//
// What it deliberately does NOT do: touch images. Those live in Storage under the
// restaurant's folder with policies written for the restaurant's own admin, and
// widening that is a separate decision from letting staff correct a price.


function ItemForm({ initial, categories, onSave, onCancel, saving }) {
  const [form, setForm] = useState(() => ({
    name: initial?.name || '',
    description: initial?.description || '',
    price: initial?.price === undefined || initial?.price === null ? '' : String(initial.price),
    category_id: initial?.category_id || '',
    is_available: initial?.is_available ?? true,
    display_order: initial?.display_order ?? 0,
  }))
  const update = (patch) => setForm((current) => ({ ...current, ...patch }))
  const valid = form.name.trim() && form.price !== '' && Number(form.price) >= 0

  return (
    <form
      className="grid gap-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4 sm:grid-cols-2"
      onSubmit={(event) => { event.preventDefault(); if (valid) onSave({ ...form, name: form.name.trim(), price: Number(form.price), category_id: form.category_id || null, display_order: Number(form.display_order) || 0 }) }}
    >
      <Field label="Item name">
        <input autoFocus value={form.name} onChange={(event) => update({ name: event.target.value })} className={inputClass} placeholder="Chicken Karahi" />
      </Field>
      <Field label="Price">
        <input required type="number" min="0" step="0.01" value={form.price} onChange={(event) => update({ price: event.target.value })} className={inputClass} placeholder="0.00" />
      </Field>
      <Field label="Category">
        <select value={form.category_id} onChange={(event) => update({ category_id: event.target.value })} className={inputClass}>
          <option value="">Uncategorised</option>
          {categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}
        </select>
      </Field>
      <Field label="Display order" hint="Lower numbers appear first.">
        <input type="number" value={form.display_order} onChange={(event) => update({ display_order: event.target.value })} className={inputClass} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Description">
          <textarea rows="2" value={form.description} onChange={(event) => update({ description: event.target.value })} className={`${inputClass} h-auto py-2`} placeholder="What the guest sees under the name." />
        </Field>
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-600 sm:col-span-2">
        <input type="checkbox" checked={form.is_available} onChange={(event) => update({ is_available: event.target.checked })} className="h-4 w-4 accent-indigo-600" />
        Available to order
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <button disabled={!valid || saving} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-3 py-2.5 text-sm font-semibold text-white disabled:opacity-50">
          <Check size={16} />{saving ? 'Saving…' : 'Save item'}
        </button>
        <button type="button" onClick={onCancel} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm font-semibold text-slate-600">
          <X size={16} />Cancel
        </button>
      </div>
    </form>
  )
}

export default function RestaurantMenuManager({ restaurant, profile }) {
  const items = useTenantRows(restaurant.id, 'menu_items', { order: 'display_order' })
  const categories = useTenantRows(restaurant.id, 'categories', { order: 'display_order' })

  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [newCategory, setNewCategory] = useState('')
  const [renaming, setRenaming] = useState(null)
  const [query, setQuery] = useState('')

  const categoryName = useMemo(() => Object.fromEntries(categories.rows.map((row) => [row.id, row.name])), [categories.rows])

  // Every edit is recorded against the restaurant, so a change nobody expected
  // can be traced back to the person who made it.
  const log = (entry, details) => logActivity({ superAdminId: profile?.id, restaurantId: restaurant.id, action: entry, details })

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle ? items.rows.filter((item) => `${item.name} ${item.description || ''}`.toLowerCase().includes(needle)) : items.rows
  }, [items.rows, query])

  const report = (failure, message) => setFeedback(failure ? { tone: 'danger', text: failure.message } : { tone: 'success', text: message })

  const saveItem = async (values) => {
    setSaving(true)
    const { error } = editing?.id ? await items.update(editing.id, values) : await items.insert(values)
    setSaving(false)
    report(error, editing?.id ? `${values.name} updated.` : `${values.name} added.`)
    if (!error) {
      log(editing?.id ? 'menu_item_updated' : 'menu_item_created', { name: values.name, price: values.price })
      setEditing(null)
      setCreating(false)
    }
  }

  const toggleAvailable = async (item) => {
    const { error } = await items.update(item.id, { is_available: !item.is_available })
    report(error, error ? '' : `${item.name} is now ${item.is_available ? 'hidden from' : 'shown on'} the menu.`)
    if (!error) log('menu_item_availability_changed', { name: item.name, is_available: !item.is_available })
  }

  const removeItem = async (item) => {
    if (!window.confirm(`Delete ${item.name} from the menu? This cannot be undone.`)) return
    const { error } = await items.remove(item.id)
    report(error, `${item.name} deleted.`)
    if (!error) log('menu_item_deleted', { name: item.name })
  }

  const addCategory = async (event) => {
    event.preventDefault()
    const name = newCategory.trim()
    if (!name) return
    const { error } = await categories.insert({ name, display_order: categories.rows.length + 1, is_active: true })
    setNewCategory('')
    report(error, `${name} added.`)
    if (!error) log('menu_category_created', { name })
  }

  const renameCategory = async (category) => {
    const name = (renaming?.name || '').trim()
    if (!name || name === category.name) return setRenaming(null)
    const { error } = await categories.update(category.id, { name })
    setRenaming(null)
    report(error, `Category renamed to ${name}.`)
    if (!error) log('menu_category_renamed', { from: category.name, to: name })
  }

  const removeCategory = async (category) => {
    const count = items.rows.filter((item) => item.category_id === category.id).length
    const detail = count ? ` Its ${plainNumber(count)} item${count === 1 ? '' : 's'} will stay on the menu as uncategorised.` : ''
    if (!window.confirm(`Delete the ${category.name} category?${detail}`)) return
    const { error } = await categories.remove(category.id)
    report(error, `${category.name} deleted.`)
    if (!error) log('menu_category_deleted', { name: category.name, items_kept: count })
  }

  return (
    <div className="grid gap-5">
      <SectionHead
        eyebrow="MENU CONTROL"
        title="Menu & categories"
        description="Correct a price, rename a dish, hide something for the evening — without waiting on the restaurant."
        action={
          <button onClick={() => { setCreating(true); setEditing(null) }} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white">
            <Plus size={16} />Add item
          </button>
        }
      />

      {feedback && <Notice tone={feedback.tone}>{feedback.text}</Notice>}
      {items.error && <Notice tone="danger">{items.error}</Notice>}

      <div className="flex flex-wrap gap-3">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search this menu" className={`${inputClass} w-64`} />
        <span className="self-center text-sm text-slate-500">{plainNumber(visible.length)} of {plainNumber(items.rows.length)} items · {plainNumber(categories.rows.length)} categories</span>
      </div>

      <Card className="p-6">
        <h2 className="font-semibold text-slate-900">Categories</h2>
        <p className="mt-1 text-sm text-slate-500">The groups the customer's menu is built from. Deleting one keeps its items, uncategorised.</p>
        <div className="mt-4 grid gap-2">
          {categories.loading
            ? <Spinner label="Loading categories" />
            : categories.rows.length
              ? categories.rows.map((category) => (
                <div key={category.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-slate-200 px-3 py-2">
                  {renaming?.id === category.id
                    ? <input autoFocus value={renaming.name} onChange={(event) => setRenaming({ id: category.id, name: event.target.value })} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); renameCategory(category) } if (event.key === 'Escape') setRenaming(null) }} className={`${inputClass} h-9 w-56`} />
                    : <strong className="text-sm font-semibold text-slate-800">{category.name}</strong>}
                  <span className="text-xs text-slate-400">{plainNumber(items.rows.filter((item) => item.category_id === category.id).length)} items</span>
                  <div className="ml-auto flex gap-2">
                    {renaming?.id === category.id
                      ? <button onClick={() => renameCategory(category)} className="rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700">Save</button>
                      : <button onClick={() => setRenaming({ id: category.id, name: category.name })} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600"><Pencil size={13} />Rename</button>}
                    <button onClick={() => removeCategory(category)} className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-semibold text-red-600"><Trash2 size={13} />Delete</button>
                  </div>
                </div>
              ))
              : <p className="text-sm text-slate-500">No categories yet. Menu items can still be added without one.</p>}
        </div>
        <form onSubmit={addCategory} className="mt-4 flex flex-wrap gap-2">
          <input value={newCategory} onChange={(event) => setNewCategory(event.target.value)} placeholder="New category name" className={`${inputClass} w-64`} />
          <button disabled={!newCategory.trim()} className="rounded-lg border border-slate-200 px-3 py-2.5 text-sm font-semibold text-slate-700 disabled:opacity-50">Add category</button>
        </form>
      </Card>

      {(creating || editing) && (
        <ItemForm
          key={editing?.id || 'new'}
          initial={editing}
          categories={categories.rows}
          saving={saving}
          onSave={saveItem}
          onCancel={() => { setCreating(false); setEditing(null) }}
        />
      )}

      <Card className="overflow-hidden p-0">
        {items.loading && !items.rows.length
          ? <Spinner label="Loading menu" />
          : visible.length
            ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="p-4 font-semibold">Item</th>
                      <th className="p-4 font-semibold">Category</th>
                      <th className="p-4 font-semibold">Price</th>
                      <th className="p-4 font-semibold">On the menu</th>
                      <th className="p-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {visible.map((item) => (
                      <tr key={item.id} className="border-t border-slate-100 align-top">
                        <td className="p-4">
                          <strong className="block font-medium text-slate-800">{item.name}</strong>
                          {item.description && <small className="mt-1 block max-w-md text-xs text-slate-500">{item.description}</small>}
                        </td>
                        <td className="p-4 text-slate-600">{item.category_id ? categoryName[item.category_id] || '—' : <span className="text-amber-700">Uncategorised</span>}</td>
                        <td className="p-4 font-medium text-slate-800">{money(item.price)}</td>
                        <td className="p-4">
                          <button onClick={() => toggleAvailable(item)} className={`rounded-full px-2.5 py-1 text-xs font-semibold ${item.is_available ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-600'}`}>
                            {item.is_available ? 'Available' : 'Hidden'}
                          </button>
                        </td>
                        <td className="p-4">
                          <div className="flex justify-end gap-2">
                            <button onClick={() => { setEditing(item); setCreating(false) }} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600"><Pencil size={13} />Edit</button>
                            <button onClick={() => removeItem(item)} className="inline-flex items-center gap-1.5 rounded-md border border-red-200 px-2.5 py-1.5 text-xs font-semibold text-red-600"><Trash2 size={13} />Delete</button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
            : <EmptyState icon={UtensilsCrossed} title={items.rows.length ? 'Nothing matches that search' : 'No menu items yet'} description={items.rows.length ? 'Try a different word.' : 'Add the first item to start this restaurant’s menu.'} />}
      </Card>
    </div>
  )
}
