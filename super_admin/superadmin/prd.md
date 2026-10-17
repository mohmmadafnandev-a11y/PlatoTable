# 🎛️ PLATO TABLE — SUPER ADMIN PANEL
# MASTER PRD (Product Requirements Document)

**Version:** 1.0
**Status:** Planning
**Mode:** No Code — Features & Behavior Only
**Target:** AI Vibe Coder Implementation

---

## 📖 TABLE OF CONTENTS

1. Project Overview
2. Architecture & Tech Stack
3. Authentication & Roles
4. Database Tables (New)
5. Complete Screen List
6. Screen-by-Screen Specifications
7. Wallet & Stripe Integration
8. Email System
9. UI/UX Design Principles
10. Reference Files
11. Environment Configuration
12. Development Phases
13. Testing Checklist
14. Final Rules for AI Vibe Coder

---

## 1. 📌 PROJECT OVERVIEW

### What We Are Building

A **Super Admin Panel** — a centralized control center for the Plato Table SaaS platform. This panel sits ABOVE all restaurant admin panels and user apps, allowing platform owners to manage every restaurant, subscription, payment, and system setting from one place.

### Why We Are Building It

- Manage unlimited restaurants from one dashboard
- Handle automated monthly billing via Stripe
- Track revenue and business analytics
- Send notifications to restaurants
- Provide customer support via impersonation
- Control the entire platform as a SaaS business

### Relationship to Existing System

| Component | Purpose | Who Uses It |
|-----------|---------|-------------|
| **Super Admin Panel** (NEW) | Manage everything | Platform owners |
| **Restaurant Admin Panel** (Existing) | Manage one restaurant | Restaurant owners |
| **User App** (Existing) | View menu | Customers |

All three share the **SAME Supabase project**. New tables will be added. Existing tables and data remain untouched.

### Repository & Hosting

- **Separate Git repository** for Super Admin
- **Separate Vercel deployment**
- **Separate custom domain** (e.g., `admin.platotable.com`)
- Uses **same Supabase** as restaurants
- Uses **same Stripe account** as restaurants

---

## 2. 🏗️ ARCHITECTURE & TECH STACK

| Layer | Technology |
|-------|------------|
| Frontend Framework | React + Vite |
| Styling | Tailwind CSS |
| Backend / Database | Supabase (PostgreSQL) |
| Authentication | Supabase Auth |
| Storage | Supabase Storage (for logos) |
| Payments | Stripe (Live + Sandbox) |
| Email | Resend |
| Charts | Recharts |
| Icons | Lucide React |
| Routing | React Router v6 |
| State | React Context + Hooks |
| Hosting | Vercel |
| Domain | Custom (e.g., admin.platotable.com) |

### Data Flow

```
Super Admin → Supabase → Reads/Writes → All restaurant data
                       → Stripe API → Payment data
                       → Resend → Email notifications
```

### Multi-Tenancy

- Single Supabase project
- Row Level Security (RLS) enforces isolation
- Super Admin role sees everything
- Restaurant Admin sees only their own data
- Public users see only public menu data

---

## 3. 🔐 AUTHENTICATION & ROLES

### Super Admin Authentication

- Separate login from restaurant admins
- Uses Supabase Auth
- Email + password
- Session timeout: 24 hours
- Rate limiting: 5 attempts per minute
- Two-factor authentication (future phase)

### Roles

| Role | Permissions |
|------|-------------|
| **Super Admin** | Full access to everything |
| **Support** | View restaurants, send notifications, view logs, impersonate (no billing access) |
| **Billing** | View revenue, manage subscriptions, no restaurant editing |

### Login Rules

- Default super admin credentials created manually in Supabase
- New super admins can be added only by existing Super Admin
- Password can be changed from Settings page
- Email is fixed (`platotable@gmail.com` for the main account) but password is editable

### Security Rules

- Never store raw card numbers or CVV
- Never trust frontend payment status
- Only Stripe webhooks update subscription status
- All admin actions logged
- Impersonation sessions time-limited (1 hour max)

---

## 4. 🗄️ DATABASE TABLES (NEW)

These tables will be **added** to the existing Supabase project. No existing tables will be modified destructively.

### Table 1: `super_admins`

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| user_id | UUID | References auth.users |
| email | TEXT | Unique |
| name | TEXT | Full name |
| role | TEXT | super_admin / support / billing |
| is_active | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | Default now |
| updated_at | TIMESTAMPTZ | Auto-update |

### Table 2: `subscription_plans`

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| name | TEXT | Plan name |
| price_usd | DECIMAL | USD price |
| price_aed | DECIMAL | AED price |
| price_pkr | DECIMAL | PKR price |
| duration_days | INTEGER | Billing cycle |
| trial_days | INTEGER | Default 7 |
| features | JSONB | Feature list |
| is_active | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | Default now |

