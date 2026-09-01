# Project instructions

## Installed skill: UI/UX Pro Max (v2.13.0)

Source: https://github.com/nextlevelbuilder/ui-ux-pro-max-skill (MIT, NextLevelBuilder).
Installed at `.claude/skills/ui-ux-pro-max/`.

**This environment cannot run Python**, so the upstream `search.py` CLI is not
available. The data it searches is installed and is queried with `grep` instead —
same knowledge, different access path. Never claim to have "run the search tool".

### What is installed

| Path | Contents |
|---|---|
| `SKILL.md` | Upstream skill definition — the priority table and workflow |
| `references/quick-reference.md` | All 119 UX guidelines with rationale |
| `references/pro-rules.md` | App/native polish rules + pre-delivery checklist |
| `data/ux-guidelines.csv` | 119 rules: Category, Issue, Platform, Do, Don't, Severity |
| `data/styles.csv` | 79 UI styles with colors, effects, best-for, anti-patterns |
| `data/colors.csv` | 192 palettes as full token sets (primary → ring) |
| `data/typography.csv` | 74 font pairings with Google Fonts imports |
| `data/products.csv` | Product-type patterns (SaaS, dashboard, e-commerce…) |
| `data/ui-reasoning.csv` | Reasoning profiles that drive design-system selection |
| `data/landing.csv` · `charts.csv` · `icons.csv` · `motion.csv` | Page structure, 25 chart types, icon sets, 17 GSAP presets |
| `data/app-interface.csv` · `react-performance.csv` | Native app guidance, React perf patterns |
| `data/stacks/` | `html-tailwind`, `react`, `threejs` (other 19 stacks not installed — fetch from the repo if needed) |

### How to use it

Query with `grep` scoped to the relevant file, then read the matching rows:

```
grep(pattern: "contrast|focus", path: ".claude/skills/ui-ux-pro-max/data/ux-guidelines.csv")
grep(pattern: "dashboard", path: ".claude/skills/ui-ux-pro-max/data/colors.csv")
```

Apply the upstream workflow: identify product type, audience, style keywords and
stack first; consult `products.csv` + `styles.csv` + `colors.csv` + `typography.csv`
for a whole-product direction, or a single file for a targeted concern.

Follow the upstream priority order when deciding what to fix first:
**1** Accessibility (4.5:1 contrast, alt text, keyboard nav, aria-labels) ·
**2** Touch & interaction (44×44px targets, 8px spacing, loading feedback) ·
**3** Performance (lazy loading, CLS < 0.1) · **4** Style selection ·
**5** Layout & responsive (mobile-first, no horizontal scroll) ·
**6** Typography & colour (16px base, 1.5 line-height, semantic tokens) ·
**7** Animation (meaningful, reduced-motion honoured) · **8** Forms & feedback
(visible labels, errors near the field) · **9** Navigation · **10** Charts.

Read `references/pro-rules.md` and run its pre-delivery checklist before
delivering app/mobile UI.

### Precedence

1. **The attached design system wins on visual style.** Colours, type, spacing
   and components come from it — do not substitute palettes or font pairings
   from `colors.csv` / `typography.csv` when a design system is attached.
2. **UI/UX Pro Max governs rules and quality**: accessibility, touch targets,
   states, motion, forms, navigation, performance. These are additive and never
   conflict with a design system.
3. Use its palettes and font pairings only when no design system is attached.

### Honesty rule

If a grep returns nothing relevant, say so and label the advice as a general
default rather than presenting it as a database match. Do not fabricate a
citation to a row that does not exist.
