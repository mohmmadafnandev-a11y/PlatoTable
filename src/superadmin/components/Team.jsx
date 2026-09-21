import { useCallback, useEffect, useState } from 'react'
import { KeyRound, Save, Trash2, UserPlus, Users } from 'lucide-react'
import { supabase } from '../lib/supabase'
import { logActivity } from '../lib/data'
import { PASSWORD_MIN, passwordError, suggestPassword } from '../../../shared/slug.js'
import { dateTime, shortDate } from '../lib/format'
import { Card, EmptyState, Field, Notice, SectionHead, Spinner, StatusBadge, inputClass } from './ui'

const ROLE_HELP = {
  super_admin: 'Full access, including team management and platform settings.',
  support: 'Can view restaurants and send notifications. Cannot manage billing or the team.',
  billing: 'Can manage subscriptions, payments, and plans. Cannot manage the team.',
}

function InviteForm({ onInvited, superAdminId, onCancel }) {
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [role, setRole] = useState('support')
  const [password, setPassword] = useState(() => suggestPassword(16))
  const [state, setState] = useState({ saving: false, message: '', tone: 'info' })
  const [handedOver, setHandedOver] = useState(null)

  const submit = async (event) => {
    event.preventDefault()
    const problem = passwordError(password)
    if (problem) return setState({ saving: false, message: problem, tone: 'danger' })

    setState({ saving: true, message: '', tone: 'info' })
    const { data: { session } } = await supabase.auth.getSession()
    const result = await fetch('/api/team/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
      body: JSON.stringify({ email, name, role, password }),
    })
    const payload = await result.json().catch(() => ({}))
    if (!result.ok) return setState({ saving: false, message: payload.error || `Request failed (${result.status}).`, tone: 'danger' })

    await logActivity({
      superAdminId,
      action: payload.reusedExistingAccount ? 'team_member_updated' : 'team_member_invited',
      details: { email, role },
    })
    setHandedOver({ email, password, reused: payload.reusedExistingAccount })
    setState({ saving: false, message: '', tone: 'info' })
    onInvited()
  }

  // The password is shown once, here, because nothing emails it. It is never
  // stored anywhere we can read it back from.
  if (handedOver) {
    return (
      <Card className="p-6">
        <h2 className="font-semibold text-slate-900">{handedOver.reused ? 'Password reset' : 'Account created'}</h2>
        <p className="mt-1 text-sm text-slate-500">
          {handedOver.reused
            ? 'That email already had an account, so its password was reset instead of creating a duplicate.'
            : 'Share these credentials with your team member. This password is shown only once.'}
        </p>
        <div className="mt-5 grid gap-3 rounded-lg bg-slate-50 p-4 text-sm">
          <div><span className="text-xs font-semibold uppercase tracking-wide text-slate-400">Email</span><p className="mt-1 font-medium text-slate-800">{handedOver.email}</p></div>
          <div><span className="text-xs font-semibold uppercase tracking-wide text-slate-400">One-time password</span><p className="mt-1 font-mono text-slate-800">{handedOver.password}</p></div>
        </div>
        <p className="mt-4 text-sm text-slate-500">They should change it after signing in at /admin.</p>
        <button onClick={onCancel} className="mt-5 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white">Done</button>
      </Card>
    )
  }

  return (
    <Card className="p-6">
      <h2 className="font-semibold text-slate-900">Add a team member</h2>
      <p className="mt-1 text-sm text-slate-500">Creates a real sign-in account and links it to the team.</p>
      <form onSubmit={submit} className="mt-6 grid gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <input className={inputClass} value={name} onChange={(event) => setName(event.target.value)} placeholder="Sara Khan" required />
        </Field>
        <Field label="Email address">
          <input type="email" className={inputClass} value={email} onChange={(event) => setEmail(event.target.value)} placeholder="sara@example.com" required />
        </Field>
        <Field label="Role">
          <select className={inputClass} value={role} onChange={(event) => setRole(event.target.value)}>
            {Object.keys(ROLE_HELP).map((value) => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}
          </select>
        </Field>
        <Field label="Password" hint={`At least ${PASSWORD_MIN} characters. Generated for you; edit or replace it.`}>
          <div className="flex gap-2">
            <input className={inputClass} value={password} onChange={(event) => setPassword(event.target.value)} />
            <button type="button" onClick={() => setPassword(suggestPassword(16))} className="whitespace-nowrap rounded-lg border border-slate-200 px-3 text-xs font-semibold text-slate-600">New</button>
          </div>
        </Field>
        <p className="text-sm text-slate-500 sm:col-span-2">{ROLE_HELP[role]}</p>
        {state.message && <div className="sm:col-span-2"><Notice tone={state.tone}>{state.message}</Notice></div>}
        <div className="flex gap-3 sm:col-span-2">
          <button disabled={state.saving} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60">
            <UserPlus size={16} />{state.saving ? 'Creating…' : 'Create account'}
          </button>
          <button type="button" onClick={onCancel} className="rounded-lg border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-600">Cancel</button>
        </div>
      </form>
    </Card>
  )
}