### Table 3: `subscriptions`

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| restaurant_id | UUID | FK to restaurants |
| plan_id | UUID | FK to subscription_plans |
| provider | TEXT | stripe |
| provider_customer_id | TEXT | Stripe customer ID |
| provider_subscription_id | TEXT | Stripe subscription ID |
| status | TEXT | trialing / active / past_due / suspended / canceled |
| currency | TEXT | USD / AED / PKR |
| amount | DECIMAL | Recurring amount |
| trial_start | TIMESTAMPTZ | Trial beginning |
| trial_end | TIMESTAMPTZ | Trial expiration |
| current_period_start | TIMESTAMPTZ | Current cycle start |
| current_period_end | TIMESTAMPTZ | Current cycle end |
| cancel_at_period_end | BOOLEAN | Default false |
| canceled_at | TIMESTAMPTZ | Nullable |
| last_payment_status | TEXT | paid / failed |
| created_at | TIMESTAMPTZ | Default now |
| updated_at | TIMESTAMPTZ | Auto-update |

### Table 4: `payment_transactions`

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| restaurant_id | UUID | FK to restaurants |
| subscription_id | UUID | FK to subscriptions |
| provider | TEXT | stripe |
| provider_transaction_id | TEXT | Stripe payment intent ID |
| amount | DECIMAL | Transaction amount |
| currency | TEXT | Currency code |
| status | TEXT | succeeded / failed / refunded |
| payment_method | TEXT | card / apple_pay / google_pay |
| card_last4 | TEXT | Last 4 digits only |
| card_brand | TEXT | visa / mastercard |
| created_at | TIMESTAMPTZ | Default now |

### Table 5: `system_notifications`

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| restaurant_id | UUID | Null = all restaurants |
| type | TEXT | info / warning / critical / success |
| title | TEXT | Short title |
| message | TEXT | Full message |
| background_color | TEXT | red / green / white / yellow |
| is_read | BOOLEAN | Default false |
| created_at | TIMESTAMPTZ | Default now |
| expires_at | TIMESTAMPTZ | Nullable |

### Table 6: `activity_logs`

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| super_admin_id | UUID | FK to super_admins |
| restaurant_id | UUID | Nullable |
| action | TEXT | Action name |
| details | JSONB | Full details |
| ip_address | TEXT | Request IP |
| user_agent | TEXT | Browser info |
| created_at | TIMESTAMPTZ | Default now |

### Table 7: `restaurant_urls`

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| restaurant_id | UUID | FK to restaurants |
| admin_url | TEXT | Custom admin panel URL |
| user_url | TEXT | Custom user app URL |
| custom_domain | TEXT | Nullable |
| is_primary | BOOLEAN | Default true |
| created_at | TIMESTAMPTZ | Default now |
| updated_at | TIMESTAMPTZ | Auto-update |

### Table 8: `wallet_transactions` (for platform wallet)

| Field | Type | Notes |
|-------|------|-------|
| id | UUID | Primary key |
| amount | DECIMAL | Transaction amount |
| currency | TEXT | Currency |
| type | TEXT | credit / debit / payout |
| source | TEXT | stripe / manual / refund |
| restaurant_id | UUID | Nullable |
| status | TEXT | pending / completed / failed |
| stripe_payout_id | TEXT | Nullable |
| notes | TEXT | Nullable |
| created_at | TIMESTAMPTZ | Default now |

---

## 5. 📋 COMPLETE SCREEN LIST

| # | Screen | URL | Priority |
|---|--------|-----|----------|
| 1 | Login | `/login` | 🔴 Must |
| 2 | Dashboard | `/dashboard` | 🔴 Must |
| 3 | All Restaurants | `/restaurants` | 🔴 Must |
| 4 | Restaurant Detail | `/restaurants/:id` | 🔴 Must |
| 5 | Add Restaurant | `/restaurants/new` | 🔴 Must |
| 6 | Subscriptions | `/subscriptions` | 🔴 Must |
| 7 | Subscription Detail | `/subscriptions/:id` | 🔴 Must |
| 8 | Revenue & Wallet | `/revenue` | 🔴 Must |
| 9 | Transactions | `/transactions` | 🔴 Must |
| 10 | Analytics | `/analytics` | 🟡 Should |
| 11 | Plans & Pricing | `/plans` | 🟡 Should |
| 12 | Notifications | `/notifications` | 🔴 Must |
| 13 | Send Notification | `/notifications/send` | 🔴 Must |
| 14 | Team Members | `/team` | 🟡 Should |
| 15 | Activity Logs | `/logs` | 🟡 Should |
| 16 | System Settings | `/settings` | 🔴 Must |
| 17 | Custom URLs | `/urls` | 🟡 Should |

