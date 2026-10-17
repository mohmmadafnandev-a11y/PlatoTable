-- Instant notification delivery.
--
-- Nothing announced a notification to a browser that was already open. Both
-- panels polled, so a platform alert could sit unseen for up to a minute and a
-- restaurant's chime could arrive long after the message was sent — which is
-- indistinguishable, from the operator's side, from a broken bell.
--
-- Realtime publishes the row; each panel responds by re-reading through its own
-- RPC. The socket is a signal and never a source of truth, so the audience split,
-- the per-recipient read state, and the grace period stay exactly where they are.
--
-- Row-level security still applies: a restaurant's owner only receives rows its
-- own SELECT policy allows (its own, plus broadcasts), and platform alerts only
-- reach platform staff.

alter publication supabase_realtime add table public.system_notifications;
