# FENCING SCOPING TOOL — PROJECT CONTEXT

## What This Is

A single-file web app used by SecureWorks WA sales reps to design and quote Colorbond fencing on-site (iPad) and by admin staff to review and generate material/work orders. Built as vanilla HTML/CSS/JS — no frameworks, no build step.

**Open `index.html` in a browser to run it. That's the main app.** `business_rules.js` contains compliance checks loaded separately.

---

## Business Context

**Company:** SecureWorks WA Pty Ltd — outdoor living construction (Perth, Western Australia)
**Service:** Colorbond fencing (secondary revenue stream alongside patios)
**Who uses this tool:**
- **Sales reps / scopers** (on-site, iPad): Design fence runs, capture retaining/gates/extras, generate quotes
- **Admin staff** (desktop): Review scoped jobs, verify material orders, send supplier orders

**Suppliers:** RNR Fencing (Ridgeside, Sameside profiles), CMI, Stratco
**Standard panel width:** 2380mm (RNR) — varies by supplier

---

## Brand Rules (Must Follow)

| Colour | Hex | Use |
|--------|-----|-----|
| SecureWorks Orange | `#F15A29` | CTAs, accents |
| Dark Dusty Blue | `#293C46` | Headings, dark backgrounds |
| Mid Dusty Blue | `#4C6A7C` | Secondary text, borders |
| White | `#FFFFFF` | Backgrounds |

- **No pure black** for headings — use Dark Dusty Blue
- **No orange as large background** — accent only
- **Font stack:** `'Helvetica Neue', Helvetica, Arial, sans-serif`

---

## File Structure

```
fence-designer/
├── index.html          ← THE MAIN APP (~7,000+ lines)
├── business_rules.js   ← Compliance checks (loaded by index.html)
├── CLAUDE.md           ← This file (project context for AI)
└── textures/           ← Panel texture images for 3D preview
```

---

## Architecture Overview

The app has two panels:
- **Left panel**: Fence run designer (add runs, configure panels, retaining, gates)
- **Right panel**: 2D profile view + 3D canvas preview

### Key Global Objects & Functions

| Name | ~Line | Purpose |
|------|-------|---------|
| `app` | ~1630 | Main application object — job data, runs, panels, gates, pricing, all methods |
| `app.job` | — | Current job state: `{ ref, client, address, email, supplier, profile, colour, runs[], gates[], ... }` |
| `app._collectOutputData()` | ~4261 | Collects all data for outputs: totals, post groups, run details, pricing, concrete, tek screws |
| `app.generateOutputs()` | — | Generates HTML output documents |
| `app.generatePDFs()` | — | Generates all PDF documents |
| `app.emailQuote()` | — | Email quote via Web Share API (iPad) or download PDF (desktop) |
| `app.save()` | — | Saves to localStorage |
| `scopeMedia` | ~6008 | Photo/video capture, save/submit flow, PDF generation |
| `scopeMedia.showSaveSubmit()` | ~6183 | Opens save overlay with job summary |
| `scopeMedia.executeSave()` | ~6212 | Saves to IndexedDB with progress tracking |
| `fence3D` | ~6375 | Three.js 3D fence renderer |

### Supplier & Colour Data

| Name | ~Line | Purpose |
|------|-------|---------|
| `SUPPLIER_PROFILES` | ~1456 | `{ RNR: { profiles: ['Ridgeside', 'Sameside'], panelWidth: 2380 }, ... }` |
| `COLOURS_STOCK` | ~1464 | Stock Colorbond colours `[{ name, hex }]` |
| `COLOURS_SPECIAL` | ~1489 | Special-order colours `[{ name, hex }]` |
| `lookupPost(sheetHeight, retaining)` | ~1613 | Post height lookup table based on sheet height + retaining |

### QA Verification System (`qaVerification` object, ~line 5410)

Two-checkpoint quality system:

1. **Scope verification** (sales rep, on-site): 7 traffic-light cards checking job details, fence runs, retaining/posts, gates/extras, fixings/concrete, site photos, pricing. Must sign off before outputs unlock.
2. **Material review** (admin, office): 4 cards checking panels/posts, plinths/patio tubing, gates/concrete/fixings, order preview. Must approve before material order + work order unlock.

Key methods:
- `qaVerification.showScopeVerification()` — opens scope check overlay
- `qaVerification.showMaterialReview()` — opens material review overlay
- `qaVerification.runScopeChecks(d)` — returns array of `{id, card, severity, message, field}` flags
- `qaVerification.runMaterialChecks(d)` — material-focused check array
- `qaVerification._updateButtonStates()` — gates buttons based on verification state

### Button Gating

- **HTML Outputs / All PDFs / Email Quote** → locked until scope signed off
- **Material Order / Work Order** → locked until material review approved
- Scoper can view draft material order (watermarked) before office approval

### Data Flow

```
User configures runs → app.job updates → preview renders
                                        → app._collectOutputData() collects everything
                                        → qaVerification.runScopeChecks(d) validates
                                        → outputs/PDFs generated from collected data
```

---

## Technical Constraints

- **iPad Safari is the primary device** — all touch targets must be ≥44px
- **Works offline** — data saves to IndexedDB/localStorage
- **External dependencies**: jsPDF (PDFs), Three.js (3D preview), html2canvas
- **Supabase integration** loaded separately for cloud save
- **Single file approach** for the main app — `business_rules.js` is the only separate file
- **Test on mobile/tablet** — most field use is on iPad

---

## Key Fencing Concepts

- **Panel** = one fence section between two posts (typically 2380mm wide)
- **Sheet height** = the visible fence height (1500mm, 1800mm, 2100mm standard)
- **Post height** = sheet height + underground depth + retaining height
- **Retaining / Plinths** = concrete sleepers below the fence for sloped ground (max 4-5 per panel)
- **Patio tubes** = steel tubes behind panels with 3+ plinths for structural support
- **Step** = height difference between adjacent panels on sloped ground
- **Gate posts** = 90×90 SHS (NOT C-channel like fence posts)

---

## Common Tasks

### Adding a new compliance check
- Add to `qaVerification.runScopeChecks(d)` for scope-level checks
- Add to `qaVerification.runMaterialChecks(d)` for material-level checks
- Push `{id: 'F-XX', card: 'cardname', severity: 'red'|'amber'|'blue', message: '...', field: 'elementId'}`

### Modifying pricing
- Look for pricing calculations in `app._collectOutputData()`
- Per-metre rates, material costs, labour in that section

### Changing PDF/output format
- `app.generateOutputs()` for HTML outputs
- `app.generatePDFs()` for PDF generation
- Material order format in `qaVerification._buildOrderPreviewText(d)`

### Adding a new supplier
- Add to `SUPPLIER_PROFILES` object (~line 1456)
- Include profile names, panel width, and any special rules

---

## Git Workflow

```bash
# Always pull before starting work
git pull origin main

# After making changes
git add index.html business_rules.js
git commit -m "Description of changes"
git push origin main
```

Or just ask Claude Code to commit and push for you.

---

## Owner

**Marnin Stobbe** — SecureWorks WA founder
- GitHub: marninms98-dotcom
- This tool is for internal use only