**Removed (per user request):** Coupons, Email Templates, Profile

---

## 6. 🖥️ SCREEN-BY-SCREEN SPECIFICATIONS

Every screen must support **full CRUD operations** where applicable. Every screen must have premium, minimal, iPhone-quality UI with smooth transitions.

---

### SCREEN 1: LOGIN (`/login`)

**Purpose:** Authenticate super admin users

**Elements:**
- Centered card on gradient background
- Platform logo at top
- "Super Admin Panel" subtitle
- Email input (required, validated)
- Password input (required, masked with show/hide toggle)
- "Remember me" checkbox
- "Forgot password?" link
- Login button with loading spinner
- Error message area
- Footer: "🔒 Secure login"

**Behavior:**
- Submit → validate → authenticate via Supabase
- On success → redirect to Dashboard
- On failure → show error message
- Rate limit: 5 attempts per minute
- Session expires after 24 hours

**UI/UX:**
- Subtle fade-in animation on load
- Input focus animation (border color, shadow)
- Button hover/press states
- Loading spinner on submit
- Smooth error message slide-in

---

### SCREEN 2: DASHBOARD (`/dashboard`)

**Purpose:** At-a-glance overview of the entire business

**Top Stats Cards (6):**
1. Total Revenue (all time)
2. This Month Revenue
3. Total Restaurants
4. Active Subscriptions
5. Trial Users
6. Past Due / Suspended

**Charts:**
- Revenue trend (last 12 months, line chart)
- New signups (last 30 days, bar chart)
- Plan distribution (pie chart)
- Churn rate over time (line chart)

**Recent Activity Feed:**
- Live updates
- Icons per event type
- Timestamps ("2 minutes ago")
- Clickable to view details

**Alerts Box:**
- Trials ending soon (count)
- Payments failed (count)
- Suspended subscriptions (count)
- Click alert → navigate to filtered list

**Quick Actions:**
- Add New Restaurant
- Send Notification
- View Revenue

**Behavior:**
- Auto-refresh every 60 seconds
- All cards clickable → navigate to detail
- Real-time updates via Supabase subscription

**CRUD:**
- Read only (aggregated view)
- Actions redirect to respective screens

**UI/UX:**
- Cards with subtle hover lift
- Numbers animate on load (count-up)
- Charts fade in
- Skeleton loading state
- Numbers formatted (1,234 / $12,450)

---

### SCREEN 3: ALL RESTAURANTS (`/restaurants`)

**Purpose:** View and manage all restaurants

**Features:**
- Search bar (by name, owner email, phone)
- Filter dropdowns: Status, Plan, Country
- Sortable columns (click header)
- Pagination (10/25/50 per page)
- Bulk select checkbox
- Export CSV / PDF

**Table Columns:**
- Checkbox
- Logo (thumbnail)
- Name (clickable → detail)
- Owner Email
- Phone
- Status badge (colored)
- Plan
- QR Codes count
- Menu Items count
- Revenue (total paid)
- Joined Date
- Actions dropdown

**Row Actions:**
- View Details
- Edit
- Login As (impersonate)
- Suspend
- Reactivate
- Delete (with confirmation)

**Add New Restaurant Button:**
- Opens modal or navigates to `/restaurants/new`
- Fields: Restaurant name, Owner email, Owner name, Phone, Country, Plan, Trial days

**Bulk Actions:**
- Suspend selected
- Reactivate selected
- Send notification to selected
- Export selected

**CRUD:** Full CRUD

**Behavior:**
- Real-time status updates
- Delete → multi-step confirmation
- Suspend → immediate effect on public menu

**UI/UX:**
- Sticky header row
- Row hover highlight
- Status badges with icons
- Dropdown menu with smooth animation
- Confirmation modal with backdrop blur
- Empty state with illustration
- Loading skeleton rows

---

### SCREEN 4: RESTAURANT DETAIL (`/restaurants/:id`)

**Purpose:** Deep view of a single restaurant

**Header:**
- Back button
- Restaurant logo
- Restaurant name
- Status badge
- Actions dropdown (top-right)

**Tabs:**
1. **Overview** — Basic info, stats, custom URLs
2. **Subscription** — Plan, dates, payment method, history
3. **Menu** — Preview of all menu items
4. **QR Codes** — All QR codes with scan stats
5. **Activity** — Log of their actions

**Overview Tab:**
- Restaurant info card
- Owner details
- Contact info
- Custom URLs (admin + user)
- Stats card (QR codes, menu items, categories, scans/month, revenue)
- Quick action buttons

