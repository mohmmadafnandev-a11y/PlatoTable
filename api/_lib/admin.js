import { createClient } from '@supabase/supabase-js'

// The service-role client, in one place.
//
// It bypasses row level security, so every endpoint uses it and every endpoint
// has to do its own authorisation — see `requireActor` in ./actor.js for the
// rule those callers share. Kept in its own module so that helpers that are not
// about a payment provider (the rate limiter, credentials, the restaurant
// delete) do not have to import one to get a database client.
export const admin = createClient(process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
