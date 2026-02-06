# SecureWorks WA — Fence Designer Pro: SPEC.md

> **Version:** 1.0  
> **Date:** 6 February 2026  
> **Owner:** Marnin Stobbe, SecureWorks WA  
> **Purpose:** Locked specification for Claude Code development. Do not deviate from this document. If something is ambiguous, ask — don't guess.

---

## 1. WHAT THIS APP IS

A single-page web app (vanilla HTML/CSS/JS, no frameworks) that lets SecureWorks admin staff:

1. Input a fencing job scope (runs, panels, retaining, gates)
2. See a **profile view** of the fence to visually verify before ordering
3. See a **3D view** for a more realistic visual check
4. Click one button to generate three outputs: **Material Order**, **Work Order**, **Quote**
5. Copy any output to clipboard and paste straight into email/Tradify

**This replaces the manual pen-and-paper scope + WhatsApp ordering process.** It is the digital evolution of the fencing master prompt.

**Deployment:** GitHub Pages at `https://marninms98-dotcom.github.io/fence-designer/`  
**Tech:** Single `index.html` file. Vanilla JS. Three.js for 3D (CDN). No build tools.

---

## 2. WHO USES IT

| User | What They Do | What They Need |
|---|---|---|
| **Admin (primary)** | Enters job scope, generates orders | Speed, accuracy, one-click outputs |
| **Estimator** | Verifies scope before ordering | Visual confirmation that panel layout matches site |
| **Installer** | Receives work order on site | Clear per-panel breakdown, post heights, plinth locations |
| **Customer** | Receives quote | Professional-looking document with GST |

---

## 3. DATA MODEL

### 3.1 Job (top level)

```
job = {
  ref: "SW9248",           // auto-generated or manual
  client: "",              // client name
  address: "",             // property address
  supplier: "RNR",         // "RNR" | "Metroll" | "Lysaght" | "Stratco"
  profile: "trimclad",    // "trimclad" | "harmony" | "corrugated" — see Section 4B
  colour: "Shale Grey",   // Colorbond colour name (with hex code — see Section 9)
  pricePerMetre: 115,      // $/metre for quick estimate
  runs: [],                // array of Run objects
  gates: [],               // array of Gate objects
  date: "2026-02-06"       // today's date
}
```

### 3.2 Run

A run is one continuous fence line (e.g., "Rear", "LHS", "RHS", "Front").

```
run = {
  name: "Rear",                // user-editable
  length: 19.0,                // in metres (entered by user, 0.5m increments)
  sheetHeight: 1800,           // 1200 | 1500 | 1800 | 2100 (mm) — default sheet height for run
  extension: "none",           // "none" | "slat" | "solid_fill" | "lattice"
  panels: []                   // array of Panel objects
}
```

**Length constraint:** Input must step in 0.5m increments (e.g., 10.0, 10.5, 11.0). Use `step="0.5"` on the input.

**Panel count is auto-calculated:** `Math.ceil(run.length / panelWidth)` where panelWidth depends on supplier.

**Sheet heights available:**
| Height | Common Use |
|---|---|
| 1200mm | Pool fencing, front fences |
| 1500mm | Front fences, low boundary |
| 1800mm | Standard boundary fence (default) |
| 2100mm | Privacy fence, commercial |

### 3.3 Panel

```
panel = {
  height: 1800,        // inherits from run's sheetHeight, can be overridden per-panel (1200|1500|1800|2100)
  retaining: 0,        // retaining height in mm: 0, 150, 300, 450, 600, 750 (DROPDOWN, not free text)
  ground: "level"      // "level" | "up" | "down" — visual indicator only
}
```

**Derived values (calculated, not stored):**
- `plinths = retaining / 150` (e.g., 450mm retaining = 3 plinths)
- `totalHeight = height + retaining` (what neighbour sees on low side)
- `postHeight = getPostHeight(panel, adjacentPanels)` (see Section 6)
- `needsPatioTube = plinths >= 3 && plinths <= 5`

**Example combinations:**
- 1500mm sheet + 300mm retaining (2 plinths) = 1800mm total fence → 2400mm posts
- 1800mm sheet + 450mm retaining (3 plinths) = 2250mm total fence → 2700mm posts + patio tube
- 1800mm sheet + 0mm retaining = 1800mm total fence → 2400mm posts

### 3.4 Gate

```
gate = {
  type: "pedestrian",    // "pedestrian" | "double" | "sliding"
  width: 900,            // mm
  runIndex: 0,           // which run this gate belongs to
  afterPanel: 8          // positioned after panel X in the run
}
```

### 3.5 Supplier Panel Widths

| Supplier | Panel Width (mm) | Code | Available Profiles |
|---|---|---|---|
| RnR Fencing | 2380 | `RNR` | Ridgeside (≈Trimclad), Sameside (≈Harmony) |
| Metroll | 2365 | `Metroll` | Trimclad, Harmony, Corodek, MAC Atlas/Gemini/Polaris |
| Lysaght | 2360 | `Lysaght` | Neetascreen (≈Trimclad), Smartascreen (≈Harmony), Miniscreen |
| Stratco | 2350 | `Stratco` | Superdek (≈Trimclad), Wavelok (≈Harmony), CGI |