**Subscription Tab:**
- Current plan
- Status
- Amount
- Trial dates
- Current period
- Next payment
- Payment method
- Actions: Extend Trial, Extend Subscription, Change Plan, Cancel, Reactivate

**Menu Tab:**
- Preview grid of menu items
- Read-only view
- Filter by category
- Search items

**QR Codes Tab:**
- List of all QR codes
- Table number, token, status, scans
- Read-only view

**Activity Tab:**
- Log of their actions
- Filter by action type
- Date range filter

**Quick Actions:**
- Login As (impersonate)
- Extend Trial (opens modal)
- Extend Subscription (opens modal)
- Suspend / Reactivate
- Send Notification
- Edit URLs
- Change Plan
- Delete Restaurant

**CRUD:** Full CRUD on restaurant, subscription, URLs

**UI/UX:**
- Tab transitions with slide animation
- Cards with subtle shadows
- Status indicators with colors
- Modals with backdrop blur
- Smooth number animations

---

### SCREEN 5: ADD RESTAURANT (`/restaurants/new`)

**Purpose:** Onboard a new restaurant

**Form Fields:**
- Restaurant Name (required)
- Owner Name (required)
- Owner Email (required)
- Phone (required)
- Country (dropdown)
- Currency (auto based on country)
- Plan (dropdown)
- Trial Days (default 7)
- Custom Admin URL (optional)
- Custom User URL (optional)
- Logo upload (optional)

**Actions:**
- Save → creates restaurant + subscription (trialing)
- Cancel → back to list

**Behavior:**
- Validation on all required fields
- Auto-fill currency based on country
- Auto-generate trial end date
- Send welcome email after creation

**CRUD:** Create

**UI/UX:**
- Multi-section form
- Inline validation
- Success toast on save
- Progress indicator

---

### SCREEN 6: SUBSCRIPTIONS (`/subscriptions`)

**Purpose:** Manage all subscriptions

**Stats Cards:**
- Trialing (count)
- Active (count)
- Past Due (count)
- Suspended (count)
- Canceled (count)

**Filter Tabs:**
- All
- Trialing
- Active
- Past Due
- Suspended
- Canceled

**Table Columns:**
- Restaurant name
- Status badge
- Plan
- Currency + amount
- Current period start
- Current period end
- Next payment date
- Days remaining
- Last payment status
- Actions dropdown

**Row Actions:**
- View Details
- Extend
- Cancel
- Reactivate
- Mark as Paid
- Change Plan

**Bulk Actions:**
- Extend selected
- Send reminder to selected
- Export

**CRUD:** Full CRUD

**UI/UX:**
- Color-coded status badges
- Countdown timers for trials
- Warning icons for past due
- Smooth filter tab transitions
- Empty states per filter

---

### SCREEN 7: SUBSCRIPTION DETAIL (`/subscriptions/:id`)

**Purpose:** Deep view of a single subscription

**Sections:**
- Restaurant info
- Plan details
- Status + timeline
- Payment history
- Stripe IDs
- Actions panel

**Actions:**
- Extend trial (modal: add days)
- Extend subscription (modal: add days)
- Change plan (modal: select new plan)
- Mark as paid (modal: confirmation)
- Cancel (modal: reason + confirmation)
- Reactivate
- View in Stripe

**Payment History:**
- Table of all transactions
- Date, amount, status, method, Stripe ID
- Download invoice links

**CRUD:** Full CRUD

**UI/UX:**
- Timeline view of subscription lifecycle
- Color-coded events
- Modal animations
- Success/error toasts

---

### SCREEN 8: REVENUE & WALLET (`/revenue`)

**Purpose:** Track all platform earnings

**Top Cards:**
- Total Balance (wallet)
- This Month Revenue
- Last Month Revenue
- Growth %
- Pending Payout
- Next Payout Date

**Charts:**
- Revenue by month (line)
- Revenue by plan (pie)
- Revenue by country (bar)
- Top 5 restaurants (horizontal bar)

**Wallet Section:**
- Current balance
- Connected Stripe account
- Payout history
- Manual adjustment (add/subtract)

**Revenue Breakdown:**
- By currency (USD, AED, PKR)
- By payment method
- By restaurant tier

**Export:**
- CSV
- PDF
- Excel

**CRUD:**
- Read for revenue
- Create/Update for manual wallet adjustments

**UI/UX:**
- Large numbers with count-up animation
- Charts with smooth transitions
- Color-coded growth indicators (green/red)
- Currency formatting per region

---

### SCREEN 9: TRANSACTIONS (`/transactions`)

**Purpose:** Complete payment history

