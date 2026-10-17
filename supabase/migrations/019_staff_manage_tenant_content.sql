-- Let platform staff edit what a restaurant has built.
--
-- Until now the tenant tables were read-only for staff: the panel could list a
-- menu or a set of table codes, but correcting a price with a typo, renaming a
-- dish, hiding an item for the evening, or replacing a QR token that had leaked
-- onto a poster all ended in "ask the restaurant to do it" — which is the wrong
-- answer when the restaurant is on the phone asking for help.
--
-- Each policy grants the whole row to `authenticated` gated on
-- `is_platform_staff()`. The gate is the same predicate the SELECT policies
-- already use, so a signed-in restaurant owner still sees only their own rows —
-- and now a staff session can write them.
--
-- `offer_items` has no restaurant_id of its own, so its policy reaches the
-- restaurant through the offer it belongs to. offer_items is a child of offers
-- in the same way menu_items is a child of categories, and the same shape is
-- used for the restaurant-owner policy that predates this file.
--
-- Written as `for all`, `using` and `with check` together, so one policy covers
-- read, insert, update and delete: a staff member who may correct an item should
-- also be able to take it off the menu entirely, and splitting that across four
-- policies would only make it possible to have three of them active.

create policy menu_items_platform_manage on public.menu_items
  for all to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

create policy categories_platform_manage on public.categories
  for all to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

create policy qr_tokens_platform_manage on public.qr_tokens
  for all to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

create policy settings_platform_manage on public.settings
  for all to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

create policy restaurant_admins_platform_manage on public.restaurant_admins
  for all to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

create policy offers_platform_manage on public.offers
  for all to authenticated
  using (public.is_platform_staff())
  with check (public.is_platform_staff());

create policy offer_items_platform_manage on public.offer_items
  for all to authenticated
  using (
    exists (
      select 1 from public.offers offer
      where offer.id = offer_items.offer_id
        and public.is_platform_staff()
    )
  )
  with check (
    exists (
      select 1 from public.offers offer
      where offer.id = offer_items.offer_id
        and public.is_platform_staff()
    )
  );