**NEVER mix suppliers on the same job.** Supplier is set at job level. Sheets, posts, and rails from different manufacturers CANNOT be mixed — different panel widths and proprietary locking mechanisms. Mixing voids BlueScope's 15-year fencing warranty.

---

## 4. UI LAYOUT

### 4.1 Page Structure

```
┌──────────────────────────────────────────────────────────┐
│  HEADER BAR (fixed top, dark green #1a3a2a)              │
│  [SW Logo] Job Ref | Client | Address | Supplier | Profile │
│  Colour | $/Metre                          [Saved] [New] │
├────────────────────┬─────────────────────────────────────┤
│  LEFT PANEL (40%)  │  RIGHT PANEL (60%)                  │
│  ┌──────────────┐  │  ┌─────────────────────────────────┐│
│  │ Run Tabs     │  │  │ [Profile View] [3D View] tabs   ││
│  │ + Add Run    │  │  │                                 ││
│  ├──────────────┤  │  │  VISUALIZER AREA                ││
│  │ Run Settings │  │  │  (canvas / three.js)            ││
│  │ Name, Length │  │  │                                 ││
│  │ Height, Ext  │  │  │                                 ││
│  ├──────────────┤  │  │                                 ││
│  │ Quick Tools  │  │  │                                 ││
│  │ Retaining    │  │  └─────────────────────────────────┘│
│  ├──────────────┤  │  ┌─────────────────────────────────┐│
│  │ PANEL TABLE  │  │  │ STATS BAR                       ││
│  │ (scrollable) │  │  │ 19.0m | 8 panels | 9 posts |   ││
│  │              │  │  │ 21 plinths | $2,409 est        ││
│  │              │  │  └─────────────────────────────────┘│
│  ├──────────────┤  │  ┌─────────────────────────────────┐│
│  │ GATES        │  │  │ [Generate Outputs] button       ││
│  │ + Add Gate   │  │  └─────────────────────────────────┘│
│  └──────────────┘  │                                     │
└────────────────────┴─────────────────────────────────────┘
```

### 4.2 Left Panel — Width: 40% of viewport (min 450px)

The left panel is the **workspace**. This is where all input happens.

**Run Tabs:** Horizontal chips showing run name + panel count. Active run highlighted. "+ Add Run" button (dashed border).

**Run Settings Block:**
- Run Name: text input (default: "Rear", "LHS", "RHS", "Front")
- Total Length: number input in metres, step 0.5 (e.g., 19.0, 19.5, 20.0)
- Sheet Height: dropdown — 1200 | 1500 | 1800 (default) | 2100 (mm) — default sheet height for all panels in run
- Extension: dropdown — None | Slat | Solid Fill | Lattice
- "Apply Height to All" button
- "Delete Run" button (red text)

**Quick Retaining Tool:**
- Highlighted block (light green/yellow background)
- "Panels [1] to [3] → [retaining dropdown: 0|150|300|450|600|750 mm] [Apply]"
- Retaining MUST be a dropdown with fixed 150mm increments, NOT a free text number input
- This is the #1 productivity feature. Lets user set retaining for a range of panels in one click instead of clicking 8 dropdowns individually.

**Panel Table:**
- Scrollable area with max-height (fills remaining space)
- Sticky header row

| Column | Header | Width | Content |
|---|---|---|---|
| # | P# | 30px | Panel number (P1, P2...). Click to select/highlight in viz. |
| HEIGHT | Ht | 50px | Dropdown: 1200 / 1500 / 1800 / 2100. Shows "12", "15", "18", or "21" for space. |
| RET | Ret | 60px | Dropdown: 0, 150, 300, 450, 600, 750 (mm). |
| PLINTHS | Pl | 30px | Calculated display: 0, 1, 2, 3, 4, 5. Read-only. |
| STEP | Stp | 30px | Arrow indicator: — (level), ↑ (up), ↓ (down). Read-only. |
| TOTAL | Tot | 45px | fence height + retaining (mm). Highlighted if > 1800. |
| POST | Post | 55px | Calculated post height. Orange with † if patio tube needed. |
| × | | 20px | Delete panel button. |

**Important table UX rules:**
- The P# column must NOT be cut off on the left
- All headers must be fully visible and legible
- Dropdown text should show abbreviated values to save space (e.g., "450" not "450mm")
- Total column: green text if standard (1800), orange if elevated (>1800)
- Post column: orange with † symbol if patio tube is required for that panel

**Gates Section:**
- Below the panel table
- "+ Add Gate" button
- Each gate shows: Type dropdown | Width | Run | After Panel # | Delete ×

### 4.3 Right Panel — Width: 60% of viewport

**View Tabs:** "Profile View" | "3D View" (toggle between two views)

**Stats Bar** (always visible, below the visualizer):
- Total metres (with panel calculation, e.g., "19.0 METRES / 8 × 2380mm")
- Panel count
- Post count
- Plinth count
- Estimated total price (green badge: "$2,409 EST. TOTAL")