**Filters:**
- Date range
- Status (paid/failed/refunded)
- Restaurant
- Amount range
- Currency

**Table Columns:**
- Date
- Restaurant
- Amount
- Currency
- Status badge
- Payment method
- Card last 4
- Card brand
- Stripe transaction ID
- Actions (View in Stripe, Download invoice)

**Bulk Actions:**
- Export selected
- Refund selected (with confirmation)

**CRUD:**
- Read
- Refund (creates refund in Stripe)

**UI/UX:**
- Sticky filters bar
- Pagination with jump-to-page
- Row expand for full details
- Copy Stripe ID button
- Empty state

---

### SCREEN 10: ANALYTICS (`/analytics`)

**Purpose:** Business intelligence

**Metrics:**
- MRR (Monthly Recurring Revenue)
- ARR (Annual Recurring Revenue)
- New signups (chart)
- Churn rate (chart)
- Retention rate
- Trial-to-paid conversion %
- ARPU (Average Revenue Per User)
- LTV (Customer Lifetime Value)
- Average subscription duration
- Peak usage hours

**Charts:**
- MRR growth over time
- Churn rate trend
- Retention cohort chart
- Conversion funnel
- Usage heatmap (hour × day)

**Filters:**
- Date range
- Plan
- Country

**Export:**
- PDF report
- CSV data

**CRUD:** Read only

**UI/UX:**
- Interactive charts
- Hover tooltips
- Drill-down on click
- Animated transitions

---

### SCREEN 11: PLANS & PRICING (`/plans`)

**Purpose:** Manage subscription plans

**Plan Cards (grid):**
- Plan name
- Price (per currency)
- Duration
- Trial days
- Features list
- Active/Inactive toggle
- Edit button

**Actions:**
- Create new plan
- Edit plan
- Activate/Deactivate
- Delete (only if no subscriptions)

**Create/Edit Form:**
- Plan name
- Price (USD, AED, PKR)
- Duration days
- Trial days
- Features (add/remove list)
- Is active toggle

**CRUD:** Full CRUD

**UI/UX:**
- Card-based layout
- Color-coded plans
- Toggle animations
- Confirmation on delete

---

### SCREEN 12: NOTIFICATIONS (`/notifications`)

**Purpose:** Notification history

**Table Columns:**
- Date
- Title
- Type badge (info/warning/critical/success)
- Background color
- Sent to (all / specific)
- Read rate %
- Actions (View, Resend, Delete)

**Filters:**
- Date range
- Type
- Restaurant

**CRUD:** Read, Delete, Resend

**UI/UX:**
- Type badges colored
- Read rate as progress bar
- Empty state

---

### SCREEN 13: SEND NOTIFICATION (`/notifications/send`)

**Purpose:** Send notifications to restaurants

**Form:**
- Title (required)
- Message (required, multi-line)
- Background color (radio: white/red/green/yellow)
- Send to:
  - All restaurants
  - By status (trial/active/past_due/suspended)
  - Custom selection (multi-select)
- Send timing:
  - Now
  - Schedule (date + time picker)
- Preview panel (shows how it will look)

**Actions:**
- Send
- Save as draft
- Cancel

**Behavior:**
- Live preview updates as you type
- Send to in-app + email
- Notification logged in activity

**CRUD:** Create

**UI/UX:**
- Two-column layout (form left, preview right)
- Live preview
- Color picker with visual preview
- Smooth transitions
- Confirmation before send

---

### SCREEN 14: TEAM MEMBERS (`/team`)

**Purpose:** Manage super admin users

**Table:**
- Name
- Email
- Role badge
- Status
- Last login
- Actions

**Actions:**
- Add new admin (modal)
- Edit admin
- Change role
- Deactivate
- Delete
- Reset password (sends email)
- Force logout

**Add/Edit Form:**
- Full name
- Email
- Role (super_admin / support / billing)
- Password (only for new)
- Is active toggle

**CRUD:** Full CRUD

**UI/UX:**
- Role badges colored
- Confirmation modals
- Success toasts

---

### SCREEN 15: ACTIVITY LOGS (`/logs`)

**Purpose:** Audit trail of all actions

**Filters:**
- Date range
- Admin user
- Action type
- Restaurant

**Table Columns:**
- Timestamp
- Admin name
- Action
- Restaurant
- Details (expandable)
- IP address
- Device

**Row Expand:**
- Full JSON details
- Old value → New value
- User agent

**Export:**
- CSV

**CRUD:** Read only

**UI/UX:**
- Searchable
- Filterable
- Expandable rows
- Pagination

---

### SCREEN 16: SYSTEM SETTINGS (`/settings`)

**Purpose:** Platform configuration

**Tabs:**

