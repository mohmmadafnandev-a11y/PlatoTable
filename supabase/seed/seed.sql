-- Development data for the premium Saffron Table demo.
insert into public.restaurants (id, name, subdomain, owner_email, phone, address, currency)
values ('11111111-1111-4111-8111-111111111111', 'Saffron Table', 'saffron-table', 'hello@saffrontable.pk', '+92 300 123 4567', '12 Main Boulevard, Lahore', 'PKR')
on conflict (id) do nothing;

insert into public.settings (restaurant_id, qr_expiry_minutes, menu_display_style, theme_color)
values ('11111111-1111-4111-8111-111111111111', 15, 'grid', '#A13524')
on conflict (restaurant_id) do nothing;

insert into public.categories (id, restaurant_id, name, icon, display_order) values
('21111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'Starters', '🥗', 1),
('21111111-1111-4111-8111-111111111112', '11111111-1111-4111-8111-111111111111', 'Mains', '🍛', 2),
('21111111-1111-4111-8111-111111111113', '11111111-1111-4111-8111-111111111111', 'Grills', '🔥', 3),
('21111111-1111-4111-8111-111111111114', '11111111-1111-4111-8111-111111111111', 'Drinks', '🍹', 4),
('21111111-1111-4111-8111-111111111115', '11111111-1111-4111-8111-111111111111', 'Desserts', '🍰', 5)
on conflict (id) do nothing;

insert into public.menu_items (restaurant_id, category_id, name, description, price, image_url, is_offer, offer_price, offer_description, display_order) values
('11111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111112', 'Smoky Chicken Karahi', 'Tender chicken simmered in a fragrant tomato, ginger and green chilli masala.', 1290, 'https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?auto=format&fit=crop&w=900&q=85', true, 1090, 'Chef’s table special', 1),
('11111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111113', 'Charcoal Chicken Tikka', 'Yogurt-marinated chicken, chargrilled and served with mint chutney.', 790, 'https://images.unsplash.com/photo-1599487488170-d11ec9c172f0?auto=format&fit=crop&w=900&q=85', true, 650, 'Dine-in favourite', 2),
('11111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111112', 'Creamy Chicken Pasta', 'Penne tossed with grilled chicken, parmesan and our signature cream sauce.', 890, 'https://images.unsplash.com/photo-1473093295043-cdd812d0e601?auto=format&fit=crop&w=900&q=85', false, null, null, 3),
('11111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111111', 'Crispy Dynamite Prawns', 'Golden fried prawns coated in a sweet-spicy dynamite sauce.', 995, 'https://images.unsplash.com/photo-1565680018434-b513d5e5fd47?auto=format&fit=crop&w=900&q=85', false, null, null, 4),
('11111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111111', 'Garden Fattoush', 'Crisp greens, herbs, toasted pita and bright lemon sumac dressing.', 490, 'https://images.unsplash.com/photo-1512621776951-a57141f2eefd?auto=format&fit=crop&w=900&q=85', false, null, null, 5),
('11111111-1111-4111-8111-111111111111', '21111111-1111-4111-8111-111111111115', 'Saffron Tres Leches', 'A cloud-soft milk cake finished with saffron cream and pistachio.', 540, 'https://images.unsplash.com/photo-1551024506-0bccd828d307?auto=format&fit=crop&w=900&q=85', true, 430, 'Sweet ending special', 6);

insert into public.qr_tokens (restaurant_id, table_number, token) values
('11111111-1111-4111-8111-111111111111', 'Table 01', 'SFR-TBL-001'),
('11111111-1111-4111-8111-111111111111', 'Table 02', 'SFR-TBL-002'),
('11111111-1111-4111-8111-111111111111', 'Garden 01', 'SFR-GDN-001'),
('11111111-1111-4111-8111-111111111111', 'VIP Lounge', 'SFR-VIP-001')
on conflict (restaurant_id, table_number) do nothing;