**Generate Outputs Button:** Large, prominent, bottom-right. Opens modal with Material Order / Work Order / Quote tabs.

### 4.4 Colour Scheme

| Element | Colour | Hex |
|---|---|---|
| Header bar | Dark green | `#1a3a2a` |
| Header text | White | `#ffffff` |
| Run tab (active) | Teal | `#0d9488` |
| Run tab (inactive) | Light grey | `#e5e7eb` |
| Quick retaining bg | Light amber | `#fef3c7` |
| Panel table header | Medium grey | `#f3f4f6` |
| Total > 1800 | Orange | `#ea580c` |
| Post with patio tube | Orange + † | `#ea580c` |
| Generate button | Teal | `#0d9488` |
| Price badge | Green | `#16a34a` |
| Delete buttons | Red text | `#dc2626` |
| Body background | Light grey | `#f8fafc` |

---

## 4B. FENCE PROFILE CROSS-SECTIONS (FOR RENDERING)

The `profile` field on the Job determines the corrugation pattern used in both the Profile View (2D canvas) and 3D View (Three.js). Each profile has specific geometry the renderer must reproduce.

### Profile 1: Trimclad / Trimdek / Superdek / Ridgeside — "trimclad"

**This is the most common fencing profile in Perth. Default selection.**

Cross-section type: **5-rib trapezoidal** (different appearance each side)

| Dimension | Value |
|---|---|
| Cover width | 762 mm |
| Rib height (profile depth) | 29 mm |
| Pan width (flat between ribs) | ~130 mm |
| Rib crest width (flat top) | ~60 mm |
| Rib pitch (centre-to-centre) | ~152 mm (762 ÷ 5) |
| Flank angle | ~70-75° from horizontal |
| Total ribs per sheet | 5 (but 1 overlaps = 4 visible per sheet) |
| BMT | 0.35 mm |

**How to render (2D Profile View):**
Each panel face = repeating unit of: `flat pan (130px scaled) → sloped flank up → flat rib crest (60px scaled) → sloped flank down → flat pan`
- Ribs get a lighter shade (highlight — the crest catches light)
- Pans get a slightly darker shade (recessed, in shadow)
- The flank transitions create the depth illusion
- Pan has a subtle 2mm centre flute (tiny bump at midpoint) — optional but adds realism

**How to render (3D View):**
Use custom BufferGeometry or displacement map. The cross-section is a trapezoid wave:
```
For each rib: base_width=130mm, top_width=60mm, height=29mm
Pattern repeats every 152mm across the sheet face
```

**Brand equivalents:** Metroll Trimclad, Lysaght Trimdek/Neetascreen, Stratco Superdek, RnR Ridgeside

**Reference images (for visual accuracy):**
- Metroll Trimclad technical drawing: https://www.metroll.com.au/wp-content/uploads/metroll_trimclad_24.pdf (page 1 cross-section)
- Steel Select dimension diagram: https://steelselect.com.au/products/lysaght/lysaght-trimdek
- Installed fence photo reference: https://steelselect.com.au/products/rr-fencing/rr-fencing-ridgeside

---

### Profile 2: Harmony / Metline / Wavelok / Sameside — "harmony"

**The "good neighbour" profile — identical appearance both sides.**

Cross-section type: **Symmetric multi-rib** (more numerous, narrower ribs than Trimclad)