**General:**
- Platform name
- Platform logo (upload)
- Favicon (upload)
- Support email
- Support phone
- Default currency
- Default trial days
- Grace period days

**Stripe:**
- Publishable key
- Secret key (masked)
- Webhook secret (masked)
- Test mode toggle
- Test connection button

**Email:**
- Resend API key (masked)
- From email (fixed: platotable@gmail.com)
- From name
- Test email button

**Features:**
- Enable/disable trial
- Enable/disable notifications
- Maintenance mode toggle
- Maintenance message

**Security:**
- Password change (current, new, confirm)
- Session timeout (hours)
- Two-factor authentication toggle (future)

**Save button** at bottom

**CRUD:** Full CRUD

**UI/UX:**
- Tab navigation
- Password fields masked with show/hide
- Test buttons with loading state
- Success/error toasts
- Confirmation on sensitive changes

---

### SCREEN 17: CUSTOM URLs (`/urls`)

**Purpose:** Manage custom URLs per restaurant

**Table Columns:**
- Restaurant name
- Admin URL
- User URL
- Custom domain
- Is primary
- Actions

**Actions:**
- Add URL mapping
- Edit
- Delete
- Copy URL
- Open URL

**Add/Edit Form:**
- Restaurant (dropdown)
- Admin URL
- User URL
- Custom domain (optional)
- Is primary toggle

**CRUD:** Full CRUD

**UI/UX:**
- URL fields with copy button
- Preview link button
- Confirmation on delete

---

## 7. 💰 WALLET & STRIPE INTEGRATION

### Wallet Overview

The platform has its own wallet connected to Stripe. All restaurant payments flow into this wallet.

### Stripe Setup

- Use **Sandbox keys** for testing (provided in `stripe.md`)
- Use **Live keys** for production
- Store keys in environment variables
- Never expose secret key to frontend

### Payment Flow

1. Restaurant subscribes → Stripe Checkout
2. Payment succeeds → Stripe charges card
3. Money goes to platform Stripe balance
4. Stripe webhook fires → updates database
5. Wallet balance increases
6. Payout to bank account (automatic per Stripe schedule)

### Webhook Events to Handle

- `checkout.session.completed`
- `invoice.paid`
- `invoice.payment_failed`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `customer.subscription.trial_will_end`
- `payment_intent.succeeded`
- `payment_intent.payment_failed`

### Wallet Dashboard Shows

- Total balance
- Pending balance (not yet cleared)
- Available balance (ready for payout)
- Next payout date
- Payout history
- Manual adjustment option

### Stripe Features Used

- Checkout (hosted payment page)
- Subscriptions (recurring billing)
- Webhooks (event handling)
- Customer portal (for restaurants to manage payment methods)
- Refunds
- Payouts

### Security Rules

- Never store card numbers
- Never store CVV
- Only trust webhooks for payment status
- Verify webhook signatures
- Log all Stripe API calls

---

## 8. 📧 EMAIL SYSTEM

### Provider: Resend

### Fixed Sender

- From email: `platotable@gmail.com` (fixed, non-editable)
- From name: "Plato Table" (editable)
- Reply-to: configurable

### Email Types

**Transactional:**
- Welcome email (new restaurant)
- Trial ending in 3 days
- Trial ending tomorrow
- Trial expired
- Payment successful
- Payment failed
- Subscription canceled
- Subscription suspended
- Password reset
- Support impersonation notice

**System:**
- New super admin added
- Settings changed
- Security alert

### Email Templates

- Modern, minimal design
- Plato Table branding
- Clear CTA button
- Responsive (mobile-friendly)
- Dark mode compatible

### Email Logs

- All emails logged in database
- Track delivery, open, click
- Retry on failure

---

## 9. 🎨 UI/UX DESIGN PRINCIPLES

### Design Philosophy

- **Premium** — Like Apple, Stripe, Linear
- **Minimal** — No clutter, no unnecessary elements
- **Smooth** — Every interaction animated
- **Fast** — No lag, instant feedback
- **Consistent** — Same patterns everywhere
- **Almost Perfect** — Zero tolerance for sloppy UI

### Layout

- **Sidebar** (left, collapsible on mobile)
- **Top Header** (notifications, profile, settings)
- **Main Content** (cards, tables, charts)
- **Responsive** — Desktop, tablet, mobile

### Color Palette

**Light Mode:**
- Background: `#F9FAFB`
- Card: `#FFFFFF`
- Primary: `#4F46E5` (Indigo)
- Success: `#10B981`
- Warning: `#F59E0B`
- Danger: `#EF4444`
- Text Primary: `#111827`
- Text Secondary: `#6B7280`
- Border: `#E5E7EB`

