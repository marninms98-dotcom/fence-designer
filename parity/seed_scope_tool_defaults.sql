-- ============================================================================
-- SecureWorks Group — Master Price Table seed for scope_tool_defaults
-- ----------------------------------------------------------------------------
-- Source : every hardcoded rate in patio-tool/index.html and
--          fence-designer (business_rules.js + index.html overlay).
-- Tag    : seed-from-tool-hardcoded 2026-06-11
-- Safety : INSERT ... ON CONFLICT (org_id, scope_tool, category, item_key)
--          DO UPDATE — idempotent, re-runnable, updates existing rows.
--
-- IMPORTANT CONVENTIONS (verified against LIVE rows, do not change):
--   * scope_tool values are 'patio-tool' and 'fence-designer'
--     (NOT 'patio'/'fencing' — the UNIQUE key + existing 49 rows use the
--      long form; using short form would create duplicates).
--   * Existing rows already in the table (6 patio roofing + 43 fence) are
--     RE-ASSERTED here from tool source so their cost/sell stay in sync with
--     the tools. Where the tool source now differs from the DB (e.g. fence
--     2100 cost, timber-lap removal), the tool value wins and notes flag it.
--   * Zero / "not on price list" sentinels are STILL inserted, flagged
--     'needs-real-price' in notes — the point of this table is no missing rate.
--   * DEFAULT_SELL_MARKUP (patio) = 1.35. Where a tool stores only a cost and
--     derives sell = cost * 1.35, default_cost_rate is set and the markup is
--     recorded in notes (the table has no sell column; see notes.md).
-- ============================================================================

BEGIN;

INSERT INTO scope_tool_defaults
  (scope_tool, category, item_key, item_description, unit,
   default_cost_rate, default_sqm_rate, default_price, material_code, source, notes)
VALUES

-- ════════════════════════════════════════════════════════════════════════
-- PATIO TOOL  (scope_tool = 'patio-tool')
-- ════════════════════════════════════════════════════════════════════════

