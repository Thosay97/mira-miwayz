# MiWayz Knowledge Base
# Used by MIRA — MiWayz Intelligence & Resource Advisor
# Last updated: June 2026

---

## COMPANY OVERVIEW

**Company:** MiWayz (stylised as MiWayz)
**Type:** Sri Lankan ride-hailing startup
**Market:** Colombo, Sri Lanka
**Competitors:** Uber, PickMe
**Tagline:** "Go Beyond the Usual"
**GTM Launch:** July 12, 2026 — Colombo
**Brand Colors:** Primary #F7931E (orange), Secondary #0CA6D5 (blue)

---

## VEHICLE TYPES

| Name | Type |
|------|------|
| MiBike | Motorcycle taxi |
| MiTuk | Three-wheeler (tuk-tuk) |
| MiFlex | Flexible/shared ride |
| MiMini | Small car |
| MiCar | Standard car |
| MiMini Van | Mini van |
| MiVan | Full van |

---

## TEAM

**Thoshan Rathnayake** — Product Owner (contract), also Program Manager at IFS Aerospace & Defence (since Oct 2025) and Senior Project Manager at Bileeta (since Jan 2025)

**Engineering:**
- Chathura — Head of Engineering
- Jaliya Lamahewa — Backend Developer (Squad 1)
- Ashfak Khajudeen — Backend Developer (Squad 1)
- Kukeenthan Thiyaharasa — Flutter Developer (Squad 1)
- Sujanthan Arputharasu — Flutter Developer (Squad 1)
- Chethana Jayasinghe — Backend Developer (Squad 2)
- Husni Faiz — Backend Developer (Squad 2)
- Yuvanshan Prabakaran — Flutter Developer (Squad 2)
- Sineth Sandaruwan — .NET Developer (Squad 3)
- Thanuja Mahendran — .NET Developer (Squad 3)
- Thajun Najaah — Backend Developer (Squad 3)
- Vishagan Nadesalingam — Intern Developer (Squad 3)

**QA:**
- Shanilka — QA Lead
- Umar Muwahid — QA Engineer (Squad 1)
- Nadee Prabha — QA Engineer (Squad 1)
- Dilip Vengadesan — QA Engineer (Squad 2)
- Kasuni Piyumanthi — QA Engineer (Squad 2)
- Oneli Visakya — Intern QA Engineer (Squad 3)

**Design:**
- Gimantha — Designer

**BA:**
- Nimeshika Mandakini — Business Analyst

---

## SQUADS

**Squad 1:** Jaliya, Kukeenthan, Ashfak, Sujanthan, Umar, Nadee
**Squad 2:** Chethana, Husni, Yuvanshan, Dilip, Kasuni
**Squad 3:** Sineth, Thanuja, Thajun, Vishagan, Oneli

---

## PRODUCTS / APPS

- **Passenger App** — Flutter mobile app for riders
- **Driver App** — Flutter mobile app for drivers
- **Admin Portal** — Web portal for MiWayz operations team
- **CRM** — Customer relationship management system

---

## FARE STRUCTURE

- Base fare calculated on `total_fare`
- Fare components: base fare + distance + time + surcharges
- `total_fare` = sum of all fare components before discount
- `discounted_fare` = `total_fare` minus `promo.amount`
- Promo discount applied to `total_fare` only

---

## PROMO ENGINE V1

**Scope (locked):**
- Passenger-only fare discounts via promo code
- Applied to `total_fare`
- Lock-on-activate edit policy (cannot edit active promos)
- No wallet credit in V1
- No driver promotions in V1
- First N Trips = distinct eligibility filter for new-rider acquisition
- Promo code entered by passenger at booking

**Fare breakdown UI (MICT-1737):**
- Conditional discount row shown in green when promo applied
- Invariant: `total_fare` - `promo.amount` = `discounted_fare`

---

## TRIP ID FORMAT

- Format: `{ACCOUNT_ID}-{CUSTOM_EPOCH}`
- Custom epoch = seconds since January 1, 2026 UTC
- Epic: MICT-1294
- Stories: MICT-1295 through MICT-1301
- Status: Completed, moving to sprint execution

---

## SOS EMERGENCY SYSTEM

Three-layer response architecture:
1. **Layer 1:** CRM real-time alert with dual GPS pings (passenger + driver)
2. **Layer 2:** Trusted contact share (live location link)
3. **Layer 3:** Emergency contact dial fallback

Open question: Whether WhatsApp Live Location can be triggered programmatically via Business API (Globe Teleservices discussion)