**Dark Mode:**
- Background: `#0F172A`
- Card: `#1E293B`
- Primary: `#6366F1`
- Success: `#34D399`
- Warning: `#FBBF24`
- Danger: `#F87171`
- Text Primary: `#F1F5F9`
- Text Secondary: `#94A3B8`
- Border: `#334155`

### Typography

- **Font:** Inter (Google Fonts)
- **Headings:** 600-700 weight
- **Body:** 400-500 weight
- **Sizes:** 12px, 14px, 16px, 20px, 24px, 32px
- **Line height:** 1.5 for body

### Spacing

- 4px base unit
- 8px, 12px, 16px, 24px, 32px, 48px
- Consistent padding in cards (24px)
- Consistent gaps in grids

### Components

**Cards:**
- Rounded 12px
- Subtle shadow (`0 1px 3px rgba(0,0,0,0.1)`)
- Hover: slight lift
- Border in dark mode

**Buttons:**
- Primary: solid, rounded 8px, padding 12px 20px
- Secondary: outline
- Ghost: text only
- Danger: red background
- Icon buttons: 40x40 circle

**Inputs:**
- Rounded 8px
- Border on default
- Focus: primary color ring
- Error: red border + message

**Tables:**
- Sticky header
- Striped rows (subtle)
- Hover highlight
- Sortable columns
- Pagination

**Modals:**
- Centered
- Backdrop blur
- Scale-in animation
- Close button
- Action buttons at bottom

**Badges:**
- Rounded pill
- Colored per status
- Icon optional

**Dropdowns:**
- Smooth open/close animation
- Click outside to close
- Keyboard navigation

### Animations

- **Page transitions:** Fade + slide (150ms)
- **Modal open:** Scale from 0.95 to 1 (200ms)
- **Button hover:** Scale 1.02 (100ms)
- **Number counters:** Count-up (500ms)
- **Chart load:** Fade + grow (600ms)
- **Skeleton loading:** Shimmer effect
- **Toast:** Slide from top-right (300ms)

### Empty States

- Illustration
- Headline
- Description
- CTA button

### Loading States

- Skeleton screens
- Spinners
- Progress bars
- Never blank screens

### Error States

- Friendly message
- Retry button
- Support link
- Never technical jargon

### Accessibility

- WCAG AA contrast minimum
- Keyboard navigation
- ARIA labels
- Focus indicators
- Screen reader friendly
- Touch targets 44px+

### Mobile Responsive

- Sidebar collapses to bottom nav
- Tables become cards
- Charts resize
- Touch-friendly
- Swipe gestures

### Reference Files

Use the UI/UX references provided in the **`references/`** folder for:
- Layout structure
- Color usage
- Component styles
- Animation patterns
- Overall aesthetic

---

## 10. 📁 REFERENCE FILES

### UI/UX References

Located in: **`references/` folder**

Use these for:
- Visual style
- Component design
- Layout patterns
- Color schemes
- Animation timing
- Icon usage

### Configuration Files

**`stripe.md`** — Contains:
- Stripe Sandbox publishable key
- Stripe Sandbox secret key
- Webhook secret
- Test card numbers

**`supabase.md`** — Contains:
- Supabase project URL
- Supabase anon key
- Supabase service role key
- Database connection string

### Usage Rules

- Read both `.md` files before starting
- Use the keys as environment variables
- Never hardcode keys in source code
- Add `.env` to `.gitignore`
- Create `.env.example` with placeholder keys

---

## 11. ⚙️ ENVIRONMENT CONFIGURATION

### Required Environment Variables

```
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_SUPABASE_SERVICE_ROLE_KEY=

VITE_STRIPE_PUBLISHABLE_KEY=
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=

VITE_RESEND_API_KEY=
RESEND_FROM_EMAIL=platotable@gmail.com

VITE_APP_NAME=Plato Table
VITE_APP_URL=https://admin.platotable.com
```

### Where to Store

- Local: `.env.local` (gitignored)
- Production: Vercel environment variables
- Never commit secrets to Git

### Fixed Email Rule

- Sender email is **always** `platotable@gmail.com`
- Not editable from UI
- Password for this email must exist in Supabase Auth
- Password can be changed from Super Admin Settings page

---

## 12. 🚀 DEVELOPMENT PHASES

### Phase 1: Foundation (Week 1)
- Project setup (React + Vite + Tailwind)
- Supabase connection
- Authentication system
- Login page
- Basic layout (sidebar + header)
- Empty dashboard shell

### Phase 2: Restaurants (Week 2)
- All Restaurants screen
- Restaurant Detail screen
- Add Restaurant screen
- Custom URLs management