-- ── Steel ($/LM) — STEEL_RATES (truss/beam/post stock) ──────────────────
-- 0.00 = "not on standard price list" sentinel → flagged needs-real-price.
('patio-tool','steel','shs-65x65x2','65x65x2 SHS steel','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','shs-75x75x2','75x75x2 SHS steel','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','shs-90x90x2','90x90x2 SHS steel','lm',35.50,NULL,35.50,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11'),
('patio-tool','steel','shs-100x100x2','100x100x2 SHS steel','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','shs-125x125x3','125x125x3 SHS steel','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','shs-150x150x3','150x150x3 SHS steel','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','rhs-50x25x1.6','50x25x1.6 RHS steel','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','rhs-65x35x2','65x35x2 RHS steel','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','rhs-75x35x2','75x35x2 RHS steel','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','rhs-76x38x1.6','76x38x1.6 RHS steel (patio tube)','lm',15.50,NULL,15.50,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; also used as truss steel $/m magic number'),
('patio-tool','steel','rhs-75x50x2','75x50x2 RHS steel','lm',26.00,NULL,26.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11'),
('patio-tool','steel','rhs-100x50x2','100x50x2 RHS steel','lm',30.00,NULL,30.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11'),
('patio-tool','steel','rhs-125x50x2','125x50x2 RHS steel','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','rhs-150x50x2','150x50x2 RHS steel','lm',39.05,NULL,39.05,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11'),
('patio-tool','steel','rhs-150x50x3','150x50x3 RHS steel','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','purlin-c150','C150 Purlin','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),
('patio-tool','steel','purlin-c200','C200 Purlin','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel, not on price list)'),

-- ── Steel fabrication magic numbers (gable truss formula) ────────────────
('patio-tool','steel','truss-fabrication','Gable truss fabrication labour (width x rate)','lm',93.00,NULL,93.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; magic number $93/m in truss formula (width x $93); sell = cost x 1.35'),
('patio-tool','steel','truss-steel-lm','Gable truss steel per linear metre','lm',15.50,NULL,15.50,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; magic number $15.50/m in truss formula ((2*rafter+rise+width) x $15.50); sell = cost x 1.35'),

-- ── Roofing — DEFAULT_RATES $/LM cost view ($0 = not on price list) ──────
('patio-tool','roofing','default-solarspan75','Solarspan 75mm (DEFAULT_RATES $/LM)','lm',110.00,NULL,110.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES cost view; see roofing solarspan75 for sqm rate'),
('patio-tool','roofing','default-solarspan100','Solarspan 100mm (DEFAULT_RATES $/LM)','lm',110.00,NULL,110.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES cost view (note 110 here vs 130 in ROOFING_TYPES)'),
('patio-tool','roofing','default-stratco-cgi75','Stratco CGI 75mm (DEFAULT_RATES $/LM)','lm',110.00,NULL,110.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES cost view'),
('patio-tool','roofing','default-stratco-cgi100','Stratco CGI 100mm (DEFAULT_RATES $/LM)','lm',110.00,NULL,110.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES cost view (note 110 here vs 130 in ROOFING_TYPES)'),
('patio-tool','roofing','default-spanplus330','Spanplus 330 (DEFAULT_RATES $/LM)','lm',12.04,NULL,12.04,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES cost view'),
('patio-tool','roofing','default-trimdek','Trimdek Colorbond (DEFAULT_RATES $/LM)','lm',22.00,NULL,22.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES cost view (note 22 here vs 15 in ROOFING_TYPES)'),
('patio-tool','roofing','default-corrugated','Corrugated Colorbond (DEFAULT_RATES $/LM)','lm',22.00,NULL,22.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES cost view (note 22 here vs 12.04 in ROOFING_TYPES)'),
('patio-tool','roofing','default-spandek','Spandek Colorbond (DEFAULT_RATES $/LM)','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel)'),
('patio-tool','roofing','default-ampelite-solasafe-5rib','Ampelite Solasafe 5-Rib','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel)'),
('patio-tool','roofing','default-ampelite-solasafe-corrugated','Ampelite Solasafe Corrugated','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel)'),
('patio-tool','roofing','default-laserlite-2000-5rib','Laserlite 2000 5-Rib','lm',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel)'),

-- ── Roofing — ROOFING_TYPES (costPerLm + sqmRate) — RE-ASSERTS 6 live rows + adds new ──
-- default_cost_rate = costPerLm, default_sqm_rate = sqmRate (the sell-per-sqm).
('patio-tool','roofing','solarspan75','SolarSpan 75mm insulated panel','lm',110.00,620.00,110.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate (existing live row)'),
('patio-tool','roofing','solarspan100','SolarSpan 100mm insulated panel','lm',130.00,680.00,130.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate (existing live row)'),
('patio-tool','roofing','solarspan150','SolarSpan 150mm insulated panel','lm',165.00,780.00,165.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate'),
('patio-tool','roofing','solarspan200','SolarSpan 200mm insulated panel','lm',200.00,880.00,200.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate'),
('patio-tool','roofing','stratco_cgi75','Stratco CGI 75mm (1m cover)','lm',110.00,620.00,110.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate'),
('patio-tool','roofing','stratco_cgi75_760','Stratco CGI 75mm (760mm cover)','lm',90.00,620.00,90.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate'),
('patio-tool','roofing','stratco_cgi100','Stratco CGI 100mm (1m cover)','lm',130.00,680.00,130.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate'),
('patio-tool','roofing','stratco_cgi100_760','Stratco CGI 100mm (760mm cover)','lm',105.00,680.00,105.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate'),
('patio-tool','roofing','trimdek','Trimdek non-insulated roofing','lm',15.00,480.00,15.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate (existing live row; sqmRate added)'),
('patio-tool','roofing','corrugated','Corrugated non-insulated roofing','lm',12.04,440.00,12.04,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate (existing live row; sqmRate added)'),
('patio-tool','roofing','spandek','Spandek non-insulated roofing','lm',14.50,480.00,14.50,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate (existing live row; sqmRate added)'),
('patio-tool','roofing','spanplus330','SpanPlus 330 non-insulated roofing','lm',12.04,460.00,12.04,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate (existing live row; sqmRate added)'),
('patio-tool','roofing','polycarb_trimdek','Polycarb Trimdek','lm',38.00,520.00,38.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate'),
('patio-tool','roofing','polycarb_corrugated','Polycarb Corrugated','lm',35.00,500.00,35.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; ROOFING_TYPES costPerLm/sqmRate'),

-- ── Flashings ($/LM) — DEFAULT_RATES + FLASHING_RATES ───────────────────
('patio-tool','flashing','ridge-cap','Ridge Cap flashing','lm',20.00,NULL,20.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; FLASHING_RATES.standard'),
('patio-tool','flashing','barge-flashing','Barge Flashing','lm',20.00,NULL,20.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; FLASHING_RATES.standard'),
('patio-tool','flashing','back-flashing','Back Flashing','lm',20.00,NULL,20.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; FLASHING_RATES.standard'),
('patio-tool','flashing','gutter-flashing','Gutter Flashing','lm',20.00,NULL,20.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; FLASHING_RATES.standard'),
('patio-tool','flashing','flashing-standard','Flashing standard rate (FLASHING_RATES.standard)','lm',20.00,NULL,20.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; FLASHING_RATES.standard global'),
('patio-tool','flashing','flashing-solarspan','Flashing for Solarspan/Stratco CGI (FLASHING_RATES.solarspan)','lm',25.00,NULL,25.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; FLASHING_RATES.solarspan global'),

-- ── Gutters & Drainage ($/LM) — DEFAULT_RATES + GUTTER_RATES ─────────────
('patio-tool','gutter','patio-gutter','Patio Gutter (GUTTER_RATES.standard)','lm',22.00,NULL,22.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; GUTTER_RATES.standard'),
('patio-tool','gutter','box-gutter','Box Gutter (GUTTER_RATES.box)','lm',30.00,NULL,30.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; GUTTER_RATES.box'),
('patio-tool','gutter','downpipe-95x45','Downpipe 95x45 ($40 per 1800mm stick)','lm',22.22,NULL,22.22,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; $40 per 1800mm stick = $22.22/m'),

-- ── Fixings ($/sqm) — THE RATE THAT BLOCKED MARNIN ──────────────────────
('patio-tool','fixings','fixings-per-sqm','Fixings (screws, anchors, silicone, foam) per sqm','sqm',0.00,0.00,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (THE blocker — DEFAULT_RATES Fixings ($/sqm)=0, auto-added per patio area, must be set before quoting)'),

-- ── Risers / brackets / infill (each + sqm) — DEFAULT_RATES + RISER_PRICES ──
('patio-tool','riser','riser-76x38','Riser 76x38 (ea)','ea',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; RISER_PRICES 76x38x1.6 = 0; needs-real-price (not on price list)'),
('patio-tool','riser','riser-75x50','Riser 75x50 (ea)','ea',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; RISER_PRICES 75x50x2 = 0; needs-real-price (not on price list)'),
('patio-tool','riser','riser-100x50','Riser 100x50 (ea)','ea',60.00,NULL,60.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; RISER_PRICES 100x50x2 = 60 (only riser on price list)'),
('patio-tool','riser','riser-bracket','Riser Bracket (ea)','ea',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel)'),
('patio-tool','riser','rafter-bracket','Rafter Bracket (ea)','ea',20.00,NULL,20.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11'),
('patio-tool','riser','tubing-bracket','Tubing Bracket (ea)','ea',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel)'),
('patio-tool','roofing','gable-infill-sqm','Gable Infill (per sqm)','sqm',0.00,0.00,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (0 sentinel)'),
('patio-tool','roofing','infill-twinwall-700','Infil Panel Twinwall 700mm','lm',38.08,NULL,38.08,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11'),
('patio-tool','roofing','infill-twinwall-1050','Infil Panel Twinwall 1050mm','lm',43.01,NULL,43.01,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11'),

-- ── Concrete ──────────────────────────────────────────────────────────
('patio-tool','concrete','kwikset-bag','Concrete Kwikset (per 20kg bag)','bag',10.00,NULL,10.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES Concrete Kwikset (bag)'),

-- ── Labour ($/day) — DEFAULT_RATES + LABOUR_RATES ───────────────────────
('patio-tool','labour','skilled-trade','Skilled Trade (per day)','day',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (per-job input, default 0)'),
('patio-tool','labour','labourer','Labourer (per day)','day',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (per-job input, default 0)'),
('patio-tool','labour','electrician','Electrician (per day)','day',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (per-job input, default 0)'),
('patio-tool','labour','roof-plumber-day','Roof Plumber day rate (box gutter install)','day',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; needs-real-price (LABOUR_RATES.roof_plumber_day = 0, REQUIRED before box-gutter+riser quote)'),

-- ── Job-level fixed costs (_jobCosts) ───────────────────────────────────
('patio-tool','services','delivery','Delivery (job fixed cost)','job',250.00,NULL,250.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; _jobCosts.delivery'),
('patio-tool','services','skip-bin','Skip bin (job fixed cost)','job',350.00,NULL,350.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; _jobCosts.skip_bin'),
('patio-tool','services','site-establishment','Site establishment (job fixed cost)','job',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; _jobCosts.site_establishment default 0; needs-real-price if used'),
('patio-tool','services','council-permit','Council permit (job fixed cost)','job',0.00,NULL,0.00,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; _jobCosts.council_permit default 0; needs-real-price if used'),

-- ── Markup constant (stored as reference; not a per-unit rate) ───────────
('patio-tool','markup','default-sell-markup','Default sell markup multiplier on cost','factor',1.35,NULL,1.35,NULL,'patio-tool','seed-from-tool-hardcoded 2026-06-11; DEFAULT_SELL_MARKUP = 1.35 (35%). sell = cost x 1.35. Stored as factor in default_cost_rate/default_price for reference.'),


-- ════════════════════════════════════════════════════════════════════════
-- FENCE DESIGNER  (scope_tool = 'fence-designer')
-- ════════════════════════════════════════════════════════════════════════
-- For *-sell / *-cost pairs (existing live rows), the long form is re-asserted
-- from business_rules.js DEFAULT_RATES (sell) + COST_PRICES (cost). Where the
-- code now differs from the live DB row, the code value wins and notes flag it.

-- ── Base fencing supply & install (sell + cost pairs) ───────────────────
('fence-designer','fencing_install','cb-1800-sell','Colorbond 1800mm S&I sell rate','m',120.00,NULL,120.00,'CB-1800-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.fencing_1800_per_m. Cost $97/m'),
('fence-designer','fencing_install','cb-1800-cost','Colorbond 1800mm S&I cost rate','m',97.00,NULL,97.00,'CB-1800-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.fencing_1800_per_m=97 (was 95 in DB; code updated)'),
('fence-designer','fencing_install','cb-2100-sell','Colorbond 2100mm S&I sell rate','m',128.00,NULL,128.00,'CB-2100-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.fencing_2100_per_m. Cost $109/m'),
('fence-designer','fencing_install','cb-2100-cost','Colorbond 2100mm S&I cost rate','m',109.00,NULL,109.00,'CB-2100-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.fencing_2100_per_m=109 (was 100 in DB; code updated)'),

-- ── Extensions & plinths ────────────────────────────────────────────────
('fence-designer','fencing_extensions','solid-fill-150-sell','Solid fill 150mm extension sell','m',110.00,NULL,110.00,'SOLID-FILL-150-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.extension_150_per_m. Cost $73/m'),
('fence-designer','fencing_extensions','solid-fill-150-cost','Solid fill 150mm extension cost','m',73.00,NULL,73.00,'SOLID-FILL-150-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.extension_150_per_m'),
('fence-designer','fencing_extensions','plinth-sell','Plinth supply & install sell','ea',80.00,NULL,80.00,'PLINTH-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.plinth_each. Cost $55/ea'),
('fence-designer','fencing_extensions','plinth-cost','Plinth supply & install cost','ea',55.00,NULL,55.00,'PLINTH-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.plinth_each ($45 material + $10 install)'),

-- ── Gates (sell + cost pairs) ───────────────────────────────────────────
('fence-designer','fencing_gates','ped-gate-standalone-sell','Pedestrian gate standalone sell','ea',1175.00,NULL,1175.00,'PED-GATE-STANDALONE-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.pedestrian_gate_standalone. Cost $835/ea'),
('fence-designer','fencing_gates','ped-gate-standalone-cost','Pedestrian gate standalone cost','ea',835.00,NULL,835.00,'PED-GATE-STANDALONE-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.pedestrian_gate'),
('fence-designer','fencing_gates','ped-gate-bundled-sell','Pedestrian gate bundled sell','ea',1100.00,NULL,1100.00,'PED-GATE-BUNDLED-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.pedestrian_gate. Cost $835/ea'),
('fence-designer','fencing_gates','ped-gate-bundled-cost','Pedestrian gate bundled cost','ea',835.00,NULL,835.00,'PED-GATE-BUNDLED-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.pedestrian_gate'),
('fence-designer','fencing_gates','dbl-swing-gate-sell','Double swing gate sell','ea',2400.00,NULL,2400.00,'DBL-SWING-GATE-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.double_gate. Cost $1830/ea'),
('fence-designer','fencing_gates','dbl-swing-gate-cost','Double swing gate cost','ea',1830.00,NULL,1830.00,'DBL-SWING-GATE-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.double_gate'),

-- ── Gate component costs (index.html COST_PRICES — granular kit/post/labour) ──
('fence-designer','fencing_gates','gate-kit-pedestrian','Pedestrian gate kit (material)','ea',320.00,NULL,320.00,'GATE-KIT-PEDESTRIAN','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.gateKitPedestrian (index.html granular cost model)'),
('fence-designer','fencing_gates','gate-kit-double','Double swing gate kit (material)','ea',500.00,NULL,500.00,'GATE-KIT-DOUBLE','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.gateKitDouble (index.html granular cost model)'),
('fence-designer','fencing_gates','gate-post-90x90','90x90 SHS gate post (material)','ea',85.00,NULL,85.00,'GATE-POST-90X90','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.gatePost90x90 (index.html granular cost model)'),
('fence-designer','fencing_gates','gate-labour-pedestrian','Pedestrian gate install labour','ea',250.00,NULL,250.00,'GATE-LABOUR-PEDESTRIAN','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.gateLabourPedestrian (index.html granular cost model)'),
('fence-designer','fencing_gates','gate-labour-double','Double/sliding gate install labour','ea',500.00,NULL,500.00,'GATE-LABOUR-DOUBLE','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.gateLabourDouble (index.html granular cost model)'),

-- ── Panel kit costs (index.html COST_PRICES — by height x post) ──────────
('fence-designer','fencing_install','panel-kit-1800-2400','1800H colorbond panel inc 2400 post (material)','ea',97.00,NULL,97.00,'PANEL-KIT-1800-2400','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.panelKit1800_2400 R&R $97'),
('fence-designer','fencing_install','panel-kit-1800-2700','1800H colorbond panel inc 2700 post (material)','ea',109.00,NULL,109.00,'PANEL-KIT-1800-2700','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.panelKit1800_2700 R&R $109'),
('fence-designer','fencing_install','panel-kit-1800-3000','1800H colorbond panel (3150 wide) inc 3000 post (material)','ea',124.00,NULL,124.00,'PANEL-KIT-1800-3000','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.panelKit1800_3000 R&R $124'),
('fence-designer','fencing_install','panel-kit-1500-2400','1500H panel inc 2400 post (material)','ea',85.00,NULL,85.00,'PANEL-KIT-1500-2400','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.panelKit1500_2400 (estimated)'),
('fence-designer','fencing_install','panel-kit-1200-2400','1200H panel inc 2400 post (material)','ea',75.00,NULL,75.00,'PANEL-KIT-1200-2400','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.panelKit1200_2400 (estimated)'),
('fence-designer','fencing_install','panel-kit-2100-2700','2100H colorbond panel inc 2700 post (material)','ea',109.00,NULL,109.00,'PANEL-KIT-2100-2700','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.panelKit2100_2700 R&R $109'),
('fence-designer','fencing_install','panel-kit-2100-3000','2100H colorbond panel inc 3000 post (material)','ea',130.00,NULL,130.00,'PANEL-KIT-2100-3000','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.panelKit2100_3000 (estimated)'),

-- ── Per-job sell input default ──────────────────────────────────────────
('fence-designer','fencing_install','price-per-metre-default','Default per-metre sell rate (job input)','m',NULL,NULL,125.00,'PRICE-PER-METRE-DEFAULT','fence-designer','seed-from-tool-hardcoded 2026-06-11; index.html pricePerMetre default = 125 (per-job override input)'),

-- ── Removal & disposal (sell + cost pairs) ──────────────────────────────
('fence-designer','fencing_removal','remove-hardie-sell','Remove Hardie/Super6 sell','sheet',30.00,NULL,30.00,'REMOVE-HARDIE-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.remove_hardie_per_sheet. Cost $12.50/sheet'),
('fence-designer','fencing_removal','remove-hardie-cost','Remove Hardie/Super6 cost','sheet',12.50,NULL,12.50,'REMOVE-HARDIE-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.remove_hardie_per_sheet=12.50 (was 15 in DB; code updated)'),
('fence-designer','fencing_removal','remove-timber-sell','Remove timber lap sell','m',40.00,NULL,40.00,'REMOVE-TIMBER-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.remove_timber_per_m=40 (was 45 in DB; code updated). Cost $20/m'),
('fence-designer','fencing_removal','remove-timber-cost','Remove timber lap cost','m',20.00,NULL,20.00,'REMOVE-TIMBER-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.remove_timber_per_m=20 (was 22.50 in DB; code updated)'),
('fence-designer','fencing_removal','remove-asbestos-sell','Remove asbestos sell','sheet',90.00,NULL,90.00,'REMOVE-ASBESTOS-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.remove_asbestos_per_sheet. Cost $60/sheet. Plus $300 fee'),
('fence-designer','fencing_removal','remove-asbestos-cost','Remove asbestos cost','sheet',60.00,NULL,60.00,'REMOVE-ASBESTOS-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.remove_asbestos_per_sheet=60 (business_rules); index.html removeAsbestos=65/m differs'),
('fence-designer','fencing_removal','remove-asbestos-fee','Asbestos removal flat fee','job',300.00,NULL,300.00,'REMOVE-ASBESTOS-FEE','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.asbestos_removal_fee + COST_PRICES.asbestos_removal_fee (both 300)'),
('fence-designer','fencing_removal','remove-colorbond-cost','Remove Colorbond fence cost','m',15.00,NULL,15.00,'REMOVE-COLORBOND-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; index.html COST_PRICES.removeColorbond (no business_rules equivalent)'),

-- ── Additional services (sell + cost pairs) ─────────────────────────────
('fence-designer','fencing_services','delivery-sell','Delivery sell','job',250.00,NULL,250.00,'DELIVERY-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.delivery. Cost $200 (business_rules) / $95 (index.html actual)'),
('fence-designer','fencing_services','delivery-cost','Delivery cost','job',200.00,NULL,200.00,'DELIVERY-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.delivery=200 (business_rules); index.html delivery=95 differs — actual R&R cost'),
('fence-designer','fencing_services','veg-clear-sell','Vegetation/site clear sell','job',150.00,NULL,150.00,'VEG-CLEAR-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.vegetation_clear. Cost $100'),
('fence-designer','fencing_services','veg-clear-cost','Vegetation/site clear cost','job',100.00,NULL,100.00,'VEG-CLEAR-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.vegetation_clear=100 (business_rules); index.html vegClear=150 differs'),
('fence-designer','fencing_services','addl-labour-sell','Additional labour sell','hr',85.00,NULL,85.00,'ADDL-LABOUR-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.additional_labour_per_hr. Cost $45/hr'),
('fence-designer','fencing_services','addl-labour-cost','Additional labour cost','hr',45.00,NULL,45.00,'ADDL-LABOUR-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.additional_labour_per_hr'),

-- ── Materials (index.html COST_PRICES — consumables) ────────────────────
('fence-designer','fencing_concrete','concrete-bag','Concrete (20kg bag)','bag',9.50,NULL,9.50,'CONCRETE-BAG','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.concrete (index.html). 2 bags per post'),
('fence-designer','fencing_concrete','tek-screw-box','Tek screw box','box',18.00,NULL,18.00,'TEK-SCREW-BOX','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.tekScrewBox (index.html)'),
('fence-designer','fencing_concrete','patio-tube-76x38','Patio tube 76x38 RHS 3000mm (material)','ea',45.00,NULL,45.00,'PATIO-TUBE-76X38','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.patioTube (index.html). Cost $45, sell $75'),

-- ── Concrete (existing live rows — kwikset bag counts + rock) ────────────
('fence-designer','fencing_concrete','kwikset-std','Kwikset concrete per post (600mm hole)','bag',2.00,NULL,2.00,'KWIKSET-STD','fence-designer','seed-from-tool-hardcoded 2026-06-11; 2 bags/post standard, 1.1 waste, round up (existing live row)'),
('fence-designer','fencing_concrete','kwikset-deep','Kwikset concrete per post (900mm hole)','bag',3.00,NULL,3.00,'KWIKSET-DEEP','fence-designer','seed-from-tool-hardcoded 2026-06-11; 3 bags/post deep hole (existing live row)'),
('fence-designer','fencing_concrete','rock-excavation','Rock/limestone excavation surcharge','hole',45.00,NULL,45.00,'ROCK-EXCAVATION','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.rock_per_hole=45 sell / COST_PRICES.rock_per_hole=30 cost. Per hole (existing live row)'),

-- ── Labour ──────────────────────────────────────────────────────────────
('fence-designer','fencing_labour','base-labour','Base labour rate for fencing install','m',35.00,NULL,35.00,'BASE-LABOUR','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.labour_base_per_m / labourPerMetre = 35. fence_length x $35/m (existing live row)'),
('fence-designer','fencing_labour','plinth-install','Plinth install labour (each)','ea',10.00,NULL,10.00,'PLINTH-INSTALL','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.plinth_install_each / plinthInstall = 10'),

-- ── Ground finish (sell + cost pairs) — NOTE business_rules vs index.html differ ──
('fence-designer','fencing_ground','mulch-sell','Mulch ground finish sell','m2',8.00,NULL,8.00,'MULCH-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.mulch_per_m2. Cost $5/m2 (business_rules). index.html groundMulch=12/LM differs (per-LM model)'),
('fence-designer','fencing_ground','mulch-cost','Mulch ground finish cost','m2',5.00,NULL,5.00,'MULCH-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.mulch_per_m2 (business_rules)'),
('fence-designer','fencing_ground','white-stones-sell','White stones 20mm sell','m2',15.00,NULL,15.00,'WHITE-STONES-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.white_stones_per_m2. Cost $10/m2 (business_rules). index.html groundStones=18/LM differs'),
('fence-designer','fencing_ground','white-stones-cost','White stones 20mm cost','m2',10.00,NULL,10.00,'WHITE-STONES-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.white_stones_per_m2 (business_rules)'),
('fence-designer','fencing_ground','turf-prep-sell','Turf prep sell','m2',12.00,NULL,12.00,'TURF-PREP-SELL','fence-designer','seed-from-tool-hardcoded 2026-06-11; DEFAULT_RATES.turf_prep_per_m2. Cost $7/m2 (business_rules). index.html groundTurf=22/LM differs'),
('fence-designer','fencing_ground','turf-prep-cost','Turf prep cost','m2',7.00,NULL,7.00,'TURF-PREP-COST','fence-designer','seed-from-tool-hardcoded 2026-06-11; COST_PRICES.turf_prep_per_m2 (business_rules)'),

-- ── Surcharges (percentage multipliers) ─────────────────────────────────
('fence-designer','fencing_surcharge','urgent-1-2wk','Urgent surcharge (1-2 weeks)','pct',10.00,NULL,10.00,'URGENT-1-2WK','fence-designer','seed-from-tool-hardcoded 2026-06-11; SURCHARGES.urgency.urgent=0.10. Applied to subtotal before GST (existing live row)'),
('fence-designer','fencing_surcharge','rush-1wk','Rush surcharge (<1 week)','pct',20.00,NULL,20.00,'RUSH-1WK','fence-designer','seed-from-tool-hardcoded 2026-06-11; SURCHARGES.urgency.rush=0.20. Applied to subtotal before GST (existing live row)'),
('fence-designer','fencing_surcharge','emergency-3day','Emergency surcharge (<3 days)','pct',30.00,NULL,30.00,'EMERGENCY-3DAY','fence-designer','seed-from-tool-hardcoded 2026-06-11; SURCHARGES.urgency.emergency=0.30. Applied to subtotal before GST (existing live row)'),
('fence-designer','fencing_surcharge','access-moderate','Moderate access difficulty','pct',10.00,NULL,10.00,'ACCESS-MODERATE','fence-designer','seed-from-tool-hardcoded 2026-06-11; SURCHARGES.access.moderate=0.10. Applied to labour component only (existing live row)'),
('fence-designer','fencing_surcharge','access-difficult','Difficult access','pct',25.00,NULL,25.00,'ACCESS-DIFFICULT','fence-designer','seed-from-tool-hardcoded 2026-06-11; SURCHARGES.access.difficult=0.25. Applied to labour component only (existing live row)'),

-- ── Panel widths by supplier ────────────────────────────────────────────
('fence-designer','fencing_panels','metroll-panel-width','Metroll panel width','mm',2365.00,NULL,2365.00,'METROLL-PANEL-WIDTH','fence-designer','seed-from-tool-hardcoded 2026-06-11; SUPPLIERS.metroll.panel_width. Default supplier, never mix (existing live row)'),
('fence-designer','fencing_panels','rr-panel-width','R&R Fencing panel width','mm',2380.00,NULL,2380.00,'RR-PANEL-WIDTH','fence-designer','seed-from-tool-hardcoded 2026-06-11; SUPPLIERS.rnr.panel_width. Alternative supplier (existing live row)'),
('fence-designer','fencing_panels','metroll-long-panel-width','Metroll long panel width (max one per run)','mm',3150.00,NULL,3150.00,'METROLL-LONG-PANEL-WIDTH','fence-designer','seed-from-tool-hardcoded 2026-06-11; SUPPLIERS.metroll.long_panel_width. Max ONE per run'),
('fence-designer','fencing_panels','rr-long-panel-width','R&R long panel width (max one per run)','mm',3150.00,NULL,3150.00,'RR-LONG-PANEL-WIDTH','fence-designer','seed-from-tool-hardcoded 2026-06-11; SUPPLIERS.rnr.long_panel_width. Max ONE per run')

ON CONFLICT (org_id, scope_tool, category, item_key) DO UPDATE SET
  item_description  = EXCLUDED.item_description,
  unit              = EXCLUDED.unit,
  default_cost_rate = EXCLUDED.default_cost_rate,
  default_sqm_rate  = EXCLUDED.default_sqm_rate,
  default_price     = EXCLUDED.default_price,
  material_code     = COALESCE(EXCLUDED.material_code, scope_tool_defaults.material_code),
  notes             = EXCLUDED.notes,
  last_updated_at   = now();

COMMIT;