---

## GHOST DRIVER PADDING

- **Feature:** PAX-GHOST-001
- **Type:** Client-side only (no backend changes)
- **Logic:** Always show 4 driver pins on passenger map
- When real drivers < 4: pad with ghost pins
- When real drivers = 0: show zero pins (no ghosts)
- Purpose: Improve perceived availability

---

## CRM INCOMING CALL NOTIFICATIONS

- **Ticket:** MICT-1358 (CRITICAL — active blocker)
- **Integration:** Dialog PABX webhook
- **Status:** Waiting for webhook spec from Dialog
- When a call comes in to CRM, agent sees passenger/driver profile automatically
- Uses Dialog PABX system for Sri Lanka PSTN calls

---

## IN-APP CALLING

**Decision:** Phased approach
- **Phase 1 (Pilot):** PSTN masked calling via Exotel or Plivo
- **Phase 2:** VoIP via Agora
- **Reason:** Sri Lanka patchy mobile data coverage makes VoIP unreliable for Phase 1

---

## TIME & LOCATION BASED PRICING (SURCHARGE)

- **Demand-based Surcharge H3:** MICT-1046 (uses H3 hexagonal grid)
- **Custom Surcharge:** MICT-1050
- Dynamic surcharges separated from static additional fees
- Several stories deferred post-GTM

---

## PRICING CHANGE APPROVAL WORKFLOW

- **Ticket:** MICT-1149
- CEO and Finance sign-off required before pricing changes go live
- Portal-side workflow

---

## USABILITY TESTING

- **MICT-1340:** Passenger App usability test
- **MICT-1341:** Driver App usability test
- Both currently In UAT

---

## AUDIT TRAIL

- Excel export feature for admin portal
- Currently in active development

---

## DISPATCH

- Dispatch radius configurable per vehicle type
- Set in Admin Portal pre-launch configuration

---

## SUBSCRIPTION PLANS

- Driver subscription plans configured in Admin Portal
- Plans vary by vehicle type

---

## TECHNOLOGY STACK

- **Mobile:** Flutter (passenger + driver apps)
- **Backend:** Node.js / .NET
- **Admin Portal:** Web (.NET)
- **Database:** Not specified
- **Infrastructure:** Cloud-hosted
- **Mapping:** H3 hexagonal grid for surcharge zones
- **Project Management:** Jira (MICT board)
- **PDPA Compliance:** Sri Lanka Personal Data Protection Act applies

---

## KEY DECISIONS LOG

| Decision | Detail |
|----------|--------|
| Promo V1 scope | Passenger fare discount only, no wallet, no driver promos |
| Promo edit policy | Lock on activate |
| Trip ID format | ACCT_ID-EPOCH (seconds since 1 Jan 2026) |
| Ghost driver | Client-side only, pad to 4, zero when no real drivers |
| Calling Phase 1 | PSTN masked via Exotel/Plivo |
| Surcharge architecture | Demand (H3) separate from custom/static |
| Pricing approval | CEO + Finance sign-off required |
| App tagline | "Go Beyond the Usual" |
| MiBoost | Not developed, removed from App Store listing |

---

## JIRA BOARD

- **Board:** MICT
- **Platform:** Jira (miwayz.atlassian.net)
- **Current Sprint:** Sprint 29
- **Sprint cadence:** 2 weeks

### Key Status Names (MiWayz custom workflow)
- To Do
- In Progress / In Development
- Code Review
- Ready for QA
- In QA
- Done
- Blocked / On Hold
- Cancelled

---

## APP STORE LISTINGS

- Both Passenger and Driver apps have App Store copy
- Tagline: "Go Beyond the Usual"
- MiBoost feature removed (not developed)

---

## GLOSSARY

| Term | Meaning |
|------|---------|
| GTM | Go-To-Market (launch date July 12, 2026) |
| PDPA | Personal Data Protection Act (Sri Lanka) |
| PABX | Private Automatic Branch Exchange (Dialog phone system) |
| H3 | Uber's hexagonal hierarchical geospatial indexing system |
| PAX | Passenger |
| FGL | Financial General Ledger |
| CRM | Customer Relationship Management |
| total_fare | Full fare before any discount |
| discounted_fare | Fare after promo deduction |
| Custom epoch | Seconds since Jan 1, 2026 UTC |
| Ghost driver | Fake driver pin shown on map for UX padding |
| MiBoost | Unbuilt feature, removed from scope |