export default function Team({ profile }) {
  const [members, setMembers] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [inviting, setInviting] = useState(false)
  const [feedback, setFeedback] = useState(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(() => {
    if (!supabase) return Promise.resolve()
    return supabase
      .from('super_admins')
      .select('id, user_id, name, email, role, is_active, created_at')
      .order('created_at', { ascending: true })
      .then(({ data, error: requestError }) => {
        if (requestError) setError(requestError.message)
        else { setMembers(data || []); setError('') }
        setLoading(false)
      })
  }, [])

  useEffect(() => { load() }, [load])

  const patch = async (member, changes, action) => {
    setBusy(member.id)
    const { error: failure } = await supabase.from('super_admins').update(changes).eq('id', member.id)
    setBusy('')
    if (failure) return setFeedback({ tone: 'danger', text: failure.message })
    await logActivity({ superAdminId: profile?.id, action, details: { email: member.email, ...changes } })
    setFeedback({ tone: 'success', text: `${member.name || member.email} updated.` })
    load()
  }

  const remove = async (member) => {
    if (member.user_id === profile?.user_id) return setFeedback({ tone: 'danger', text: 'You cannot remove your own account.' })
    if (!window.confirm(`Remove ${member.name || member.email} from the team? Their sign-in will stop working.`)) return
    setBusy(member.id)
    const { data: { session } } = await supabase.auth.getSession()
    const result = await fetch('/api/team/invite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session?.access_token || ''}` },
      body: JSON.stringify({ action: 'remove', userId: member.user_id }),
    })
    const payload = await result.json().catch(() => ({}))
    setBusy('')
    if (!result.ok) return setFeedback({ tone: 'danger', text: payload.error || `Request failed (${result.status}).` })
    await logActivity({ superAdminId: profile?.id, action: 'team_member_removed', details: { email: member.email } })
    setFeedback({ tone: 'success', text: `${member.name || member.email} removed.` })
    load()
  }

  const sendReset = async (member) => {
    setBusy(member.id)
    // Goes through the signed-out reset flow, so it never reveals whether the
    // address exists and the new password is chosen by the owner, not by us.
    const { error: failure } = await supabase.auth.resetPasswordForEmail(member.email)
    setBusy('')
    if (failure) return setFeedback({ tone: 'danger', text: failure.message })
    setFeedback({ tone: 'success', text: `Password reset email sent to ${member.email}.` })
  }

  return (
    <>
      <SectionHead
        eyebrow="ACCESS MANAGEMENT"
        title="Team members"
        description="Who can sign in to this panel, and what each of them may do."
        action={
          !inviting && (
            <button onClick={() => setInviting(true)} className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-semibold text-white shadow-lg shadow-indigo-600/20 transition hover:bg-indigo-700">
              <UserPlus size={16} />Add team member
            </button>
          )
        }
      />

      {feedback && <div className="mb-4"><Notice tone={feedback.tone}>{feedback.text}</Notice></div>}
      {error && <div className="mb-4"><Notice tone="danger">{error}</Notice></div>}

      <div className="mb-6">
        <Notice tone="info">
          <strong className="font-semibold">Roles:</strong>{' '}
          {Object.entries(ROLE_HELP).map(([role, help]) => `${role.replace('_', ' ')} — ${help}`).join(' ')}
        </Notice>
      </div>

      {inviting && (
        <div className="mb-6">
          <InviteForm superAdminId={profile?.id} onInvited={load} onCancel={() => setInviting(false)} />
        </div>
      )}

      <Card className="overflow-hidden p-0">
        {loading && !members.length
          ? <Spinner label="Loading team" />
          : members.length
            ? (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="p-4 font-semibold">Member</th>
                      <th className="p-4 font-semibold">Role</th>
                      <th className="p-4 font-semibold">Status</th>
                      <th className="p-4 font-semibold">Added</th>
                      <th className="p-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((member) => {
                      const isSelf = member.user_id === profile?.user_id
                      const rowBusy = busy === member.id
                      return (
                        <tr key={member.id} className="border-t border-slate-100 align-top transition hover:bg-indigo-50/40">
                          <td className="p-4">
                            <strong className="block font-semibold text-slate-900">
                              {member.name || 'Unnamed'}{isSelf && <span className="ml-2 rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-semibold text-indigo-700">You</span>}
                            </strong>
                            <small className="mt-1 block text-xs text-slate-500">{member.email}</small>
                          </td>
                          <td className="p-4">
                            <select
                              value={member.role}
                              disabled={rowBusy || (isSelf && member.role === 'super_admin')}
                              onChange={(event) => patch(member, { role: event.target.value }, 'team_role_changed')}
                              className="h-10 rounded-lg border border-slate-200 bg-white px-2 text-sm capitalize text-slate-700 disabled:bg-slate-50 disabled:text-slate-400"
                            >
                              {Object.keys(ROLE_HELP).map((value) => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}
                            </select>
                          </td>
                          <td className="p-4"><StatusBadge status={member.is_active ? 'active' : 'canceled'} /></td>
                          <td className="p-4 text-slate-500">
                            {shortDate(member.created_at)}
                            <small className="mt-1 block text-xs text-slate-400">{dateTime(member.created_at)}</small>
                          </td>
                          <td className="p-4">
                            <div className="flex flex-wrap justify-end gap-2">
                              <button
                                disabled={rowBusy || isSelf}
                                onClick={() => patch(member, { is_active: !member.is_active }, member.is_active ? 'team_member_deactivated' : 'team_member_activated')}
                                className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-40"
                              >
                                {member.is_active ? 'Deactivate' : 'Activate'}
                              </button>
                              <button disabled={rowBusy} onClick={() => sendReset(member)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-700 disabled:opacity-40">
                                <KeyRound size={13} />Reset password
                              </button>
                              <button disabled={rowBusy || isSelf} onClick={() => remove(member)} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-xs font-semibold text-red-600 disabled:opacity-40">
                                <Trash2 size={13} />Remove
                              </button>
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
            : <EmptyState icon={Users} title="No team members" description="Add a colleague to share the workload." />}
      </Card>

      <div className="mt-6">
        <Notice tone="info">
          Deactivating a member blocks the panel immediately but leaves their sign-in intact;
          removing them deletes the sign-in entirely. You cannot deactivate or remove your own account,
          which is what keeps the last Super Admin from locking everyone out.
        </Notice>
      </div>

      <p className="mt-4 flex items-center gap-2 text-xs text-slate-400"><Save size={13} />Changes are written straight away and recorded in the activity log.</p>
    </>
  )
}
