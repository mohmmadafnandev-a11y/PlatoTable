// One Supabase client for the whole app.
//
// Each surface used to build its own, with its own `storageKey`, so a sign-in on
// one was invisible to the other. The keys now match — that is what lets a
// restaurant owner sign in at /admin/login and still be signed in when the panel
// hands them to /admin/<slug> — but two GoTrueClient instances sharing one key is
// its own hazard: both refresh the same token, and the browser warns that
// concurrent use of one storage key has undefined behaviour. A refresh lost to
// that race signs the operator out mid-session.
//
// The restaurant admin's client (src/lib/supabase.js) is the canonical one: it
// uses Supabase's default storage key, so it is also the one the owner's session
// was written under. This module re-exports it rather than constructing another.
export { supabase } from '../../lib/supabase'