### Phase 3: Subscriptions (Week 3)
- Subscriptions list
- Subscription detail
- Plans & Pricing screen
- Manual subscription management

### Phase 4: Stripe & Wallet (Week 4)
- Stripe integration
- Checkout flow
- Webhook handler
- Wallet dashboard
- Transactions screen

### Phase 5: Notifications & Emails (Week 5)
- Send Notification screen
- Notification history
- Resend email integration
- Email templates

### Phase 6: Analytics & Logs (Week 6)
- Analytics dashboard
- Activity logs
- Team members screen
- System settings

### Phase 7: Polish & Testing (Week 7)
- Dark mode
- Animations
- Mobile responsiveness
- Bug fixes
- Performance optimization
- Security audit

### Phase 8: Launch (Week 8)
- Deploy to Vercel
- Custom domain
- SSL
- Production Stripe keys
- Final testing
- Go live

---

## 13. ✅ TESTING CHECKLIST

### Authentication
- [ ] Login with valid credentials
- [ ] Login with invalid credentials
- [ ] Session expires after 24 hours
- [ ] Rate limiting works
- [ ] Password change works

### Restaurants
- [ ] Create new restaurant
- [ ] Edit restaurant
- [ ] Delete restaurant
- [ ] Suspend restaurant → menu offline
- [ ] Reactivate restaurant → menu online
- [ ] Login as restaurant works
- [ ] Search works
- [ ] Filters work
- [ ] Bulk actions work

### Subscriptions
- [ ] View all subscriptions
- [ ] Filter by status
- [ ] Extend trial
- [ ] Extend subscription
- [ ] Change plan
- [ ] Cancel subscription
- [ ] Reactivate subscription
- [ ] Manual payment override

### Stripe
- [ ] Sandbox checkout works
- [ ] Webhook receives events
- [ ] Subscription activates after payment
- [ ] Failed payment → past_due
- [ ] Grace period works
- [ ] Suspension after grace period
- [ ] Refund works

### Wallet
- [ ] Balance shows correctly
- [ ] Transactions sync from Stripe
- [ ] Payout schedule visible
- [ ] Manual adjustment works

### Notifications
- [ ] Send to all works
- [ ] Send to specific works
- [ ] Background colors work
- [ ] Email delivered
- [ ] In-app notification appears

### Settings
- [ ] Password change works
- [ ] Stripe keys editable
- [ ] Email settings work
- [ ] Maintenance mode works
- [ ] Features toggle works

### UI/UX
- [ ] All screens load
- [ ] Dark mode works everywhere
- [ ] Light mode works everywhere
- [ ] Mobile responsive
- [ ] Animations smooth
- [ ] No layout shift
- [ ] No console errors
- [ ] Accessibility passes

---

## 14. 🎯 FINAL RULES FOR AI VIBE CODER

### DO

- ✅ Read `stripe.md` and `supabase.md` before starting
- ✅ Use UI/UX references from `references/` folder
- ✅ Build premium, minimal, iPhone-quality UI
- ✅ Use smooth transitions everywhere
- ✅ Implement full CRUD on every applicable screen
- ✅ Handle all edge cases
- ✅ Follow the phase order strictly
- ✅ Test after each phase
- ✅ Use the provided Stripe sandbox keys
- ✅ Use the provided Supabase keys
- ✅ Show every single detail on detail screens
- ✅ Make everything work end-to-end
- ✅ Prioritize correctness over speed
- ✅ Build the wallet connected to Stripe

### DON'T

- ❌ Don't write code in this PRD
- ❌ Don't skip screens
- ❌ Don't use placeholder UI
- ❌ Don't ignore mobile responsiveness
- ❌ Don't hardcode secrets
- ❌ Don't build Coupons, Email Templates, or Profile screens
- ❌ Don't modify existing restaurant tables destructively
- ❌ Don't trust frontend for payment status
- ❌ Don't store card details
- ❌ Don't build anything not in this PRD

### Build Order

1. Read all reference files
2. Set up project + auth
3. Build layout shell
4. Build screens phase by phase
5. Test each phase before moving on
6. Polish UI/UX
7. Deploy

### Success Criteria

- All 17 screens built
- All CRUD operations work
- Stripe integration complete
- Wallet functional
- Emails sending
- Dark mode works
- Mobile responsive
- Premium UI quality
- No bugs
- Production ready

---

## 🏁 END OF PRD

**This is the complete Master PRD for the Plato Table Super Admin Panel.**

**Hand this to your AI Vibe Coder. It will build the entire system phase by phase.**

**No code is written in this document — only features, behavior, and specifications.**

**Tomorrow when you're ready, tell me and I'll help you deploy each phase.**

**Good luck, bro. This is going to be huge. 🚀🔥**