| Dimension | Value | Confidence |
|---|---|---|
| Cover width | ~762 mm | High (3-sheet panel = 2365mm) |
| Rib height | ~20-25 mm | Medium (not published — estimate from photos) |
| Number of ribs | 6-8 | Medium (more than Trimclad's 5) |
| Rib shape | Symmetric trapezoid | High |
| BMT | 0.35 mm | Confirmed |

**How to render (2D):**
Same concept as Trimclad but with **more frequent, narrower ribs**. Key visual difference: the ribs are closer together and the pans are narrower. Both faces look the same (symmetric).

**How to render (3D):**
Narrower trapezoid wave: `rib_pitch ≈ 100mm` (vs Trimclad's 152mm), `rib_height ≈ 22mm` (vs 29mm). The shorter, more frequent ribs give a smoother, more refined appearance.

**Brand equivalents:** Metroll Harmony (WA name) / Metline (east coast), Stratco Wavelok, Lysaght Smartascreen, RnR Sameside

**Reference images:**
- Metroll Harmony product page: https://www.metroll.com.au/products/colorbond-fencing/metline-harmony-colorbond-fencing/
- Steel Select dimension diagram: search "Metroll Metline Harmony" on steelselect.com.au
- BIMstore 3D model available: https://www.bimstore.co/products/metline-fencing

---

### Profile 3: Corrugated (CGI) — "corrugated"

**Traditional Australian sinusoidal wave.**

Cross-section type: **Pure sine wave**

| Dimension | Value |
|---|---|
| Cover width | 762 mm |
| Rib height (peak-to-trough) | 16 mm |
| Corrugation pitch | 76 mm |
| Waves per sheet | 10 |
| BMT (fencing) | 0.35 mm |

**How to render (2D + 3D):**
Mathematical sine wave: `y = 8 × sin(2π × x / 76)` where amplitude = 8mm (half of 16mm peak-to-trough). This is the simplest profile to render parametrically.

**Brand equivalents:** Metroll Corodek, Lysaght Custom Orb/Customscreen, Stratco CGI Corrugated

**Reference images:**
- Steel Select CGI diagram: https://steelselect.com.au/products/stratco/stratco-cgi-corrugated

---

### Profile Selector in UI

The profile dropdown should appear in the **Header bar** next to Supplier.

**Display names change based on selected supplier:**

| Profile Code | RNR | Metroll | Lysaght | Stratco |
|---|---|---|---|---|
| `trimclad` | Ridgeside | Trimclad | Neetascreen | Superdek |
| `harmony` | Sameside | Harmony | Smartascreen | Wavelok |
| `corrugated` | Corrugated | Corodek | Customscreen | CGI Corrugated |

Default profile: `trimclad`

When supplier changes: update the profile dropdown labels to match that supplier's product names.
When profile changes: re-render both Profile View and 3D View with the new corrugation pattern. All calculations stay the same (panel count, post heights etc are profile-independent).

---

## 5. PROFILE VIEW SPECIFICATION

The profile view is a 2D canvas rendering showing the fence from the **side elevation** — as if you're standing in the neighbour's yard looking at the fence.

### 5.1 What It Must Show

For each panel in the active run:
- **Fence sheets** with vertical corrugation lines (pattern varies by selected profile — see Section 4B)
- **Posts** between panels (darker grey, narrower than panels)
- **Post caps** (small pyramid/triangle on top of each post)
- **Top capping rail** (horizontal bar across top of fence)
- **Plinths** below the fence sheet (stacked grey blocks under each panel)
- **Ground line** — TWO lines if retaining present:
  - **High side** (customer's side) = green line at fence base
  - **Low side** (neighbour's side) = brown line at bottom of plinths
- **Post below ground** — show the post extending below ground into the footing (dashed or lighter)
- **Panel numbers** — circle with number centred on each panel (for matching to table)
- **Run label** — "Rear · 8 panels · 19.0m" centred above

### 5.2 Visual Quality Requirements

**The fence must look like actual Colorbond fencing, not a children's drawing.**

- Corrugation pattern: Render according to the selected profile (see Section 4B). The default Trimclad pattern uses vertical lines with alternating widths — wide flat pans (~20px) separated by narrow raised ribs (~3px). The ribs should have a slight highlight (lighter shade) and the pans a slightly darker shade. Other profiles have different patterns — Harmony has more frequent narrower ribs, Corrugated is a smooth sine wave.
- Posts: Darker shade than fence sheets. Narrower. Show the C-channel profile shape or at minimum a distinct rectangular post.
- Post caps: Small triangular/pyramid shape on top.
- Plinths: Grey rectangular blocks, each 150mm tall. Stack visually under the panel. Slightly different shade to fence sheets.
- Ground: Not a flat green bar. Use a gradient — green grass on top transitioning to brown earth/dirt below.
- Footing: Posts extend below ground as dashed lines to indicate embedment depth.

### 5.3 Scaling

- The fence should fill approximately 70% of the canvas height
- Horizontal: all panels should be visible without scrolling
- If there are many panels (>10), scale down proportionally
- Maintain correct aspect ratio — panels are WIDE (2380mm) and tall (1800mm), roughly 1.3:1 width:height

### 5.4 Interaction

- Click a panel number to highlight it (green border/glow) and scroll to it in the panel table
- Hover over a panel to show tooltip: "P3: 1800mm fence + 300mm ret = 2100mm total | Post: 2700mm"

---

## 6. CALCULATION RULES (CRITICAL — ALL MUST BE EXACT)

### 6.1 Panel Count

```
panelCount = Math.ceil(runLength / panelWidth)
```

Panel widths by supplier:
- RNR: 2380mm (2.380m)
- Metroll: 2365mm (2.365m)
- Lysaght: 2360mm (2.360m)

Example: 19.04m run with RNR → 19040 / 2380 = 8.0 → 8 panels

### 6.2 Post Count

```
Per run: postsInRun = panels + 1
```

**Corner posts (where two runs meet):** Shared. Count once, not twice.
- If Rear + LHS both exist: total posts = (rearPanels + 1) + (lhsPanels + 1) - 1

**Gate posts:** 90×90mm SHS (NOT C-channel). Separate from fence posts.
- Pedestrian gate: +2 gate posts
- Double swing gate: +4 gate posts (2 per leaf)

### 6.3 Post Height Calculation

This is **per-post**, not per-run. Each post must accommodate the tallest adjacent panel.

```
For post at position i (between panel i-1 and panel i):
  leftPanel = panels[i-1] (if exists)
  rightPanel = panels[i] (if exists)

  leftTotal = leftPanel ? leftPanel.height + leftPanel.retaining : 0
  rightTotal = rightPanel ? rightPanel.height + rightPanel.retaining : 0

  maxTotalHeight = Math.max(leftTotal, rightTotal)
  requiredPostHeight = maxTotalHeight + 600  // 600mm embedment

  // Snap to available post sizes
  if (requiredPostHeight <= 2400) postHeight = 2400
  else if (requiredPostHeight <= 2700) postHeight = 2700
  else if (requiredPostHeight <= 3000) postHeight = 3000
  else postHeight = 3000  // + patio tube flag
```

**Available post sizes:** 2400, 2700, 3000mm (from Metroll stock range)

**Post height lookup table (1200mm sheet height):**

| Plinths | Retaining | Total Fence | Required (+ 600mm) | Post Size |
|---|---|---|---|---|
| 0 | 0 | 1200 | 1800 | 2400mm |
| 1 | 150 | 1350 | 1950 | 2400mm |
| 2 | 300 | 1500 | 2100 | 2400mm |
| 3 | 450 | 1650 | 2250 | 2400mm |
| 4 | 600 | 1800 | 2400 | 2400mm |
| 5 | 750 | 1950 | 2550 | 2700mm |

**Post height lookup table (1500mm sheet height):**

| Plinths | Retaining | Total Fence | Required (+ 600mm) | Post Size |
|---|---|---|---|---|
| 0 | 0 | 1500 | 2100 | 2400mm |
| 1 | 150 | 1650 | 2250 | 2400mm |
| 2 | 300 | 1800 | 2400 | 2400mm |
| 3 | 450 | 1950 | 2550 | 2700mm |
| 4 | 600 | 2100 | 2700 | 2700mm |
| 5 | 750 | 2250 | 2850 | 3000mm |

**Post height lookup table (1800mm sheet height):**

| Plinths | Retaining | Total Fence | Required (+ 600mm) | Post Size |
|---|---|---|---|---|
| 0 | 0 | 1800 | 2400 | 2400mm |
| 1 | 150 | 1950 | 2550 | 2700mm |
| 2 | 300 | 2100 | 2700 | 2700mm |
| 3 | 450 | 2250 | 2850 | 3000mm |
| 4 | 600 | 2400 | 3000 | 3000mm |
| 5 | 750 | 2550 | 3150 | 3000mm + patio tube |

**Post height lookup table (2100mm sheet height):**

| Plinths | Retaining | Total Fence | Required (+ 600mm) | Post Size |
|---|---|---|---|---|
| 0 | 0 | 2100 | 2700 | 2700mm |
| 1 | 150 | 2250 | 2850 | 3000mm |
| 2 | 300 | 2400 | 3000 | 3000mm |
| 3+ | 450+ | 2550+ | 3150+ | 3000mm + patio tube |

### 6.4 Patio Tube Calculation

**Patio tubing (76×38mm RHS × 3000mm) is required when ANY panel has 3–5 plinths stacked underneath.**

```
Quantity per run:
  panelsNeedingTube = count of panels where plinths >= 3 AND plinths <= 5
  patioTubes = panelsNeedingTube > 0 ? panelsNeedingTube + 1 : 0
```

Why +1: Adjacent panels with 3+ plinths share a tube between them. So 3 consecutive panels needing tubes = 4 tubes (left + shared + shared + right).

**CRITICAL LIMIT:** If any panel has 6+ plinths (≥900mm retaining), STOP. Flag: "This job requires post & panel retaining, not Colorbond fencing with plinths."

### 6.5 Concrete Calculation

```
bags = Math.ceil((totalPosts * 2 * 1.1) / 2) * 2
```

- 2 bags Kwikset per post (standard 600mm depth)
- ×1.1 waste factor
- Round UP to nearest even number (bags sold in pairs)

Example: 9 posts × 2 = 18 × 1.1 = 19.8 → round up to 20 bags

### 6.6 Price Estimate

Quick estimate shown in stats bar (NOT the formal quote):

```
estimate = totalMetres * pricePerMetre * 1.1  // includes 10% GST
```

The formal quote uses the full pricing structure (see Section 8).

---

## 7. 3D VIEW SPECIFICATION

### 7.1 Technology

Three.js loaded from CDN. Lazy initialization — only load/render when "3D View" tab is clicked.

### 7.2 Camera

- **Initial position:** Angled view from above-right (like standing at one end of the fence looking along it)
- **Distance:** Camera should position so the fence fills approximately 70-80% of the viewport width
- **Formula:** `distance = Math.max(3, totalFenceWidth * 0.5)` — adjusted from previous versions that were way too far
- **Controls:** OrbitControls — drag to rotate, scroll to zoom
- **Auto-frame:** When panels are added/removed, recalculate camera to keep fence centred

### 7.3 Fence Geometry

Each panel consists of:
- **Fence sheet:** A box geometry with corrugated surface matching the selected profile (see Section 4B for exact geometry per profile). Use a displacement map or custom BufferGeometry to create the rib pattern on the face. Trimclad = trapezoidal ribs, Harmony = narrower symmetric ribs, Corrugated = sine wave. If custom geometry is too complex, use a normal map texture to simulate the ribs.
- **Posts:** Box geometry, darker colour, positioned between panels. Height extends from below ground to top.
- **Top rail / capping:** Thin box along the top of each panel.
- **Post caps:** Small pyramid (ConeGeometry) on top of each post.
- **Plinths:** Grey box geometries stacked below the fence sheet, each 150mm tall.

### 7.4 Materials & Lighting

- **Fence material:** MeshStandardMaterial with:
  - Colour matching the selected Colorbond colour
  - Metalness: 0.5-0.6 (painted steel has moderate metallic sheen)
  - Roughness: 0.4-0.5 (not mirror-smooth, not matte)
- **Post material:** Same colour but slightly darker (multiply by 0.85)
- **Plinth material:** Grey (#9ca3af), roughness 0.7
- **Ground plane:** Large flat plane with grass-green colour (#4ade80), extending well beyond the fence
- **Lighting:**
  - Directional light (sun) from upper-right, casting shadows
  - Hemisphere light (sky blue top, earth brown bottom) for ambient
  - Ambient light at low intensity for fill
- **Tone mapping:** ACESFilmicToneMapping for realistic colour response
- **Shadows:** Enabled on the ground plane. Soft shadows preferred.

### 7.5 Ground & Terrain

- Ground should follow the retaining profile: where panels have retaining (plinths), the ground steps down on the neighbour's side
- Simple implementation: create separate ground mesh sections at each panel, offset by the retaining height

### 7.6 Performance

- Dispose of Three.js objects when switching away from 3D tab
- Don't reinitialize on every data change — update positions/geometries
- Keep total polygon count reasonable (< 50k faces)

---

## 8. OUTPUT DOCUMENTS

All three outputs are displayed in a modal dialog with tabs. Each has a "Copy" button that copies the plain text to clipboard.

### 8.1 Material Order

This is an email to the supplier. Format must match what RnR/Metroll/Fencing Warehouse expect.

```
SECUREWORKS WA PTY LTD
Material Order

Job Ref: {job.ref}
Customer: {job.client}
Delivery Address: {job.address}
Site Contact: 0489 267 772
Delivery Date: {tomorrow's date} | Time: 8-10am
Supplier: {supplierName}

────────────────────────────────────────
ORDER DETAILS:
────────────────────────────────────────

PANELS & POSTS:
{Group by post height — list each distinct height separately}

{count} × {height}H × {panelWidth}W panels W/ {postHeight}H posts
    Profile: {profile} Equivalent
    Colour: {colour}

{If different post heights exist, separate lines:}
{count} × 1800H × 2380W panels W/ 2400H posts
    Profile: RnR Trimclad Equivalent
    Colour: Shale Grey

{count} × 1800H × 2380W panels W/ 3000H posts
    Profile: RnR Trimclad Equivalent
    Colour: Shale Grey

PLINTHS:
{totalPlinths} × 150mm Plinths — {colour}

{If patio tubes needed:}
PATIO TUBING:
{patioTubeQty} × 76x38 RHS Patio Tube @ 3000mm
    (Calculation: {panelsWith3to5plinths} panels with 3+ plinths + 1 = {qty} tubes)

{If gates:}
GATE POSTS:
{gatePostQty} × 90x90mm Gate Posts

GATE KITS:
{count} × Pedestrian gate kit | 900mm W | 1750mm H | {colour}

CONCRETE:
{concreteBags} × Bags Quickset Concrete

FIXINGS:
Fixings, Post Caps, Screws as required

────────────────────────────────────────

Please confirm. Thanks!

SecureWorks WA
fencing@secureworkswa.com.au | 0489 267 772
```

**Grouping rule:** Panels are grouped by post height. If a run has 6 panels with 2400mm posts and 2 panels with 3000mm posts, show two separate line items. Standard C-channel posts are INCLUDED with panel kits — do not list them separately.

### 8.2 Work Order

This goes to the installation crew. Must contain everything they need on site.

```
═══════════════════════════════════════
          WORK ORDER — {job.ref}
═══════════════════════════════════════

Client:    {job.client}
Address:   {job.address}
Date:      {job.date}

────────────────────────────────────────
FENCE RUNS
────────────────────────────────────────

{For each run:}
{run.name} ({panelCount} panels, {length}m) [{patioTubes} patio tubes]

  {For each panel:}
  P{n}: {height}mm fence + {retaining}mm ret = {total}mm total {† if patio tube}

  {Or simplified if no retaining in entire run:}
  P1-P8: 1800mm fence, 0mm retaining | Post height: 2400mm

────────────────────────────────────────
GATES
────────────────────────────────────────

{gate details or "None"}

────────────────────────────────────────
SUMMARY
────────────────────────────────────────

Total Length:   {metres}m
Panels:         {count}
Posts:          {count} ({breakdown by height})
Plinths:        {count}
Patio Tubes:    {count}
Concrete:       {bags} bags
Supplier:       {supplier}
Colour:         {colour}
Profile:        {profile}
```

### 8.3 Quote

Customer-facing document. Professional, clean, includes GST.

```
═══════════════════════════════════════
         QUOTE — {job.ref}
═══════════════════════════════════════

Client: {job.client}

────────────────────────────────────────
SCOPE OF WORKS
────────────────────────────────────────

{totalMetres}m Colorbond Fencing
Colour: {colour}

Includes:
• Supply of all materials
• Professional installation
• Posts set in concrete
• Site clean up

{If retaining:}
• Retaining plinths ({plinthCount} plinths across {panelsWithRetaining} panels)

{If gates:}
• {gateDescription}

{If removal:}
• Removal and disposal of existing fence

────────────────────────────────────────
PRICING (@ ${pricePerMetre}/m)
────────────────────────────────────────

Subtotal:     $  {subtotal}
GST (10%):    $  {gst}
              ─────────────
TOTAL:        $  {total}

────────────────────────────────────────

Quote valid for 30 days.

SecureWorks WA
ABN: 64 689 223 416
fencing@secureworkswa.com.au | 0489 267 772
```

---

## 9. COLORBOND FENCING COLOUR PALETTE

BlueScope maintains a **dedicated 15-colour fencing palette** that is smaller than the 22-colour roofing range. The colour dropdown must use these exact hex values (sourced from BlueScope Steel Select). Use hex code for the `MeshStandardMaterial.color` in Three.js and for canvas fill in Profile View.

### 9.1 Core Fencing Colours (15 colours)

**Pale tones:**

| Colour | Hex | RGB | Category |
|---|---|---|---|
| Surfmist | `#E4E2D5` | 228, 226, 213 | Stock |
| Domain | `#E8DBAE` | 232, 219, 174 | Stock · Fencing exclusive |
| Evening Haze | `#C5C2AA` | 197, 194, 170 | Stock |
| Paperbark | `#CABFA4` | 202, 191, 164 | Stock |

**Mid tones:**

| Colour | Hex | RGB | Category |
|---|---|---|---|
| Dune | `#B1ADA3` | 177, 173, 163 | Stock |
| Shale Grey | `#BDBFBA` | 189, 191, 186 | Stock · **DEFAULT** |
| Riversand | `#9D8D76` | 157, 141, 118 | Stock · Fencing exclusive |
| Bluegum | `#969799` | 150, 151, 153 | Stock |
| Pale Eucalypt | `#7C846A` | 124, 132, 106 | Stock |
| Wilderness | `#64715E` | 100, 113, 94 | Stock · Fencing exclusive |

**Deep tones:**

| Colour | Hex | RGB | Category |
|---|---|---|---|
| Basalt | `#6D6C6E` | 109, 108, 110 | Stock |
| Woodland Grey | `#4B4C46` | 75, 76, 70 | Stock |
| Ironstone | `#3E434C` | 62, 67, 76 | Stock |
| Monument | `#323233` | 50, 50, 51 | Stock |
| Wollemi | `#0A1C0D` | 10, 28, 13 | Stock · Fencing exclusive |

### 9.2 Extended Range (Special Order — flag with "SO" label)

These are available from some suppliers but not stock for fencing:

| Colour | Hex | RGB | Notes |
|---|---|---|---|
| Deep Ocean | `#364152` | 54, 65, 82 | Special order |
| Cottage Green | `#304C3C` | 48, 76, 60 | Special order |
| Night Sky | `#2E2E2F` | 46, 46, 47 | Post & rail only |
| Manor Red | `#5E1D0E` | 94, 29, 14 | Special order |
| Jasper | `#6C6153` | 108, 97, 83 | Special order |
| Windspray | `#888B8A` | 136, 139, 138 | Special order |

### 9.3 Colour Dropdown Implementation

- Show colour name + small colour swatch square next to each option
- Group as: "── Stock ──" then "── Special Order ──"
- Default: Shale Grey
- When colour changes: immediately update fence colour in Profile View and 3D View
- For 3D material: use `MeshStandardMaterial` with `metalness: 0.5, roughness: 0.5` — this approximates the Classic COLORBOND® painted steel finish
- For posts: same colour hex but multiply by 0.85 for slightly darker shade
- For the colour swatch in the dropdown: use the hex as a flat CSS background-color

### 9.4 Hex Source

All hex values sourced from **BlueScope Steel Select** (steelselect.com.au/colours) — the official digital colour reference. BlueScope notes these are guide values for screen rendering and may not perfectly match physical samples.

---

## 10. INTERACTION RULES

### 10.1 Adding a Run

1. Click "+ Add Run"
2. Default name cycles: Rear → LHS → RHS → Front → Custom
3. Default length: blank (must enter)
4. Default height: 1800mm
5. Panels auto-calculated when length is entered

### 10.2 Changing Run Length

When length changes, recalculate panel count. If panel count changes:
- If increased: add new panels at end with default values (0 retaining, run height)
- If decreased: remove panels from end (with confirmation if they have retaining data)

### 10.3 Changing Retaining on a Panel

When retaining changes on any panel:
- Recalculate plinths for that panel
- Recalculate post heights for adjacent posts (left and right)
- Recalculate patio tube requirement for the run
- Update profile view and 3D view
- Update stats bar

### 10.4 Quick Retaining

"Panels [from] to [to] → [retaining mm] [Apply]"
- Sets retaining value on all panels in range
- Immediately recalculates everything
- This is how 90% of retaining gets entered (not panel-by-panel)

### 10.5 Auto-save

- Save to `localStorage` after every change (key: `fenceJob`)
- Show "Saved" indicator in header
- "New Job" clears everything (with confirmation)
- On page load, restore from localStorage if data exists

### 10.6 Generate Outputs

- Click "Generate Outputs" button
- Opens modal with three tabs: Material Order | Work Order | Quote
- Each tab shows the formatted text
- "Copy" button copies plain text to clipboard
- "Close" button dismisses modal

---

## 11. COMPLIANCE FLAGS

The app should show warning banners when these conditions are detected:

| Condition | Warning |
|---|---|
| Any panel has 6+ plinths (≥900mm retaining) | 🔴 "STOP: Exceeds Colorbond plinth capacity. Requires post & panel retaining system." |
| Front fence > 1200mm solid | ⚠️ "Front fences >1.2m solid require Development Approval per R-Codes" |
| Total retaining > 500mm at any panel | ⚠️ "Retaining >500mm requires Building Permit + Engineer Cert in WA" |

---

## 12. KNOWN BUGS IN CURRENT VERSION (V13) — FIX THESE

1. **Panel table P# column cut off** — The leftmost column is partially hidden. Ensure full visibility.
2. **Height dropdown shows "1" not "1800"** — Confusing. Show "18" or "1800" to be clear.
3. **Profile view corrugation looks flat** — Needs proper light/shadow on ribs. See Section 5.2.
4. **3D view corrugation looks like MS Paint** — Needs proper geometry or normal maps. See Section 7.3.
5. **Stats bar shows "21 PLINTHS" with no context** — Should clarify: "21 plinths (across 7 panels)"
6. **Patio tube count in work order may be wrong** — Verify against Section 6.4 formula.
7. **Post height should be per-post, not per-panel** — Each post sits between two panels and must accommodate the taller one.

---

## 13. WHAT NOT TO BUILD (YET)

These are future features. Do not implement now:

- PDF export (copy-paste to email is fine for now)
- Customer database / saved jobs
- Mobile-responsive layout (desktop-only is fine)
- Drag-and-drop panel reordering
- Photo upload / site map overlay
- Multi-user / login system
- Integration with Tradify or Xero
- Formal cost-based quoting with margins (just $/metre for now)
- Sliding gate calculations
- Pool fence compliance (AS 1926)
- Stepped/raked fence on slopes (just retaining for now)

---

## 14. TESTING CHECKLIST

Before any version is considered "done", verify these scenarios:

### Basic Scenarios
- [ ] Single run, 8 panels, no retaining → 9 posts at 2400mm, 0 patio tubes
- [ ] Single run, 8 panels, all panels 3 plinths → 9 posts at 3000mm, 8+1=9 patio tubes
- [ ] Single run, 8 panels, panels 1-3 have 2 plinths, 4-8 have 0 → posts at 2700mm for panels 1-4, 2400mm for panels 5-9

### Edge Cases
- [ ] Single panel run (1 panel, 2 posts)
- [ ] Two runs meeting at corner (corner post shared, subtract 1)
- [ ] Panel with 5 plinths (750mm) → 3000mm post + patio tube flag
- [ ] Panel with 6 plinths → STOP warning, no output generated
- [ ] Mix of 1800mm and 2100mm panels in same run (if allowing per-panel height)

### Gate Scenarios
- [ ] 1 pedestrian gate → +2 posts (90×90mm)
- [ ] 1 double gate → +4 posts (90×90mm)

### Calculation Verification
- [ ] 18m Metroll run: 18000/2365 = 7.61 → 8 panels, 9 posts
- [ ] 9 posts → concrete: 9×2=18, ×1.1=19.8, round up to 20 bags
- [ ] Price estimate: 18m × $115 × 1.1 = $2,277

### Output Verification
- [ ] Material order groups panels by post height
- [ ] Material order does NOT list C-channel posts separately
- [ ] Work order shows per-panel breakdown when retaining exists
- [ ] Quote shows GST calculated correctly (subtotal × 0.10)

---

## 15. FILE STRUCTURE

```
fence-designer/
├── index.html          ← Single file, everything inline
├── SPEC.md             ← This document (reference only, not deployed)
└── README.md           ← Brief description + link to live site
```

Everything lives in `index.html`. CSS is in a `<style>` block. JavaScript is in a `<script>` block. Three.js loaded from CDN.

---

## 16. HOW TO USE THIS DOCUMENT

When working with Claude Code:

1. **Start every session** by saying: "Read SPEC.md first. This is the locked specification."
2. **For bug fixes:** Reference the section number. "Fix the post height calculation — see SPEC Section 6.3."
3. **For new features:** Only add features listed in this document. If it's in Section 13 (Not Yet), don't build it.
4. **For visual changes:** Reference Section 5 (Profile View) or Section 7 (3D View) for exact requirements.
5. **For calculation changes:** Reference Section 6. Every formula is documented. Don't invent new ones.
6. **After changes:** Run through the Testing Checklist (Section 14) before pushing.

**Do not deviate from this document without explicit approval.**

---

*End of SPEC.md v1.0*
